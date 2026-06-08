/**
 * Tool definitions for the CourtAPI MCP server.
 *
 * Each tool is a ZodRawShape (inputSchema) + an async handler.
 * Handlers are pure passthroughs: build URL → fetch → return response.
 * No transformation, no business logic.
 */

import { z } from "zod";
import { get, post, del, CourtApiError } from "./client.js";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

// ─── Shared param descriptions ────────────────────────────────────────────────

const court_code = z.string().describe(
  "Court code, e.g. 'nysbke' (NY Southern Bankruptcy), 'debke' (Delaware Bankruptcy), " +
  "'ilnbke' (IL Northern Bankruptcy). Use list_courts to find the right code."
);

const case_number = z.string().describe(
  "Long-form case number, e.g. '1:14-bk-10557'. Always use the long form — " +
  "PACER short forms like '14-10557' will not match. Use find_cases if unsure."
);

// ─── Tools ────────────────────────────────────────────────────────────────────

export const tools: ToolDef[] = [

  // ── 1. find_cases ───────────────────────────────────────────────────────────
  // Covers: GET /cases/pacer/search/party_title
  //         GET /cases/pacer/search/case_no/{n}
  //         GET /cases/pacer/search-filings
  {
    name: "find_cases",
    description:
      "Discover federal court cases you don't have the court+number for yet. " +
      "Pass a party/company name, a (partial) case number, or free-text keywords. " +
      "Returns court_code + case_number needed by all other tools. No PACER cost. " +
      "Note: keyword search (search-filings) charges 1 CourtAPI API call per 25 results returned. " +
      "Examples: query='Sbarro', query='1:14-bk', query='retail chapter 11 2026'.",
    inputSchema: {
      query: z.string().describe(
        "Party name, case number (full or partial), or free-text keywords. " +
        "The tool picks the best search endpoint automatically."
      ),
      court_type: z.enum(["bankruptcy", "civil", "criminal", "appellate", "national"])
        .optional()
        .describe("Narrow to a court type. 'national' searches all courts."),
      chapter: z.array(z.number()).optional()
        .describe("Bankruptcy chapters, e.g. [11] or [7, 13]"),
      date_filed_from: z.string().optional().describe("MM/DD/YYYY"),
      date_filed_to:   z.string().optional().describe("MM/DD/YYYY"),
      page_size: z.number().int().optional(),
      page_number: z.number().int().optional(),
    },
    handler: async ({ query, court_type, chapter, date_filed_from, date_filed_to, page_size, page_number }) => {
      const q = String(query ?? "");

      // Looks like a case number → case_no search
      if (/^\d|^[\d:]+/.test(q) && /[-:]/.test(q)) {
        return get(`/cases/pacer/search/case_no/${q}`, { page_size, page_number });
      }

      // Short query with no special chars → party/title search (faster, free)
      if (q.length < 60 && !/\s{2,}/.test(q) && !chapter && !court_type) {
        return get("/cases/pacer/search/party_title", {
          search_terms: q,
          filed_from: date_filed_from,
          filed_to:   date_filed_to,
          page_size,
          page_number,
        });
      }

      // Keyword/filter search
      return get("/cases/pacer/search-filings", {
        keys:            q || undefined,
        court_type,
        chapter,
        date_filed_from,
        date_filed_to,
        grouped:         true,
        page_size,
        page:            page_number != null ? Number(page_number) - 1 : undefined, // search-filings is 0-based
      });
    },
  },

  // ── 2. get_case ─────────────────────────────────────────────────────────────
  // Covers: GET  /cases/pacer/{court}/{case}
  //         POST /cases/pacer/{court}/{case}  (live PACER refresh)
  {
    name: "get_case",
    description:
      "Get all metadata for a known case: title, chapter, judge, key dates " +
      "(filed/closed/discharged), assets, liabilities, and links to sub-resources " +
      "(dockets, claims, parties, etc.) with their last-modified timestamps. " +
      "Always call this first after finding a case. The response includes a 'menu' object " +
      "where each entry has a 'modified' timestamp (null = never purchased) showing " +
      "what sub-resources are available. Free unless include_live_pacer=true.",
    inputSchema: {
      court_code,
      case_number,
      include_live_pacer: z.boolean().optional().describe(
        "true = fetch fresh data from PACER (costs PACER credits). Default false = free cached."
      ),
    },
    handler: async ({ court_code, case_number, include_live_pacer }) => {
      const path = `/cases/pacer/${court_code}/${String(case_number)}`;
      return include_live_pacer ? post(path) : get(path);
    },
  },

  // ── 3. get_dockets ──────────────────────────────────────────────────────────
  // Covers: GET  /cases/pacer/{court}/{case}/dockets
  //         POST /cases/pacer/{court}/{case}/dockets/update
  {
    name: "get_dockets",
    description:
      "Get the docket sheet for a case — all filings in chronological order with " +
      "dates, descriptions, and attached document info (is_cached, download_cost). " +
      "The header includes judge, attorneys, trustees, and 341 meeting date. " +
      "Supports keyword search and date/number range filtering. Free unless include_live_pacer=true.",
    inputSchema: {
      court_code,
      case_number,
      search_keyword:      z.string().optional().describe("Filter docket text"),
      date_filed_from:     z.string().optional().describe("MM/DD/YYYY"),
      date_filed_to:       z.string().optional().describe("MM/DD/YYYY"),
      docket_number_from:  z.number().int().optional(),
      docket_number_to:    z.number().int().optional(),
      sort_column: z.enum(["date_filed", "number", "sequence_number", "text_html"]).optional(),
      sort_order:  z.enum(["asc", "desc"]).optional(),
      page_size:           z.number().int().optional(),
      page_number:         z.number().int().optional(),
      include_documents: z.boolean().optional().describe(
        "When include_live_pacer=true: wait for document metadata (binder.documents) to " +
        "be populated before returning. Slower but the response includes is_cached and " +
        "download_cost for each PDF. Default false (metadata fetched in background)."
      ),
      include_live_pacer:  z.boolean().optional().describe(
        "true = purchase updated docket sheet from PACER (costs credits). Default false. " +
        "Always pass date_filed_from when refreshing to only buy entries newer than what " +
        "CourtAPI already has — omitting it buys the entire docket (expensive for active cases)."
      ),
    },
    handler: async ({ court_code, case_number, include_live_pacer, include_documents, date_filed_from, date_filed_to, ...params }) => {
      const base = `/cases/pacer/${court_code}/${String(case_number)}/dockets`;
      if (include_live_pacer) {
        // KB: use date_from (not date_filed_from) for the update POST body.
        // Prefer date_from over doc_from/doc_to — doc_from silently skips non-numbered entries.
        return post(`${base}/update`, {
          ...(date_filed_from  ? { date_from:         date_filed_from } : {}),
          ...(date_filed_to    ? { date_to:            date_filed_to   } : {}),
          ...(include_documents ? { include_documents: true            } : {}),
        });
      }
      return get(base, { date_filed_from, date_filed_to, ...params } as Record<string, unknown>);
    },
  },

  // ── 4. get_document ─────────────────────────────────────────────────────────
  // Covers: GET  /cases/pacer/{court}/{case}/dockets/{seq}/documents/{part}
  //         POST /cases/pacer/{court}/{case}/dockets/{seq}/documents/{part}
  {
    name: "get_document",
    description:
      "Get a PDF attached to a docket entry. Always checks the cache first. " +
      "If cached (is_cached=true), returns download_url + preview_url + ocr_link at no cost. " +
      "If not cached and purchase=true, buys from PACER and returns download_url + receipt. " +
      "If not cached and purchase=false (default), returns cost info so you can decide. " +
      "docket_seq comes from docket entries (e.g. '42.00000'). part defaults to 1 (main doc).",
    inputSchema: {
      court_code,
      case_number,
      docket_seq: z.string().describe("Docket sequence number, e.g. '42.00000' or '42'"),
      part:       z.number().int().optional().default(1).describe("Document part, 1 = main doc"),
      purchase:   z.boolean().optional().describe(
        "true = buy from PACER if not cached (costs credits). Default false."
      ),
    },
    handler: async ({ court_code, case_number, docket_seq, part = 1, purchase }) => {
      const path = `/cases/pacer/${court_code}/${String(case_number)}/dockets/${docket_seq}/documents/${part}`;
      // Always GET first to check cache status; POST only if purchase requested.
      // KB: use is_cached field; also check download_cost=="0.00" as fallback
      // since the swagger schema omits is_cached from the response definition.
      const cached = await get(path);
      const doc = (cached as Record<string, unknown>)?.["document"] as Record<string, unknown> | undefined;
      const alreadyCached = doc?.["is_cached"] === true || doc?.["download_cost"] === "0.00";
      if (alreadyCached || !purchase) return cached;
      return post(path);
    },
  },

  // ── 5. get_claims ───────────────────────────────────────────────────────────
  // Covers: GET  /cases/pacer/{court}/{case}/claims
  //         POST /cases/pacer/{court}/{case}/claims/update
  {
    name: "get_claims",
    description:
      "Get the bankruptcy claims register — all proofs of claim filed by creditors, " +
      "with amounts (filed/allowed/paid), claim type (secured/unsecured), creditor names, " +
      "and filing dates. Essential for Chapter 11 analysis and creditor research. " +
      "Supports keyword search and date/number range filtering.",
    inputSchema: {
      court_code,
      case_number,
      search_keyword:  z.string().optional(),
      date_filed_from: z.string().optional().describe("MM/DD/YYYY"),
      date_filed_to:   z.string().optional().describe("MM/DD/YYYY"),
      number_from:     z.number().int().optional(),
      number_to:       z.number().int().optional(),
      claim_type: z.enum([
        "amount_claimed", "unknown_claimed", "priority_claimed",
        "secured_claimed", "unsecured_claimed", "admin_claimed",
      ]).optional().describe("Filter by claim type"),
      sort_column: z.enum(["claim_number", "date_filed", "date_entered", "amendment_entered", "amendment_filed"]).optional(),
      sort_order:  z.enum(["asc", "desc"]).optional(),
      page_size:       z.number().int().optional(),
      page_number:     z.number().int().optional(),
      include_live_pacer: z.boolean().optional().describe(
        "true = refresh claims from PACER (costs credits). Default false."
      ),
    },
    handler: async ({ court_code, case_number, include_live_pacer, date_filed_from, date_filed_to, ...params }) => {
      const base = `/cases/pacer/${court_code}/${String(case_number)}/claims`;
      if (include_live_pacer) {
        return post(`${base}/update`, {
          ...(date_filed_from ? { date_from: date_filed_from } : {}),
          ...(date_filed_to   ? { date_to:   date_filed_to   } : {}),
        });
      }
      return get(base, { date_filed_from, date_filed_to, ...params } as Record<string, unknown>);
    },
  },

  // ── 6. get_parties ──────────────────────────────────────────────────────────
  // Covers: GET /cases/pacer/{court}/{case}/parties
  //         GET /cases/pacer/{court}/{case}/attorneys
  {
    name: "get_parties",
    description:
      "Get all parties in a case (debtors, creditors, plaintiffs, defendants, trustees) " +
      "and optionally their attorneys with firm name, contact info, and bar number. " +
      "Useful for conflicts checks, service lists, and identifying who is involved.",
    inputSchema: {
      court_code,
      case_number,
      include_attorneys: z.boolean().optional().default(true)
        .describe("Also fetch attorney records. Default true."),
    },
    handler: async ({ court_code, case_number, include_attorneys = true }) => {
      const base = `/cases/pacer/${court_code}/${String(case_number)}`;
      const parties = await get(`${base}/parties`);
      if (!include_attorneys) return parties;
      // Only suppress 404 — if attorneys haven't been purchased yet for this case type.
      // Let auth errors and network errors propagate.
      const attorneys = await get(`${base}/attorneys`).catch((e: unknown) => {
        if (e instanceof CourtApiError && e.status === 404) return null;
        throw e;
      });
      return { parties, attorneys };
    },
  },

  // ── 7. get_creditors ────────────────────────────────────────────────────────
  // Covers: GET  /cases/pacer/{court}/{case}/creditors
  //         POST /cases/pacer/{court}/{case}/creditors
  {
    name: "get_creditors",
    description:
      "Get the creditor list for a bankruptcy case — all creditors scheduled in " +
      "Schedules D/E/F, whether or not they filed a proof of claim. " +
      "Different from get_claims (which shows filed proofs of claim).",
    inputSchema: {
      court_code,
      case_number,
      include_live_pacer: z.boolean().optional().describe(
        "true = refresh from PACER (costs credits). Default false."
      ),
    },
    handler: async ({ court_code, case_number, include_live_pacer }) => {
      const path = `/cases/pacer/${court_code}/${String(case_number)}/creditors`;
      return include_live_pacer ? post(path) : get(path);
    },
  },

  // ── 8. ncl_search ───────────────────────────────────────────────────────────
  // Covers: POST /pacer/ncl/{type}
  //         GET  /pacer/ncl/{type}/{search_id}
  {
    name: "ncl_search",
    description:
      "Search PACER's National Case Locator across all federal courts at once. " +
      "More comprehensive than find_cases for party name searches — queries PACER directly. " +
      "Costs PACER credits. Returns up to ~50 cases per page; pass search_id + page to paginate. " +
      "Use for: finding a person's cases across all courts, SSN lookups, cross-court party searches.",
    inputSchema: {
      court_type: z.enum(["all", "bankruptcy", "civil", "criminal", "appellate"])
        .default("all")
        .describe("Which court type to search"),
      // Search body params (form-encoded)
      last_name:    z.string().optional().describe("Last name or business name"),
      first_name:   z.string().optional(),
      middle_name:  z.string().optional(),
      party_name:   z.string().optional().describe("Full name 'last, first' — alternative to last_name/first_name"),
      party_exact:  z.boolean().optional().describe("Exact name match only"),
      ssn4:         z.string().optional().describe("Last 4 digits of SSN (requires last_name)"),
      ssntin:       z.string().optional().describe("Full SSN or TIN (requires last_name)"),
      case_no:      z.string().optional().describe("Case number"),
      chapter:      z.string().optional().describe("Bankruptcy chapter, e.g. '11'"),
      court_code:   z.string().optional().describe("Limit to a specific court"),
      region_code:  z.string().optional().describe("PACER region code"),
      filed_from:   z.string().optional().describe("MM/DD/YYYY"),
      filed_to:     z.string().optional().describe("MM/DD/YYYY"),
      // Query params (sort)
      sort_field:   z.string().optional().describe("Sort field, e.g. 'cs_date_filed'"),
      sort_reverse: z.boolean().optional().describe("Reverse sort direction"),
      // Pagination for existing search
      search_id: z.string().optional()
        .describe("From a previous ncl_search response — pass to get the next page"),
      page: z.number().int().min(1).optional()
        .describe("Page number (1-based). Requires search_id."),
    },
    handler: async ({ court_type = "all", search_id, page, sort_field, sort_reverse, ...body }) => {
      const type = String(court_type);
      if (search_id) {
        return get(`/pacer/ncl/${type}/${search_id}`, { page_no: page ?? 1, sort_field, sort_reverse });
      }
      // sort_field/sort_reverse are query params; everything else is form body
      const qs = new URLSearchParams();
      if (sort_field)   qs.set("sort_field",   String(sort_field));
      if (sort_reverse) qs.set("sort_reverse",  "true");
      const url = `/pacer/ncl/${type}` + (qs.toString() ? `?${qs}` : "");
      return post(url, body as Record<string, unknown>);
    },
  },

  // ── 9. list_courts ──────────────────────────────────────────────────────────
  // Covers: GET /courts/pacer
  {
    name: "list_courts",
    description:
      "List all PACER courts with their court codes. Call this when you need a court_code " +
      "and don't know it. Returns ~200 courts; use type to filter. " +
      "Common codes: nysbke, debke, ilnbke, cacdbe, txnbke.",
    inputSchema: {
      type: z.enum(["bankruptcy", "district", "appellate", "national"]).optional()
        .describe("Filter by court type. Omit for all ~200 courts."),
      test: z.boolean().optional()
        .describe("false = exclude training/test courts (recommended). Omit to include all."),
    },
    handler: async ({ type, test }) => get("/courts/pacer", { type, test }),
  },

  // ── 10. get_pacer_credentials ────────────────────────────────────────────────
  // Covers: GET + POST + DELETE /pacer/credentials
  //         POST /pacer/credentials/validate
  {
    name: "get_pacer_credentials",
    description:
      "Check or update PACER credentials stored in CourtAPI. " +
      "PACER credentials are required before any include_live_pacer=true call. " +
      "action='check'    → show stored username (password not returned). " +
      "action='set'      → store pacer_user + pacer_pass. " +
      "action='validate' → test credentials without storing. " +
      "action='delete'   → remove stored credentials.",
    inputSchema: {
      action: z.enum(["check", "set", "validate", "delete"]),
      pacer_user: z.string().optional().describe("Required for set/validate"),
      pacer_pass: z.string().optional().describe("Required for set/validate"),
      validate: z.boolean().optional()
        .describe("For action='set': whether to test credentials against PACER before storing. Default true."),
    },
    handler: async ({ action, pacer_user, pacer_pass, validate }) => {
      switch (action) {
        case "check":    return get("/pacer/credentials");
        case "set":      return post("/pacer/credentials", { pacer_user, pacer_pass, validate });
        case "validate": return post("/pacer/credentials/validate", { pacer_user, pacer_pass });
        case "delete": return del("/pacer/credentials");
      }
    },
  },

];
