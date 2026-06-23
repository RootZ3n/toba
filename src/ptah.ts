/**
 * Toba — Mad-Ptah QA Bridge (optional, disabled by default)
 * =========================================================
 * Mirrors the existing optional `TOBA_BRIDGE_URL` pattern. When `TOBA_PTAH_URL`
 * is set, a staged outreach draft or a freshly tailored resume is POSTed to
 * mad-ptah's review endpoint for an automated pre-send QA pass — fabricated
 * metrics not in the profile, tone problems, broken merge fields like
 * "Dear [Hiring Manager]", overclaimed seniority. The returned findings are
 * stored on the row and shown as inline warnings on the approve screen.
 *
 * Hard rule: the bridge is **best-effort**. When the URL is unset, unreachable,
 * or returns garbage, `reviewWithPtah` resolves to `null` and Toba keeps working
 * exactly as before — QA simply does not run. No throw escapes this module.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export type PtahReviewKind = "outreach" | "resume";

export interface PtahFinding {
  /** Severity bucket used for UI styling: info | warning | critical. */
  severity: "info" | "warning" | "critical";
  /** Short category, e.g. "fabricated_metric", "tone", "merge_field". */
  type: string;
  /** Human-readable message shown to the user. */
  message: string;
  /** Optional quoted snippet the finding refers to. */
  excerpt?: string;
}

export interface PtahReviewResult {
  reviewed: boolean;
  findings: PtahFinding[];
  /** Raw error string when the bridge was attempted but failed. */
  error?: string;
}

/** Read the bridge URL fresh each call so tests / runtime config can toggle it. */
export function ptahUrl(): string {
  return process.env["TOBA_PTAH_URL"] ?? "";
}

export function ptahEnabled(): boolean {
  return ptahUrl().trim().length > 0;
}

function httpJson(method: string, urlStr: string, payload: unknown, timeoutMs = 20_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? httpsRequest : httpRequest;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = lib({
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        ...(body ? { "content-length": Buffer.byteLength(body).toString() } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error(`Ptah request to ${url.host} timed out after ${timeoutMs}ms`)); });
    if (body) req.write(body);
    req.end();
  });
}

const ALLOWED_SEVERITY = new Set(["info", "warning", "critical"]);

/** Coerce arbitrary bridge JSON into a clean, bounded findings array. */
function normalizeFindings(raw: unknown): PtahFinding[] {
  // Accept either { findings: [...] } or a bare array.
  const arr = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).findings))
      ? (raw as Record<string, unknown>).findings as unknown[]
      : [];
  const findings: PtahFinding[] = [];
  for (const item of arr.slice(0, 50)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const severity = ALLOWED_SEVERITY.has(String(o.severity)) ? String(o.severity) as PtahFinding["severity"] : "warning";
    const message = String(o.message ?? o.detail ?? o.text ?? "").slice(0, 600).trim();
    if (!message) continue;
    findings.push({
      severity,
      type: String(o.type ?? o.category ?? "general").slice(0, 60),
      message,
      ...(o.excerpt ? { excerpt: String(o.excerpt).slice(0, 400) } : {}),
    });
  }
  return findings;
}

/**
 * Run a QA review against mad-ptah. Returns `null` when the bridge is disabled
 * (no URL configured). Returns `{ reviewed: false, error }` when the bridge was
 * attempted but failed — callers treat both as "no findings, keep going".
 */
export async function reviewWithPtah(
  kind: PtahReviewKind,
  text: string,
  context: Record<string, unknown> = {},
): Promise<PtahReviewResult | null> {
  const url = ptahUrl().trim();
  if (!url) return null;
  try {
    const res = await httpJson("POST", url, { kind, text, context, source: "toba" });
    if (res.status < 200 || res.status >= 300) {
      return { reviewed: false, findings: [], error: `Ptah returned HTTP ${res.status}` };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(res.body); } catch { return { reviewed: false, findings: [], error: "Ptah returned non-JSON" }; }
    return { reviewed: true, findings: normalizeFindings(parsed) };
  } catch (err) {
    return { reviewed: false, findings: [], error: err instanceof Error ? err.message : String(err) };
  }
}
