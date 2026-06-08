import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { buildUrl, CourtApiError } from "./client.js";

// We test get/post by calling them with a mocked global fetch.
// Node:test mock.method patches in-place and restores on afterEach.

let fetchCalls: { url: string; init: RequestInit }[] = [];

function mockFetch(status: number, body: unknown) {
  fetchCalls = [];
  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return {
      ok: status < 400,
      status,
      json: async () => body,
    } as Response;
  };
}

beforeEach(() => {
  process.env.COURTAPI_APP_ID  = "test_id";
  process.env.COURTAPI_APP_KEY = "test_key";
});

afterEach(() => {
  delete process.env.COURTAPI_APP_ID;
  delete process.env.COURTAPI_APP_KEY;
});

// ── buildUrl ──────────────────────────────────────────────────────────────────

describe("buildUrl", () => {
  it("appends scalar params", () => {
    const url = buildUrl("/cases/pacer/search/party_title", { search_terms: "Sbarro", page_size: 50 });
    assert.ok(url.includes("search_terms=Sbarro"));
    assert.ok(url.includes("page_size=50"));
  });

  it("repeats array params", () => {
    const url = buildUrl("/cases/pacer/search-filings", { chapter: [7, 11] });
    assert.ok(url.includes("chapter=7"));
    assert.ok(url.includes("chapter=11"));
  });

  it("omits undefined params", () => {
    const url = buildUrl("/courts/pacer", { type: undefined });
    assert.ok(!url.includes("type"));
  });

  it("preserves literal colon in case number path segment (RFC 3986 §3.3)", () => {
    // KB always shows /cases/pacer/nysbke/1:14-bk-10557/... with literal colon.
    // encodeURIComponent would produce 1%3A14-bk-10557 which may not route correctly.
    const url = buildUrl("/cases/pacer/nysbke/1:14-bk-10557/dockets", { page_size: 50 });
    assert.ok(url.includes("nysbke/1:14-bk-10557/dockets"), `expected literal colon, got: ${url}`);
    assert.ok(!url.includes("%3A"), `colon was encoded unexpectedly: ${url}`);
  });
});

// ── get ───────────────────────────────────────────────────────────────────────

describe("get", () => {
  it("sends correct Authorization header", async () => {
    mockFetch(200, { courts: [] });
    const { get } = await import("./client.js");
    await get("/courts/pacer");
    const auth = (fetchCalls[0].init.headers as Record<string, string>)["Authorization"];
    assert.equal(auth, "Basic " + Buffer.from("test_id:test_key").toString("base64"));
  });

  it("sends x-courtapi-version: 1.0.16", async () => {
    mockFetch(200, {});
    const { get } = await import("./client.js");
    await get("/courts/pacer");
    const ver = (fetchCalls[0].init.headers as Record<string, string>)["x-courtapi-version"];
    assert.equal(ver, "1.0.16");
  });

  it("returns parsed JSON", async () => {
    mockFetch(200, { courts: [{ code: "nysbke" }] });
    const { get } = await import("./client.js");
    const result = await get("/courts/pacer") as { courts: unknown[] };
    assert.equal(result.courts.length, 1);
  });

  it("throws CourtApiError on 404", async () => {
    mockFetch(404, { error: "not found" });
    const { get } = await import("./client.js");
    await assert.rejects(() => get("/cases/pacer/nysbke/bad"), CourtApiError);
  });

  it("throws when credentials are missing", async () => {
    delete process.env.COURTAPI_APP_ID;
    const { get } = await import("./client.js");
    await assert.rejects(() => get("/courts/pacer"), /COURTAPI_APP_ID/);
  });
});

// ── post ──────────────────────────────────────────────────────────────────────

describe("post", () => {
  it("uses POST method", async () => {
    mockFetch(200, {});
    const { post } = await import("./client.js");
    await post("/pacer/credentials");
    assert.equal(fetchCalls[0].init.method, "POST");
  });

  it("sends form-encoded body", async () => {
    mockFetch(200, {});
    const { post } = await import("./client.js");
    await post("/pacer/credentials", { pacer_user: "u", pacer_pass: "p" });
    const body = String(fetchCalls[0].init.body);
    assert.ok(body.includes("pacer_user=u"));
    assert.ok(body.includes("pacer_pass=p"));
  });
});
