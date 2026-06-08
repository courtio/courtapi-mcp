# CourtAPI MCP Server

Search and retrieve US federal court cases, dockets, claims, and documents via PACER — directly from Claude and other MCP-compatible AI assistants.

## What it does

This MCP server exposes [CourtAPI](https://www.courtapi.com) as a set of tools that let an AI assistant:

- **Find cases** by party name, case number, or free-text keywords across all federal courts
- **Get case metadata** — title, chapter, judge, filing dates, assets/liabilities, and what sub-resources have been purchased
- **Get dockets** — full docket sheets with filing history, keyword search, and date filtering
- **Download documents** — PDFs attached to docket entries, with cost-checking before purchase
- **Get claims** — bankruptcy claims registers with creditor names, amounts, and claim types
- **Get parties** — all parties and attorneys in a case
- **Get creditors** — scheduled creditors (Schedules D/E/F), separate from filed claims
- **Search PACER NCL** — National Case Locator for cross-court party searches
- **List courts** — all ~200 PACER courts with their codes
- **Manage PACER credentials** — store and validate PACER username/password

Coverage: **all US federal courts** — bankruptcy, district, and appellate. State courts are not supported.

---

## Prerequisites

**CourtAPI account** — Get credentials (APP\_ID + APP\_KEY) at the [developer portal](https://courtapi-admin.3scale.net). A free 30-day sandbox is available (150 API calls/day, 500/month) — contact [support@courtapi.com](mailto:support@courtapi.com) to start one.

**PACER account** — Required for fetching live data (docket updates, document downloads). Register free at [pacer.uscourts.gov](https://pacer.uscourts.gov/register-account/pacer-case-search-only). PACER charges per page for documents; CourtAPI passes these fees through at cost.

---

## Installation

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "courtapi": {
      "command": "npx",
      "args": ["-y", "@courtio/courtapi-mcp"],
      "env": {
        "COURTAPI_APP_ID": "your_app_id",
        "COURTAPI_APP_KEY": "your_app_key"
      }
    }
  }
}
```

Restart Claude Desktop. The hammer icon will show CourtAPI tools listed.

### Other MCP clients

The server uses stdio transport by default, which is compatible with any MCP host. Use the same `command`/`args`/`env` pattern above.

### HTTP mode (Streamable HTTP transport)

For clients that use HTTP rather than stdio (e.g. the OpenAI Responses API remote tools):

```bash
COURTAPI_APP_ID=your_id COURTAPI_APP_KEY=your_key PORT=3000 \
  npx @courtio/courtapi-mcp --http
```

### From source

```bash
git clone https://gitlab.com/courtio/courtio.git
cd courtio/mcp/courtapi
npm install && npm run build
# then point Claude Desktop at dist/index.js instead of npx
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `COURTAPI_APP_ID` | Yes | Your CourtAPI application ID |
| `COURTAPI_APP_KEY` | Yes | Your CourtAPI application key |
| `COURTAPI_BASE_URL` | No | Override API base URL (default: `https://v1.courtapi.com`) |

---

## Quick start

Once connected, try these prompts in Claude:

> "Find the Sbarro bankruptcy case and show me the latest docket entries"

> "Search for Chapter 11 cases filed in the Delaware bankruptcy court in 2024"

> "Get the claims register for case 1:14-bk-10557 in the SDNY bankruptcy court"

> "Set my PACER credentials to username johndoe and password mypassword"

---

## Tools

### `find_cases`
Discover cases you don't have a court code or full case number for. Pass a party/company name, partial case number, or free-text keywords. The tool automatically picks the best search endpoint:

- **Party/title search** — fast, free, good for company or person names
- **Case number search** — resolves partial or ambiguous numbers
- **Keyword search** (`search-filings`) — full-text across CourtAPI's filing repository; costs 1 API call per 25 results returned

Returns `court_code` + `case_number` pairs needed by all other tools.

### `get_case`
Get all metadata for a known case: title, chapter, judge, key dates (filed/closed/discharged), assets, liabilities, and the `menu` object. The `menu` has one entry per sub-resource (dockets, claims, parties, etc.) with a `modified` timestamp — `null` means that resource has never been purchased from PACER.

Always call this first after finding a case to check what data is already available. Free unless `include_live_pacer=true`.

### `get_dockets`
Get the docket sheet — all filings in chronological order with dates, descriptions, and attached document info. Supports keyword search and date/number range filtering.

Two useful fields on every docket entry:
- **`binder.documents`** — pre-fetched document metadata including `is_cached` and `download_cost` for each PDF, so you can check availability without a separate documents API call.
- **`annotations`** — key dates extracted from docket text (deadlines, hearings, etc.) with `key_phrase`, `datetime`, and `time_zone`. Useful for building calendar integrations without parsing docket text.

When calling with `include_live_pacer=true` to buy a fresh docket sheet from PACER, always pass `date_filed_from` to limit the purchase to entries newer than what CourtAPI already has. Omitting it buys the entire docket history — expensive for active cases.

### `get_document`
Get a PDF attached to a docket entry. Checks the cache first:
- `is_cached=true` or `download_cost="0.00"` → returns `download_url`, `preview_url`, and `ocr_link` at no cost
- Not cached + `purchase=false` (default) → returns cost info so you can decide before spending
- Not cached + `purchase=true` → buys from PACER, stores it, returns `download_url` + PACER `receipt`

`docket_seq` comes from docket entries (e.g. `"42.00000"`). `part` defaults to 1 (main document); exhibits and attachments have higher part numbers.

Once purchased, the document is cached — all subsequent GETs are free.

### `get_claims`
Get the bankruptcy claims register — all proofs of claim filed by creditors, with amounts (filed/allowed/paid), claim type, creditor names, and filing dates. Essential for Chapter 11 creditor analysis.

Filter by `claim_type` (secured, unsecured, priority, admin, etc.) and sort by claim number, filing date, or amendment date.

### `get_parties`
Get all parties in a case (debtors, creditors, plaintiffs, defendants, trustees) and optionally their attorneys with firm name, contact info, and bar number. Attorney records return `null` (not an error) when they haven't been purchased for this case — use `include_attorneys=false` to suppress the attorney fetch.

Useful for conflicts checks, service lists, and identifying who is involved in a case.

### `get_creditors`
Get scheduled creditors from bankruptcy Schedules D/E/F. This is different from `get_claims` — creditors listed here may not have filed a proof of claim. Use both to get a complete creditor picture.

### `ncl_search`
Search PACER's National Case Locator across all federal courts at once. More comprehensive than `find_cases` for party name searches because it queries PACER directly. Costs PACER credits.

Supports: name searches, SSN/TIN lookups (with last name), case number, chapter, court, and date range filters. Paginate with `search_id` from the previous response.

### `list_courts`
List all ~200 PACER courts with their court codes and names. Filter by type: `bankruptcy`, `district`, or `appellate`.

Common codes: `nysbke` (NY Southern Bankruptcy), `debke` (Delaware Bankruptcy), `ilnbke` (IL Northern Bankruptcy), `cacdbe` (CA Central Bankruptcy), `txnbke` (TX Northern Bankruptcy).

### `get_pacer_credentials`
Manage PACER credentials stored in CourtAPI. PACER credentials are required before any `include_live_pacer=true` call.

| `action` | What it does |
|---|---|
| `check` | Show the stored PACER username (password not returned) |
| `set` | Store `pacer_user` + `pacer_pass` (validates against PACER by default) |
| `validate` | Test credentials against PACER without storing |
| `delete` | Remove stored credentials |

---

## Understanding costs

CourtAPI has two independent cost layers:

**CourtAPI API credits** — charged by your CourtAPI plan. Free for: case GET lookups, party/title searches, docket GETs from cache, document GETs from cache. Costs 1 call per 25 results for keyword search (`search-filings`).

**PACER fees** — charged by the US federal courts per page. Only incurred when:
- `include_live_pacer=true` on dockets, claims, creditors, or case refresh
- `purchase=true` on `get_document`

`download_cost="0.00"` means a document is cached and free to retrieve. Always check before purchasing.

---

## Case number format

CourtAPI requires **long-form PACER case numbers**. PACER often shows short forms in its UI (e.g. `14-10557`) but the API always needs the full form.

**Non-appellate courts (district, bankruptcy):**
```
O:YY-TT-NNNNN
```
- `O` — office/division number (e.g. `1`, `2`, `3`)
- `YY` — two-digit filing year
- `TT` — case type: `bk` bankruptcy, `cv` civil, `cr` criminal, `ap` adversary proceeding
- `NNNNN` — sequence number

Example: `1:14-bk-10557` (not `14-10557`)

**Appellate courts:**
```
YY-NNNNN
```
Example: `23-1234`

If PACER shows a short form, use `find_cases` to resolve it. Always pair a case number with its `court_code` — the same sequence number can exist in multiple courts.

---

## PACER screenshots on updates

When `get_dockets` or `get_claims` fetches live data from PACER (`include_live_pacer=true`), the response includes `links.screenshot.pdf.href` — a link to a PDF screenshot of the actual PACER page that was fetched. Useful for audit and compliance verification.

---

## License

MIT — © CourtDrive. See [courtapi.com](https://www.courtapi.com) for API terms.
