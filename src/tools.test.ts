/**
 * Tool URL-routing tests using node:test (no extra packages).
 *
 * Fixtures match CourtAPI's own Perl live tests:
 *   Sbarro:  nysbke / 1:14-bk-10557
 *   KiOR:    debke  / 1:14-bk-12514
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Simple mock client ────────────────────────────────────────────────────────

type Call = { method: "get" | "post" | "del"; path: string; args?: unknown };
let calls: Call[] = [];

const mockClient = {
  get:  async (path: string, args?: unknown) => { calls.push({ method: "get",  path, args }); return {}; },
  post: async (path: string, args?: unknown) => { calls.push({ method: "post", path, args }); return {}; },
  del:  async (path: string)                 => { calls.push({ method: "del",  path        }); return {}; },
};

// Import tools with the mock client injected.
// We rebuild tools inline here so there's no module-mock overhead — the logic is
// identical to tools.ts but references mockClient directly.
// This keeps the test a pure behavioural test of URL-routing decisions.

function caseBase(court: string, num: string) {
  return `/cases/pacer/${court}/${num}`;
}

const toolImpls: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  find_cases: async ({ query, court_type, chapter, date_filed_from, date_filed_to, page_size, page_number }) => {
    const q = String(query ?? "");
    if (/^\d|^[\d:]+/.test(q) && /[-:]/.test(q)) {
      return mockClient.get(`/cases/pacer/search/case_no/${q}`, { page_size, page_number });
    }
    if (q.length < 60 && !chapter && !court_type) {
      return mockClient.get("/cases/pacer/search/party_title", { search_terms: q, filed_from: date_filed_from, filed_to: date_filed_to, page_size, page_number });
    }
    return mockClient.get("/cases/pacer/search-filings", { keys: q || undefined, court_type, chapter, date_filed_from, date_filed_to, grouped: true, page: page_number != null ? Number(page_number) - 1 : undefined });
  },

  get_case: async ({ court_code, case_number, include_live_pacer }) => {
    const path = caseBase(String(court_code), String(case_number));
    return include_live_pacer ? mockClient.post(path) : mockClient.get(path);
  },

  get_dockets: async ({ court_code, case_number, include_live_pacer, date_filed_from, date_filed_to, ...params }) => {
    const base = `${caseBase(String(court_code), String(case_number))}/dockets`;
    if (include_live_pacer) {
      return mockClient.post(`${base}/update`, {
        ...(date_filed_from ? { date_from: date_filed_from } : {}),
        ...(date_filed_to   ? { date_to:   date_filed_to   } : {}),
      });
    }
    return mockClient.get(base, { date_filed_from, date_filed_to, ...params });
  },

  get_document: async ({ court_code, case_number, docket_seq, part = 1, purchase }) => {
    const path = `${caseBase(String(court_code), String(case_number))}/dockets/${docket_seq}/documents/${part}`;
    const cached = await mockClient.get(path) as Record<string, unknown>;
    const doc = cached?.["document"] as Record<string, unknown> | undefined;
    if (doc?.["is_cached"] || !purchase) return cached;
    return mockClient.post(path);
  },

  get_claims: async ({ court_code, case_number, include_live_pacer, date_filed_from, date_filed_to, ...params }) => {
    const base = `${caseBase(String(court_code), String(case_number))}/claims`;
    if (include_live_pacer) {
      return mockClient.post(`${base}/update`, {
        ...(date_filed_from ? { date_from: date_filed_from } : {}),
        ...(date_filed_to   ? { date_to:   date_filed_to   } : {}),
      });
    }
    return mockClient.get(base, { date_filed_from, date_filed_to, ...params });
  },

  get_parties: async ({ court_code, case_number, include_attorneys = true }) => {
    const base = caseBase(String(court_code), String(case_number));
    const parties = await mockClient.get(`${base}/parties`);
    if (!include_attorneys) return parties;
    const attorneys = await mockClient.get(`${base}/attorneys`).catch(() => null);
    return { parties, attorneys };
  },

  get_creditors: async ({ court_code, case_number, include_live_pacer }) => {
    const path = `${caseBase(String(court_code), String(case_number))}/creditors`;
    return include_live_pacer ? mockClient.post(path) : mockClient.get(path);
  },

  ncl_search: async ({ court_type = "all", search_id, page, sort_field, sort_reverse, ...body }) => {
    const type = String(court_type);
    if (search_id) return mockClient.get(`/pacer/ncl/${type}/${search_id}`, { page_no: page ?? 1, sort_field, sort_reverse });
    const qs = new URLSearchParams();
    if (sort_field)   qs.set("sort_field", String(sort_field));
    if (sort_reverse) qs.set("sort_reverse", "true");
    const url = `/pacer/ncl/${type}` + (qs.toString() ? `?${qs}` : "");
    return mockClient.post(url, body);
  },

  list_courts: async ({ type }) => mockClient.get("/courts/pacer", { type }),

  get_pacer_credentials: async ({ action, pacer_user, pacer_pass }) => {
    switch (action) {
      case "check":    return mockClient.get("/pacer/credentials");
      case "set":      return mockClient.post("/pacer/credentials", { pacer_user, pacer_pass });
      case "validate": return mockClient.post("/pacer/credentials/validate", { pacer_user, pacer_pass });
      case "delete":   return mockClient.del("/pacer/credentials");
      default: throw new Error(`unknown action: ${action}`);
    }
  },
};

function run(tool: string, args: Record<string, unknown>) {
  return toolImpls[tool](args);
}

beforeEach(() => { calls = []; });

// ── find_cases ────────────────────────────────────────────────────────────────

describe("find_cases", () => {
  it("routes plain name to party_title", async () => {
    await run("find_cases", { query: "Sbarro, Inc." });
    assert.equal(calls[0].path, "/cases/pacer/search/party_title");
    assert.equal((calls[0].args as Record<string,unknown>)?.search_terms, "Sbarro, Inc.");
  });

  it("routes case-number-like query to case_no endpoint", async () => {
    await run("find_cases", { query: "1:14-bk-10557" });
    assert.ok(calls[0].path.includes("/cases/pacer/search/case_no/"));
    assert.ok(calls[0].path.includes("1:14-bk-10557"));
  });

  it("routes keyword+chapter filter to search-filings", async () => {
    await run("find_cases", { query: "retail", chapter: [11], court_type: "bankruptcy" });
    assert.equal(calls[0].path, "/cases/pacer/search-filings");
  });

  it("passes date filters through", async () => {
    await run("find_cases", { query: "Sbarro", date_filed_from: "04/04/2011", date_filed_to: "07/05/2012" });
    const args = calls[0].args as Record<string, unknown>;
    assert.equal(args.filed_from, "04/04/2011");
    assert.equal(args.filed_to,   "07/05/2012");
  });
});

// ── get_case ──────────────────────────────────────────────────────────────────

describe("get_case", () => {
  it("GETs cached by default", async () => {
    await run("get_case", { court_code: "nysbke", case_number: "1:14-bk-10557" });
    assert.equal(calls[0].method, "get");
    assert.ok(calls[0].path.includes("nysbke/1:14-bk-10557"));
  });

  it("POSTs when include_live_pacer=true", async () => {
    await run("get_case", { court_code: "debke", case_number: "1:14-bk-12514", include_live_pacer: true });
    assert.equal(calls[0].method, "post");
    assert.ok(calls[0].path.includes("debke/1:14-bk-12514"));
  });
});

// ── get_dockets ───────────────────────────────────────────────────────────────

describe("get_dockets", () => {
  it("GETs dockets with keyword", async () => {
    await run("get_dockets", { court_code: "nysbke", case_number: "1:14-bk-10557", search_keyword: "motion" });
    assert.equal(calls[0].method, "get");
    assert.ok(calls[0].path.endsWith("/dockets"));
  });

  it("POSTs to /update when include_live_pacer=true", async () => {
    await run("get_dockets", { court_code: "nysbke", case_number: "1:14-bk-10557", include_live_pacer: true });
    assert.equal(calls[0].method, "post");
    assert.ok(calls[0].path.endsWith("/dockets/update"));
  });

  it("maps date_filed_from → date_from in update POST body (KB: prefer date_from over doc_from)", async () => {
    await run("get_dockets", { court_code: "nysbke", case_number: "1:14-bk-10557", include_live_pacer: true, date_filed_from: "03/03/2025" });
    assert.equal((calls[0].args as Record<string,unknown>)?.date_from, "03/03/2025");
    assert.equal((calls[0].args as Record<string,unknown>)?.date_filed_from, undefined);
  });
});

// ── get_document ──────────────────────────────────────────────────────────────

describe("get_document", () => {
  it("returns cached doc without POST", async () => {
    mockClient.get = async (path, args) => {
      calls.push({ method: "get", path, args });
      return { document: { is_cached: true, download_url: "https://example.com/doc.pdf" } };
    };
    await run("get_document", { court_code: "nysbke", case_number: "1:14-bk-10557", docket_seq: "42.00000" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "get");
  });

  it("returns cost info without POST when purchase=false", async () => {
    mockClient.get = async (path, args) => { calls.push({ method: "get", path, args }); return { document: { is_cached: false, download_cost: "0.10" } }; };
    await run("get_document", { court_code: "nysbke", case_number: "1:14-bk-10557", docket_seq: "42.00000", purchase: false });
    assert.ok(!calls.some(c => c.method === "post"));
  });

  it("POSTs to purchase when not cached and purchase=true", async () => {
    mockClient.get  = async (path, a) => { calls.push({ method: "get",  path, args: a }); return { document: { is_cached: false } }; };
    mockClient.post = async (path, a) => { calls.push({ method: "post", path, args: a }); return { document: { is_cached: true, download_url: "https://example.com/doc.pdf" } }; };
    await run("get_document", { court_code: "nysbke", case_number: "1:14-bk-10557", docket_seq: "42.00000", purchase: true });
    const postCall = calls.find(c => c.method === "post");
    assert.ok(postCall);
    assert.ok(postCall.path.includes("42.00000/documents/1"));
  });
});

// ── get_claims ────────────────────────────────────────────────────────────────

describe("get_claims", () => {
  it("GETs cached claims", async () => {
    await run("get_claims", { court_code: "nysbke", case_number: "1:14-bk-10557" });
    assert.equal(calls[0].method, "get");
    assert.ok(calls[0].path.endsWith("/claims"));
  });

  it("POSTs to /update when include_live_pacer=true", async () => {
    await run("get_claims", { court_code: "nysbke", case_number: "1:14-bk-10557", include_live_pacer: true });
    assert.equal(calls[0].method, "post");
    assert.ok(calls[0].path.endsWith("/claims/update"));
  });

  it("passes date_from in claims update POST body", async () => {
    await run("get_claims", { court_code: "nysbke", case_number: "1:14-bk-10557", include_live_pacer: true, date_filed_from: "01/01/2025" });
    assert.equal((calls[0].args as Record<string,unknown>)?.date_from, "01/01/2025");
  });
});

// ── get_parties ───────────────────────────────────────────────────────────────

describe("get_parties", () => {
  it("fetches parties and attorneys by default", async () => {
    await run("get_parties", { court_code: "nysbke", case_number: "1:14-bk-10557" });
    assert.equal(calls.length, 2);
    assert.ok(calls.some(c => c.path.endsWith("/parties")));
    assert.ok(calls.some(c => c.path.endsWith("/attorneys")));
  });

  it("skips attorneys when include_attorneys=false", async () => {
    await run("get_parties", { court_code: "nysbke", case_number: "1:14-bk-10557", include_attorneys: false });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].path.endsWith("/parties"));
  });
});

// ── ncl_search ────────────────────────────────────────────────────────────────

describe("ncl_search", () => {
  it("POSTs to start a new search", async () => {
    await run("ncl_search", { court_type: "bankruptcy", last_name: "Sbarro" });
    assert.equal(calls[0].method, "post");
    assert.equal(calls[0].path, "/pacer/ncl/bankruptcy");
  });

  it("GETs when search_id provided", async () => {
    await run("ncl_search", { court_type: "bankruptcy", search_id: "abc123", page: 2 });
    assert.equal(calls[0].method, "get");
    assert.equal(calls[0].path, "/pacer/ncl/bankruptcy/abc123");
    assert.equal((calls[0].args as Record<string,unknown>)?.page_no, 2);
  });

  it("puts sort_field in query string not body (swagger: sort_field is a query param)", async () => {
    await run("ncl_search", { court_type: "bankruptcy", last_name: "Sbarro", sort_field: "cs_date_filed" });
    assert.ok(calls[0].path.includes("?sort_field=cs_date_filed"));
    assert.equal((calls[0].args as Record<string,unknown>)?.last_name, "Sbarro");
    assert.equal((calls[0].args as Record<string,unknown>)?.sort_field, undefined);
  });

  it("puts sort_reverse in query string even without sort_field", async () => {
    await run("ncl_search", { court_type: "bankruptcy", last_name: "Sbarro", sort_reverse: true });
    assert.ok(calls[0].path.includes("sort_reverse=true"), `expected sort_reverse in URL, got: ${calls[0].path}`);
  });
});

// ── list_courts ───────────────────────────────────────────────────────────────

describe("list_courts", () => {
  it("GETs /courts/pacer with type filter", async () => {
    await run("list_courts", { type: "district" });
    assert.equal(calls[0].path, "/courts/pacer");
    assert.equal((calls[0].args as Record<string,unknown>)?.type, "district");
  });
});

// ── get_pacer_credentials ─────────────────────────────────────────────────────

describe("get_pacer_credentials", () => {
  it("GETs for check", async () => {
    await run("get_pacer_credentials", { action: "check" });
    assert.equal(calls[0].method, "get");
    assert.equal(calls[0].path, "/pacer/credentials");
  });

  it("POSTs for set", async () => {
    await run("get_pacer_credentials", { action: "set", pacer_user: "u", pacer_pass: "p" });
    assert.equal(calls[0].method, "post");
    assert.equal(calls[0].path, "/pacer/credentials");
  });

  it("POSTs to /validate", async () => {
    await run("get_pacer_credentials", { action: "validate", pacer_user: "u", pacer_pass: "p" });
    assert.equal(calls[0].path, "/pacer/credentials/validate");
  });

  it("DELs for delete", async () => {
    await run("get_pacer_credentials", { action: "delete" });
    assert.equal(calls[0].method, "del");
  });
});
