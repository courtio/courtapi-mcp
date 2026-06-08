/**
 * Thin HTTP client for v1.courtapi.com.
 *
 * Owns exactly three things:
 *   1. Authorization: Basic base64(APP_ID:APP_KEY)
 *   2. x-courtapi-version: 1.0.16
 *   3. Serialising query params (arrays → repeated keys)
 *
 * Everything else is a passthrough.
 */

export const BASE = process.env.COURTAPI_BASE_URL ?? "https://v1.courtapi.com";
const VERSION = "1.0.16";

export class CourtApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`CourtAPI HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

function authHeader(): string {
  const id  = process.env.COURTAPI_APP_ID;
  const key = process.env.COURTAPI_APP_KEY;
  if (!id || !key) throw new Error(
    "Set COURTAPI_APP_ID and COURTAPI_APP_KEY. Get credentials at courtapi.com"
  );
  return "Basic " + Buffer.from(`${id}:${key}`).toString("base64");
}

function headers(): Record<string, string> {
  return {
    Authorization: authHeader(),
    "x-courtapi-version": VERSION,
    Accept: "application/json",
  };
}

async function handleResponse(res: Response, path: string): Promise<unknown> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new CourtApiError(res.status, body);
  return body;
}

/** Build a URL with query params; arrays become repeated keys. */
export function buildUrl(path: string, params?: Record<string, unknown>): string {
  const url = new URL(BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

export async function get(path: string, params?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(buildUrl(path, params), { headers: headers() });
  return handleResponse(res, path);
}

export async function del(path: string): Promise<unknown> {
  const res = await fetch(BASE + path, { method: "DELETE", headers: headers() });
  return handleResponse(res, path);
}

export async function post(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? new URLSearchParams(
      Object.entries(body)
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, String(v)])
    ).toString() : undefined,
  });
  return handleResponse(res, path);
}
