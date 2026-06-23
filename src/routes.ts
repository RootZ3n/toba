/**
 * Toba — Route Registration
 * =========================
 * All /toba/* and top-level health/version/status routes.
 * Backward-compat: /toba/* URLs are rewritten to /toba/* by the server.
 */

import type { FastifyInstance } from "fastify";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";
import type { TobaV1DB, TobaProduct, ReceiptAction, AutomationStatus, LanePriority, EvalGrade, StoryFormat, PehAgent, PehSession } from "./db.js";
import { TobaV2DB, TOBA_SCHEMA_VERSION } from "./db.js";
import {
  getToolsForAgent,
  agentHasTools,
  type ToolCall,
  type ToolCallResult,
} from "./tools/registry.js";
import { registerWebSearchTool } from "./tools/web-search.js";
import { registerApplicationTools, getTrackerApp, listTrackerApps, updateTrackerApp, deleteTrackerApp } from "./tools/applications.js";
import type { TrackerAppStatus } from "./tools/applications.js";
import { toolChat, type ToolChatMessage, providerSupportsTools } from "./tools/tool-chat.js";
import { guardContext } from "./velum-guard.js";
import { reviewWithPtah, ptahEnabled, type PtahFinding } from "./ptah.js";

// ── Web SPA assets (loaded once at module init) ──────────────────────────
const __webDir = (() => {
  try { return join(dirname(fileURLToPath(import.meta.url)), "web"); }
  catch { return join(process.cwd(), "src", "web"); }
})();
function readWebAsset(name: string): string {
  const path = join(__webDir, name);
  if (!existsSync(path)) return "";
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}
const WEB_INDEX  = readWebAsset("index.html");
const WEB_APP_JS = readWebAsset("app.js");
const WEB_STYLES = readWebAsset("styles.css");
import {
  chat as providerChat,
  getStatus as getProviderStatus,
  getConfig as getProviderConfig,
  getRuntimeStatus as getProviderRuntimeStatus,
  persistConfig as persistProviderConfig,
  applyConfigPatch,
  ProviderError,
  isLocalProvider as providerIsLocal,
  PROVIDER_REGISTRY,
  type ChatMessage,
  type ProviderConfig,
} from "./provider.js";
import type { NetworkConfig } from "./network.js";
import { classifyBind } from "./network.js";

// ── World-engine UI (ui/ at the repo root) — the immersive frontend ──────
// Served live from disk so edits show without a restart. Both `tsx src/...`
// (dev) and `dist/` (built) sit one level under the repo root, so ".." + ui
// resolves correctly in either case.
const __uiDir = (() => {
  try { return join(dirname(fileURLToPath(import.meta.url)), "..", "ui"); }
  catch { return join(process.cwd(), "ui"); }
})();
const UI_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp",
};
function readUiFile(rel: string): Buffer | null {
  // `rel` is always a fixed, server-controlled path — never raw user input.
  const path = join(__uiDir, rel);
  if (!path.startsWith(__uiDir) || !existsSync(path)) return null;
  try { return readFileSync(path); } catch { return null; }
}
function sendUiFile(reply: import("fastify").FastifyReply, rel: string) {
  const buf = readUiFile(rel);
  if (!buf) return reply.status(404).send("Not found");
  const ext = rel.slice(rel.lastIndexOf("."));
  return reply
    .header("content-type", UI_CONTENT_TYPES[ext] ?? "application/octet-stream")
    .header("cache-control", "no-cache")
    .send(buf);
}

const TOBA_VERSION = process.env["TOBA_VERSION"] ?? process.env["CURSUS_VERSION"] ?? "5.0.0";

const PKG_VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? TOBA_VERSION;
  } catch {
    return TOBA_VERSION;
  }
})();

const TOBA_PORT = parseInt(process.env["TOBA_PORT"] ?? process.env["CURSUS_PORT"] ?? "18815", 10);
const TOBA_AUTOMATION_MODE = process.env["TOBA_AUTOMATION_MODE"] ?? process.env["CURSUS_AUTOMATION_MODE"] ?? "approval-required";
// Optional legacy bridge URL — disabled by default. Bridge is for legacy
// integrations only and is NOT required.
const TOBA_BRIDGE_URL = process.env["TOBA_BRIDGE_URL"] ?? process.env["CURSUS_BRIDGE_URL"] ?? process.env["PEH_CURSUS_URL"] ?? "";

function listToJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return JSON.stringify(value.map(v => String(v).trim()).filter(Boolean));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "[]";
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return JSON.stringify(parsed.map(v => String(v).trim()).filter(Boolean));
    } catch { /* comma/newline format below */ }
    return JSON.stringify(trimmed.split(/[,;\n]+/).map(v => v.trim()).filter(Boolean));
  }
  return undefined;
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

type ResumeFileUpload = {
  name?: string;
  type?: string;
  base64?: string;
};

type ResumeUploadBody = {
  text?: string;
  tailored_for?: string;
  file?: ResumeFileUpload;
  file_name?: string;
  file_type?: string;
  file_base64?: string;
};

type PehContextFlags = {
  profile?: boolean;
  resume?: boolean;
  campaign?: boolean;
  applications?: boolean;
  receipts?: boolean;
};

const RESUME_UPLOAD_MAX_BYTES = parseInt(process.env["TOBA_RESUME_UPLOAD_MAX_BYTES"] ?? process.env["CURSUS_RESUME_UPLOAD_MAX_BYTES"] ?? `${5 * 1024 * 1024}`, 10);

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)));
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

function stripDataUrlPrefix(base64: string): string {
  const comma = base64.indexOf(",");
  return base64.startsWith("data:") && comma >= 0 ? base64.slice(comma + 1) : base64;
}

function extractTextFromDocx(buffer: Buffer): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset + 30 < buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }

    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) break;

    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    if (/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)) {
      const compressed = buffer.subarray(dataStart, dataEnd);
      const xml = (method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : Buffer.alloc(0)).toString("utf8");
      const text = decodeHtmlEntities(xml
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<[^>]+>/g, ""));
      if (text.trim()) parts.push(text);
    }

    offset = dataEnd;
  }
  return normalizeExtractedText(parts.join("\n"));
}

function decodePdfLiteralString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\([0-7]{1,3})/g, (_m, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function extractTextFromPdf(buffer: Buffer): string {
  const chunks = [buffer.toString("latin1")];
  const raw = chunks[0]!;
  const streamRegex = /<<(?:.|\n|\r)*?\/FlateDecode(?:.|\n|\r)*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of raw.matchAll(streamRegex)) {
    try {
      const streamBytes = Buffer.from(match[1] ?? "", "latin1");
      chunks.push(inflateSync(streamBytes).toString("latin1"));
    } catch {
      // Some PDFs use predictors or filters this lightweight extractor cannot decode.
    }
  }

  const textParts: string[] = [];
  const content = chunks.join("\n");
  for (const match of content.matchAll(/\((?:\\.|[^\\)]){2,}\)\s*(?:Tj|'|"|TJ)/g)) {
    textParts.push(decodePdfLiteralString(match[0]!.replace(/\)\s*(?:Tj|'|"|TJ)$/, "").slice(1)));
  }
  for (const match of content.matchAll(/<([0-9a-fA-F\s]{4,})>\s*(?:Tj|'|"|TJ)/g)) {
    const hex = (match[1] ?? "").replace(/\s+/g, "");
    try {
      const bytes = Buffer.from(hex, "hex");
      const decoded = bytes.length >= 2 && bytes[0] === 0
        ? Array.from({ length: Math.floor(bytes.length / 2) }, (_v, i) => String.fromCharCode(bytes.readUInt16BE(i * 2))).join("")
        : bytes.toString("utf8");
      textParts.push(decoded.replace(/\0/g, ""));
    } catch {
      try { textParts.push(Buffer.from(hex, "hex").toString("utf8")); } catch {}
    }
  }
  return normalizeExtractedText(textParts.join("\n"));
}

function extractTextFromRtf(buffer: Buffer): string {
  return normalizeExtractedText(buffer.toString("utf8")
    .replace(/\\'[0-9a-fA-F]{2}/g, " ")
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\tab/g, "\t")
    .replace(/[{}]/g, "")
    .replace(/\\[a-zA-Z]+\d* ?/g, ""));
}

function extractResumeUpload(body: ResumeUploadBody): { text: string; source: "text" | "file"; filename?: string; mime?: string; bytes?: number } {
  const pasted = typeof body.text === "string" ? body.text.trim() : "";
  const upload = body.file ?? {
    name: body.file_name,
    type: body.file_type,
    base64: body.file_base64,
  };
  const encoded = typeof upload.base64 === "string" ? stripDataUrlPrefix(upload.base64.trim()) : "";
  if (!encoded) return { text: pasted, source: "text" };

  const filename = upload.name || "resume";
  const mime = upload.type || "application/octet-stream";
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length > RESUME_UPLOAD_MAX_BYTES) {
    throw new Error(`Resume file is too large. Limit is ${Math.floor(RESUME_UPLOAD_MAX_BYTES / 1024 / 1024)} MB.`);
  }

  const ext = extensionOf(filename);
  let text = "";
  if (mime.startsWith("text/") || ["txt", "md", "markdown", "csv"].includes(ext)) {
    text = buffer.toString("utf8");
  } else if (mime === "application/pdf" || ext === "pdf") {
    text = extractTextFromPdf(buffer);
  } else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === "docx") {
    text = extractTextFromDocx(buffer);
  } else if (mime === "application/rtf" || mime === "text/rtf" || ext === "rtf") {
    text = extractTextFromRtf(buffer);
  } else {
    throw new Error("Unsupported resume file type. Use PDF, DOCX, RTF, TXT, or Markdown.");
  }

  return { text: normalizeExtractedText(text), source: "file", filename, mime, bytes: buffer.length };
}

function summarizeText(text: string, max = 1200): string {
  const clean = normalizeExtractedText(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trim()}...`;
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return value.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  }
}

function makeResumeSummary(text: string): string {
  const lines = normalizeExtractedText(text).split(/\n+/).map(s => s.trim()).filter(Boolean);
  return summarizeText(lines.slice(0, 14).join("\n"), 1600);
}

/**
 * Best-effort extraction of a JSON array of job objects from a model response.
 * Models often wrap JSON in prose or ```json fences — pull out the first array.
 */
function parseJobsFromModel(content: string): Array<Record<string, unknown>> {
  if (!content) return [];
  const tryParse = (s: string): Array<Record<string, unknown>> | null => {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.jobs)) return (obj.jobs as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
      }
      return null;
    } catch { return null; }
  };
  // Whole response, then a fenced block, then the first [...] slice.
  const direct = tryParse(content.trim());
  if (direct) return direct;
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { const r = tryParse(fence[1].trim()); if (r) return r; }
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start !== -1 && end > start) { const r = tryParse(content.slice(start, end + 1)); if (r) return r; }
  return [];
}

function getProviderMeta() {
  const s = getProviderStatus();
  return {
    provider: s.provider,
    model: s.model,
    local: s.local,
    configured: s.configured,
    base_url: s.base_url,
  };
}

export function registerRoutes(
  server: FastifyInstance,
  v1: TobaV1DB,
  v2: TobaV2DB,
  netCfg?: NetworkConfig,
): void {
  // Sensible default for tests / inline use: loopback.
  const network: NetworkConfig = netCfg ?? {
    host: process.env["TOBA_HOST"] ?? process.env["CURSUS_HOST"] ?? "127.0.0.1",
    port: parseInt(process.env["TOBA_PORT"] ?? process.env["CURSUS_PORT"] ?? "18815", 10),
    exposure: classifyBind(process.env["TOBA_HOST"] ?? process.env["CURSUS_HOST"] ?? "127.0.0.1"),
  };

  // ── Initialize tool system ──────────────────────────────────────────────
  // Get the raw DB handle from V2 for tool operations
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolDb = (v2 as any).db as any;
  registerWebSearchTool();
  registerApplicationTools(toolDb);

  // ═══════════════════════════════════════════════════════════════════════════
  // Web UI (SPA)
  // ═══════════════════════════════════════════════════════════════════════════

  // Primary frontend: the immersive world engine in ui/. Falls back to the
  // classic SPA, then to a plain-text hint, if the ui/ assets are absent.
  server.get("/", async (_req, reply) => {
    const buf = readUiFile("index.html");
    if (buf) return reply.header("content-type", "text/html; charset=utf-8").send(buf);
    if (WEB_INDEX) return reply.header("content-type", "text/html; charset=utf-8").send(WEB_INDEX);
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .status(500)
      .send("Toba UI assets not found. Expected ui/index.html or src/web/index.html. See /api for the JSON endpoint map.");
  });

  // World-engine modules + theme + assets (served from ui/ at the repo root).
  server.get("/toba.css", async (_req, reply) => sendUiFile(reply, "toba.css"));
  server.get("/api.js", async (_req, reply) => sendUiFile(reply, "api.js"));
  server.get("/peh-guide.js", async (_req, reply) => sendUiFile(reply, "peh-guide.js"));
  server.get("/scenes.js", async (_req, reply) => sendUiFile(reply, "scenes.js"));
  server.get("/app.js", async (_req, reply) => sendUiFile(reply, "app.js"));
  // Translation layer: maps fantasy labels to plain English for demos
  server.get("/translation-layer.js", async (_req, reply) => sendUiFile(reply, "translation-layer.js"));
  server.get("/translation-layer.css", async (_req, reply) => sendUiFile(reply, "translation-layer.css"));
  server.get("/translations-toba.js", async (_req, reply) => sendUiFile(reply, "translations-toba.js"));
  server.get<{ Params: { file: string } }>("/assets/:file", async (req, reply) => {
    const file = req.params.file;
    if (!/^[A-Za-z0-9._-]+$/.test(file)) return reply.status(404).send("Not found");
    return sendUiFile(reply, join("assets", file));
  });

  // Classic SPA (the pre-world-engine dashboard) remains reachable here.
  server.get("/classic", async (_req, reply) => {
    if (!WEB_INDEX) {
      return reply
        .header("content-type", "text/plain; charset=utf-8")
        .status(500)
        .send("Classic UI assets not found. Expected src/web/index.html.");
    }
    return reply.header("content-type", "text/html; charset=utf-8").send(WEB_INDEX);
  });

  server.get("/assets/app.js", async (_req, reply) => {
    if (!WEB_APP_JS) return reply.status(404).send("missing");
    return reply
      .header("content-type", "text/javascript; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(WEB_APP_JS);
  });

  server.get("/assets/styles.css", async (_req, reply) => {
    if (!WEB_STYLES) return reply.status(404).send("missing");
    return reply
      .header("content-type", "text/css; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(WEB_STYLES);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /api — programmatic landing (links + snapshot for tooling)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/api", async (_req, reply) => {
    const providerStatus = getProviderStatus();
    const agents = v2.listPehAgents();
    const agentList = agents.map(a =>
      `<li><code>${a.id}</code> ${a.provider ? `(${a.provider}/${a.model ?? "?"})` : "(default)"}</li>`
    ).join("");
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Toba · API map</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin: 0 0 .25rem; }
  .sub { color: #888; margin-top: 0; }
  .grid { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; margin: 1rem 0; }
  code { background: rgba(127,127,127,.15); padding: .1rem .3rem; border-radius: 3px; }
  .ok   { color: #1a7f1a; } .warn { color: #b86c00; }
  ul.routes li { margin: .2rem 0; }
  a.btn { display: inline-block; padding: .35rem .7rem; border: 1px solid rgba(127,127,127,.35); border-radius: 4px; text-decoration: none; margin: .15rem .25rem .15rem 0; }
  hr { border: none; border-top: 1px solid rgba(127,127,127,.25); margin: 1.5rem 0; }
  footer { color: #888; font-size: 13px; }
</style></head><body>
<h1>Toba · API map</h1>
<p class="sub">Programmatic endpoints — v${TOBA_VERSION} (schema v${TOBA_SCHEMA_VERSION}). For the interactive UI, go to <a href="/">/</a>.</p>
<div class="grid">
  <div>Mode</div>           <div><code>standalone</code></div>
  <div>Bind</div>           <div><code>${network.host}:${network.port}</code> · <code>${network.exposure}</code></div>
  <div>Provider</div>       <div><code>${providerStatus.provider}</code> / <code>${providerStatus.model}</code> ${providerStatus.local ? "(local)" : "(cloud)"} · ${providerStatus.configured ? "configured" : "<span class=\"warn\">not configured</span>"}</div>
  <div>Local-only</div>     <div>${providerStatus.local_only_mode ? "yes" : "no"}</div>
  <div>Peh agents</div>     <div>${agents.length} seeded (${agents.filter(a => a.provider || a.model).length} with overrides)</div>
</div>
<p>JSON endpoints:</p>
<a class="btn" href="/health">/health</a>
<a class="btn" href="/version">/version</a>
<a class="btn" href="/status">/status</a>
<a class="btn" href="/toba/provider">/toba/provider</a>
<a class="btn" href="/toba/peh/agents">/toba/peh/agents</a>
<a class="btn" href="/toba/dashboard">/toba/dashboard</a>
<a class="btn" href="/toba/receipts">/toba/receipts</a>
<h2>Peh agents</h2>
<ul class="routes">${agentList}</ul>
<hr>
<footer>UI: <a href="/">/</a> · Setup: <code>pnpm run toba:setup</code> · Verify: <code>./scripts/verify-standalone.sh</code></footer>
</body></html>`;
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Health + Version + Status
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/health", async (_req, reply) => {
    const dbReachable = v1.isReachable();
    const dbSchemaVersion = v1.getSchemaVersion();
    const schemaMatch = dbSchemaVersion === TOBA_SCHEMA_VERSION;

    if (!dbReachable) {
      return reply.status(503).send({
        ok: false,
        status: "degraded",
        service: "toba",
        version: TOBA_VERSION,
        db: { reachable: false, path: v1.getDbPath() },
        uptime: process.uptime(),
      });
    }

    try {
      const dashboard = v2.getDashboard();
      const onboarding = v2.getOnboarding();
      return reply.send({
        ok: true,
        status: schemaMatch ? "healthy" : "healthy_schema_drift",
        service: "toba",
        version: TOBA_VERSION,
        db: {
          reachable: true,
          path: v1.getDbPath(),
          schema_version: dbSchemaVersion,
          expected_schema_version: TOBA_SCHEMA_VERSION,
          schema_match: schemaMatch,
        },
        totalApplications: dashboard.totalApplications,
        activeCampaign: dashboard.activeCampaign?.name ?? null,
        pendingOutreach: dashboard.pendingOutreach,
        onboarded: !!onboarding?.completed,
        uptime: process.uptime(),
      });
    } catch (err) {
      return reply.status(503).send({
        ok: false,
        status: "degraded",
        service: "toba",
        version: TOBA_VERSION,
        db: { reachable: true, path: v1.getDbPath(), schema_version: dbSchemaVersion },
        error: String(err).slice(0, 200),
        uptime: process.uptime(),
      });
    }
  });

  server.get("/version", async (_req, reply) => {
    return reply.send({
      service: "toba",
      version: TOBA_VERSION,
      schema_version: TOBA_SCHEMA_VERSION,
      node: process.version,
      uptime: process.uptime(),
    });
  });

  server.get("/status", async (_req, reply) => {
    const activeCampaign = v2.getActiveCampaign();
    const onboarding = v2.getOnboarding();
    const lastScoutReceipts = v2.listReceipts(1, "job_scout_run");
    const providerStatus = getProviderStatus();
    const agents = v2.listPehAgents();
    const openrouterEnvKeySet = !!(process.env["TOBA_OPENROUTER_API_KEY"] ?? process.env["CURSUS_OPENROUTER_API_KEY"] ?? "");
    const globalOpenRouterConfigured = providerStatus.provider === "openrouter" && providerStatus.configured;
    const agentOpenRouterConfigured = agents.some(a => a.provider === "openrouter" && !!a.api_key && !!a.model);
    return reply.send({
      ok: true,
      mode: "standalone",
      bridge_enabled: !!TOBA_BRIDGE_URL,
      // ── Network exposure ──
      host: network.host,
      port: network.port,
      network_exposure: network.exposure,
      // ── Provider/model recap ──
      provider: providerStatus.provider,
      provider_label: providerStatus.provider_label,
      model: providerStatus.model,
      provider_mode: providerStatus.local ? "local" : `cloud:${providerStatus.provider}`,
      provider_configured: providerStatus.configured,
      local_only_mode: providerStatus.local_only_mode,
      // ── OpenRouter ──
      openrouter_configured: globalOpenRouterConfigured || agentOpenRouterConfigured || openrouterEnvKeySet,
      openrouter_source: globalOpenRouterConfigured ? "global" : agentOpenRouterConfigured ? "agent" : openrouterEnvKeySet ? "env" : null,
      openrouter_env_key_set: openrouterEnvKeySet,
      // ── Peh agents summary ──
      peh_agents: {
        total: agents.length,
        enabled: agents.filter(a => a.enabled === 1).length,
        with_overrides: agents.filter(a => a.provider || a.model).length,
        agents: agents.map(a => ({
          id: a.id,
          enabled: a.enabled === 1,
          provider: a.provider ?? null,
          model: a.model ?? null,
          local_only: a.local_only === 1,
          cloud_allowed: a.cloud_allowed !== 0,
        })),
      },
      // ── Existing ──
      automation_mode: TOBA_AUTOMATION_MODE,
      active_campaign: activeCampaign
        ? { id: activeCampaign.id, name: activeCampaign.name, target_role: activeCampaign.target_role }
        : null,
      onboarding_complete: !!onboarding?.completed,
      receipts_enabled: true,
      velum_enabled: true,
      last_job_scout_run: lastScoutReceipts[0]?.timestamp ?? null,
      pending_approvals: v2.countPendingAutomation(),
    });
  });

  server.get("/api/status", async (_req, reply) => {
    return reply.send({
      status: "ok",
      version: PKG_VERSION,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage().rss,
      timestamp: new Date().toISOString(),
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Onboarding
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/onboarding", async (_req, reply) => {
    const state = v2.getOnboarding();
    return reply.send({ ok: true, onboarding: state, provider: getProviderMeta() });
  });

  server.post<{ Body: Record<string, unknown> }>("/toba/onboarding", async (req, reply) => {
    const updated = v2.updateOnboarding(req.body ?? {});
    return reply.send({ ok: true, onboarding: updated });
  });

  server.post("/toba/onboarding/clear", async (_req, reply) => {
    return reply.send({ ok: true, onboarding: v2.clearOnboarding() });
  });

  server.post("/toba/onboarding/complete", async (_req, reply) => {
    const state = v2.getOnboarding();
    if (!state.name) {
      return reply.status(400).send({ ok: false, error: "Name is required before completing onboarding" });
    }

    const completed = v2.completeOnboarding();

    // Sync name/title/location to V1 profile if present.
    // Title: only set from preferred_titles when profile has no meaningful title already.
    const profilePatch: Record<string, string> = {};
    if (state.name) profilePatch.name = state.name;
    if (state.preferred_titles) {
      const existingTitle = v1.getProfile()?.title ?? "";
      if (!existingTitle) {
        profilePatch.title = state.preferred_titles.split(/[,;]+/)[0]!.trim();
      }
    }
    if (state.preferred_locations) profilePatch.location = state.preferred_locations.split(/[,;]+/)[0]!.trim();
    if (Object.keys(profilePatch).length > 0) v1.updateProfile(profilePatch);

    // Sync target_roles to V2 profile
    if (state.preferred_titles) {
      const roles = state.preferred_titles.split(/[,;]+/).map(r => r.trim()).filter(Boolean);
      v2.updateProfileV2({ target_roles: JSON.stringify(roles) });
    }

    v2.createReceipt({
      action: "onboarding_complete",
      result_summary: `Onboarding completed. Privacy: ${state.privacy_mode}.`,
    });

    return reply.send({ ok: true, onboarding: completed });
  });

  // ── First-run guided setup quest ──────────────────────────────────────────
  // Drives the interactive checklist in ui/onboarding.js from LIVE state instead
  // of a cosmetic scripted tour. Each step maps to a settlement location that
  // "lights up" once done. Completing the last step carves a milestone receipt.
  server.get("/toba/setup/quest", async (_req, reply) => {
    const provider = getProviderStatus();
    const onboarding = v2.getOnboarding();
    const profile = v1.getProfile();
    const campaigns = v2.listCampaigns();
    const resumes = v2.listResumes();
    const applications = v2.getActiveCampaign() ? v2.listApplications(v2.getActiveCampaign()!.id) : [];
    const lastScout = v2.listReceipts(1, "job_scout_run")[0] ?? null;

    const modelReady = provider.provider !== "none" && provider.configured;
    const profileReady = !!profile?.name && campaigns.length > 0;
    const resumeReady = !!onboarding?.resume_uploaded || resumes.length > 0;
    const jobsReady = !!lastScout || applications.length > 0;

    const steps = [
      {
        id: "configure_model", order: 1, location: "The Fire (model forge)",
        title: "Configure a model", done: modelReady,
        description: "Pick a provider/model so Peh can think. Set it, then verify with an echo chat.",
        action: { method: "PATCH", path: "/toba/provider" },
      },
      {
        id: "profile_and_campaign", order: 2, location: "The Longhouse (records)",
        title: "Tell Peh your name and target role", done: profileReady,
        description: "Write your profile and create your first campaign (the hunt you're on).",
        action: { method: "POST", path: "/toba/campaigns" },
      },
      {
        id: "upload_resume", order: 3, location: "The Tannery (resume)",
        title: "Upload your resume", done: resumeReady,
        description: "Upload a PDF/DOCX/RTF/TXT resume. Velum redacts PII and screens for injection.",
        action: { method: "POST", path: "/toba/resumes/upload" },
      },
      {
        id: "find_jobs", order: 4, location: "The Watchtower (job scout)",
        title: "Let Peh find your first jobs", done: jobsReady,
        description: "Run the self-driving Job Scout to discover postings for your active campaign.",
        action: { method: "POST", path: "/toba/job-scout/run" },
      },
    ];

    const completed = steps.filter(s => s.done).length;
    const nextStep = steps.find(s => !s.done) ?? null;
    return reply.send({
      ok: true,
      quest: {
        total: steps.length,
        completed,
        all_done: completed === steps.length,
        next_step: nextStep?.id ?? null,
        steps,
      },
      provider: getProviderMeta(),
      automation_mode: TOBA_AUTOMATION_MODE,
    });
  });

  // Carve a milestone receipt when a quest step lights up (called by the UI).
  server.post<{ Body: { step?: string; detail?: string } }>("/toba/setup/milestone", async (req, reply) => {
    const step = String(req.body?.step ?? "").trim();
    if (!step) return reply.status(400).send({ ok: false, error: "step required" });
    const receipt = v2.createReceipt({
      action: "onboarding_milestone",
      result_summary: `Setup quest milestone reached: ${step}${req.body?.detail ? ` — ${req.body.detail}` : ""}`,
    });
    return reply.send({ ok: true, receipt });
  });

  server.post<{ Body: { text: string; tailored_for?: string } }>("/toba/onboarding/resume", async (req, reply) => {
    const resumeText = req.body?.text ?? "";
    if (!resumeText || resumeText.length < 20) {
      return reply.status(400).send({ ok: false, error: "Resume text too short. Provide at least 20 characters." });
    }

    const velumResult = TobaV2DB.velumReview(resumeText, "resume");
    const resume = v2.createResume(velumResult.output, undefined, req.body?.tailored_for, {
      uploaded_at: new Date().toISOString(),
      source: "text",
      extracted_length: velumResult.output.length,
      velum_reviewed: 1,
      velum_redacted: velumResult.redacted ? 1 : 0,
      velum_fields_redacted: JSON.stringify(velumResult.fields_redacted),
      summary: makeResumeSummary(velumResult.output),
    });

    v2.updateOnboarding({ resume_uploaded: true, resume_id: resume.id });

    v2.createReceipt({
      action: "resume_ingest",
      velum_reviewed: true,
      velum_redacted: velumResult.redacted,
      result_summary: `Resume ingested during onboarding (${resumeText.length} chars). Velum: ${velumResult.fields_redacted.length} fields redacted.`,
    });

    v2.createReceipt({
      action: "velum_review",
      velum_reviewed: true,
      velum_redacted: velumResult.redacted,
      result_summary: `Resume Velum review: ${velumResult.fields_redacted.length} fields redacted [${velumResult.fields_redacted.join(", ") || "none"}]`,
    });

    return reply.send({
      ok: true,
      resume,
      velum: {
        reviewed: true,
        redacted: velumResult.redacted,
        fields_redacted: velumResult.fields_redacted,
        original_length: velumResult.original_length,
        redacted_length: velumResult.redacted_length,
      },
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Ping
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/ping", async (_req, reply) => {
    return reply.send({ pong: true, timestamp: Date.now() });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V1 — Career Profile
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/profile", async (_req, reply) => reply.send({ ok: true, profile: v1.getProfile() }));

  server.patch<{ Body: Record<string, unknown> }>("/toba/profile", async (req, reply) => {
    const body = req.body ?? {};
    const profilePatch: Record<string, unknown> = {};
    const profileFields = [
      "name", "email", "phone", "title", "summary", "location",
      "work_preference", "preferred_locations", "salary_min", "salary_max",
      "years_experience", "certifications", "skills", "links_json",
      "privacy_mode", "provider_preference",
    ];
    for (const key of profileFields) {
      if (body[key] === undefined) continue;
      profilePatch[key] = ["salary_min", "salary_max", "years_experience"].includes(key)
        ? numberOrNull(body[key])
        : body[key];
    }
    const targetRoles = listToJson(body["target_roles"]);
    if (targetRoles !== undefined) profilePatch["target_roles"] = targetRoles;
    for (const key of ["dream_job", "gap_analysis", "constraints_json", "cover_employer", "cover_role", "cover_industry", "nda_active"]) {
      if (body[key] !== undefined) profilePatch[key] = body[key];
    }
    if (Object.keys(profilePatch).length > 0) v2.updateProfileV2(profilePatch);
    const updated = v1.updateProfile(profilePatch);

    const onboardingPatch: Record<string, unknown> = {};
    if (body["name"] !== undefined) onboardingPatch["name"] = body["name"] || null;
    if (body["target_roles"] !== undefined) {
      const roles = listToJson(body["target_roles"]);
      onboardingPatch["preferred_titles"] = roles ? (JSON.parse(roles) as string[]).join(", ") : null;
    }
    for (const key of ["work_preference", "preferred_locations", "salary_min", "salary_max", "years_experience", "certifications", "privacy_mode"]) {
      if (body[key] !== undefined) {
        onboardingPatch[key] = ["salary_min", "salary_max", "years_experience"].includes(key)
          ? numberOrNull(body[key])
          : body[key] || null;
      }
    }
    if (Object.keys(onboardingPatch).length > 0) v2.updateOnboarding(onboardingPatch);
    return reply.send({ ok: true, profile: updated, profile_v2: v2.getProfileV2(), onboarding: v2.getOnboarding() });
  });

  server.post("/toba/profile/clear", async (_req, reply) => {
    const profile = v1.clearProfile();
    const onboarding = v2.clearOnboarding();
    return reply.send({ ok: true, profile, onboarding });
  });

  server.delete("/toba/profile", async (_req, reply) => {
    const profile = v1.clearProfile();
    const onboarding = v2.clearOnboarding();
    return reply.send({ ok: true, profile, onboarding });
  });

  server.get("/toba/experience", async (_req, reply) => reply.send({ ok: true, experience: v1.listExperience() }));

  server.post<{ Body: { company: string; role: string; start_date: string; end_date?: string; description: string; highlights?: string[]; is_current?: boolean } }>("/toba/experience", async (req, reply) => {
    const entry = v1.addExperience({ ...req.body, highlights: req.body.highlights ?? [], is_current: req.body.is_current ?? false, end_date: req.body.end_date ?? null });
    return reply.status(201).send({ ok: true, entry });
  });

  server.get("/toba/certifications", async (_req, reply) => reply.send({ ok: true, certifications: v1.listCertifications() }));

  server.patch<{ Params: { id: string }; Body: Partial<{ status: "complete" | "in_progress" | "planned"; date_completed: string | null; notes: string }> }>("/toba/certifications/:id", async (req, reply) => {
    const updated = v1.updateCertification(parseInt(req.params.id), req.body);
    if (!updated) return reply.status(404).send({ error: "Certification not found" });
    return reply.send({ ok: true, certification: updated });
  });

  server.get("/toba/projects", async (_req, reply) => reply.send({ ok: true, projects: v1.listProjects() }));

  server.post<{ Body: { name: string; tagline: string; description: string; tech_stack?: string[]; status?: string; portfolio_worthy?: boolean; resume_bullet: string; archivum_entry_id?: string } }>("/toba/projects", async (req, reply) => {
    const project = v1.addProject({ ...req.body, tech_stack: req.body.tech_stack ?? [], status: (req.body.status ?? "active") as "active" | "complete" | "vision", portfolio_worthy: req.body.portfolio_worthy ?? true, archivum_entry_id: req.body.archivum_entry_id ?? null });
    return reply.status(201).send({ ok: true, project });
  });

  server.get("/toba/skills", async (_req, reply) => reply.send({ ok: true, skills: v1.listSkills() }));

  server.get("/toba/export/resume", async (_req, reply) => {
    const text = v1.exportResume();
    return reply.header("Content-Type", "text/plain").send(text);
  });

  server.get("/toba/export/portfolio", async (_req, reply) => {
    const text = v1.exportPortfolio();
    return reply.header("Content-Type", "text/markdown").send(text);
  });

  server.get("/toba/products", async (_req, reply) => reply.send({ ok: true, products: v1.listProducts() }));

  server.post<{ Body: Omit<TobaProduct, "id"> }>("/toba/products", async (req, reply) => {
    const product = v1.addProduct(req.body);
    return reply.send({ ok: true, product });
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/toba/products/:id", async (req, reply) => {
    const updated = v1.updateProduct(parseInt(req.params.id), req.body);
    if (!updated) return reply.status(404).send({ ok: false, error: "Product not found" });
    return reply.send({ ok: true, product: updated });
  });

  server.get("/toba/export/products", async (_req, reply) => {
    const text = v1.exportProducts();
    return reply.header("Content-Type", "text/markdown").send(text);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V2 — Career Command Center
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/dashboard", async (_req, reply) => {
    return reply.send({ ok: true, dashboard: v2.getDashboard() });
  });

  // Campaigns
  server.get("/toba/campaigns", async (_req, reply) => {
    return reply.send({ ok: true, campaigns: v2.listCampaigns() });
  });

  server.delete("/toba/campaigns", async (_req, reply) => {
    return reply.send({ ok: true, cleared: v2.clearCampaigns() });
  });

  server.post<{ Body: { name: string; target_role: string } }>("/toba/campaigns", async (req, reply) => {
    const { name, target_role } = req.body ?? {};
    if (!name || !target_role) return reply.status(400).send({ ok: false, error: "name and target_role required" });
    const campaign = v2.createCampaign(name, target_role);
    v2.createReceipt({
      action: "campaign_create",
      campaign_id: campaign.id,
      result_summary: `Created campaign "${campaign.name}" targeting "${campaign.target_role}"`,
    });
    return reply.send({ ok: true, campaign });
  });

  server.get<{ Params: { id: string } }>("/toba/campaigns/:id", async (req, reply) => {
    const campaign = v2.getCampaign(req.params.id);
    if (!campaign) return reply.status(404).send({ ok: false, error: "Campaign not found" });
    const effective_context = v2.effectiveCampaignContext(req.params.id, v1);
    return reply.send({ ok: true, campaign, effective_context });
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/toba/campaigns/:id", async (req, reply) => {
    // Validate enum-bound fields so the editor can't smuggle invalid values.
    const body = req.body ?? {};
    if (body["work_preference"] != null && body["work_preference"] !== "") {
      const v = String(body["work_preference"]).toLowerCase();
      if (!["remote", "hybrid", "onsite", "any"].includes(v)) {
        return reply.status(400).send({ ok: false, code: "invalid_work_preference",
          error: `work_preference must be one of: remote, hybrid, onsite, any (got "${body["work_preference"]}")` });
      }
      body["work_preference"] = v;
    }
    if (body["phase"] != null && body["phase"] !== "") {
      const v = String(body["phase"]).toLowerCase();
      if (!["research", "applying", "interviewing", "negotiating", "closed"].includes(v)) {
        return reply.status(400).send({ ok: false, code: "invalid_phase",
          error: `phase must be one of: research, applying, interviewing, negotiating, closed` });
      }
      body["phase"] = v;
    }
    if (body["preferred_locations"] != null && !Array.isArray(body["preferred_locations"])) {
      return reply.status(400).send({ ok: false, code: "invalid_locations",
        error: "preferred_locations must be a JSON array of strings" });
    }
    const before = v2.getCampaign(req.params.id);
    if (!before) return reply.status(404).send({ ok: false, error: "Campaign not found" });
    const updated = v2.updateCampaign(req.params.id, body as never);
    const changed = Object.keys(body).filter(k => (before as unknown as Record<string, unknown>)[k] !== (updated as unknown as Record<string, unknown>)[k]);
    v2.createReceipt({
      action: "application_update", // reuse — this is a campaign-strategy edit; no dedicated action exists pre-v7
      campaign_id: req.params.id,
      result_summary: `Campaign ${req.params.id.slice(0,8)} updated: ${changed.join(", ") || "(no changes)"}`,
    });
    const effective_context = v2.effectiveCampaignContext(req.params.id, v1);
    return reply.send({ ok: true, campaign: updated, effective_context });
  });

  server.post<{ Params: { id: string } }>("/toba/campaigns/:id/close", async (req, reply) => {
    const closed = v2.closeCampaign(req.params.id);
    if (!closed) return reply.status(404).send({ ok: false, error: "Campaign not found" });
    v2.createReceipt({
      action: "campaign_close",
      campaign_id: closed.id,
      result_summary: `Closed campaign "${closed.name}"`,
    });
    return reply.send({ ok: true, campaign: closed });
  });

  // Applications
  server.get("/toba/applications", async (req, reply) => {
    const cid = (req.query as Record<string, string>).campaign_id;
    return reply.send({ ok: true, applications: v2.listApplications(cid || undefined) });
  });

  server.delete("/toba/applications", async (_req, reply) => {
    return reply.send({ ok: true, cleared: v2.clearApplications() });
  });

  server.post<{ Body: { campaign_id: string; company: string; role: string; url?: string; salary_range?: string; match_score?: number; notes?: string; source?: string; location?: string; remote?: string } }>("/toba/applications", async (req, reply) => {
    const { campaign_id, company, role } = req.body ?? {};
    if (!campaign_id || !company || !role) return reply.status(400).send({ ok: false, error: "campaign_id, company, and role required" });
    const application = v2.createApplication(req.body);
    v2.createReceipt({
      action: "application_persist",
      campaign_id,
      result_summary: `Added application: ${company} — ${role}`,
    });
    return reply.send({ ok: true, application });
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/toba/applications/:id", async (req, reply) => {
    const updated = v2.updateApplication(req.params.id, req.body ?? {});
    if (updated) {
      v2.createReceipt({
        action: "application_update",
        campaign_id: updated.campaign_id,
        result_summary: `Updated application ${updated.company} — ${updated.role}: ${JSON.stringify(req.body).slice(0, 100)}`,
      });
    }
    return reply.send({ ok: true, application: updated });
  });

  // Resumes
  server.get("/toba/resumes", async (_req, reply) => {
    return reply.send({ ok: true, resumes: v2.listResumes() });
  });

  server.delete("/toba/resumes", async (_req, reply) => {
    const cleared = v2.clearResumes();
    v2.updateOnboarding({ resume_uploaded: false, resume_id: null });
    return reply.send({ ok: true, cleared });
  });

  server.post<{ Body: { base_resume: string; profile_version?: number; tailored_for?: string } }>("/toba/resumes/generate", async (req, reply) => {
    const { base_resume } = req.body ?? {};
    if (!base_resume) return reply.status(400).send({ ok: false, error: "base_resume required" });
    return reply.send({ ok: true, resume: v2.createResume(base_resume, req.body.profile_version, req.body.tailored_for) });
  });

  server.post<{ Body: ResumeUploadBody }>("/toba/resumes/upload", async (req, reply) => {
    let extracted: ReturnType<typeof extractResumeUpload>;
    try {
      extracted = extractResumeUpload(req.body ?? {});
    } catch (err) {
      return reply.status(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    const resumeText = extracted.text;
    if (!resumeText || resumeText.length < 20) {
      return reply.status(400).send({
        ok: false,
        error: extracted.source === "file"
          ? "Could not extract enough resume text from that file. Use a text-based PDF/DOCX/RTF/TXT file."
          : "Resume text too short. Provide at least 20 characters.",
      });
    }
    const velumResult = TobaV2DB.velumReview(resumeText, "resume");
    // ── Injection defense (velum-ai guardContext) ──────────────────────────
    // Uploaded files are untrusted context: screen for prompt-injection before
    // the text ever reaches the model. PII masking stays with velumReview above.
    const guard = guardContext(velumResult.output, "tool");
    const resume = v2.createResume(velumResult.output, undefined, req.body?.tailored_for, {
      filename: extracted.filename ?? null,
      uploaded_at: new Date().toISOString(),
      source: extracted.source,
      mime: extracted.mime ?? null,
      bytes: extracted.bytes ?? null,
      extracted_length: velumResult.output.length,
      velum_reviewed: 1,
      velum_redacted: velumResult.redacted ? 1 : 0,
      velum_fields_redacted: JSON.stringify(velumResult.fields_redacted),
      summary: makeResumeSummary(velumResult.output),
    });
    v2.updateOnboarding({ resume_uploaded: true, resume_id: resume.id });
    v2.createReceipt({
      action: "resume_ingest",
      velum_reviewed: true,
      velum_redacted: velumResult.redacted,
      result_summary: extracted.source === "file"
        ? `Resume file persisted (${extracted.filename}, ${resumeText.length} chars extracted).`
        : `Resume text persisted (${resumeText.length} chars).`,
    });
    v2.createReceipt({
      action: "velum_review",
      velum_reviewed: true,
      velum_redacted: velumResult.redacted,
      result_summary: extracted.source === "file"
        ? `Resume file uploaded (${extracted.filename}, ${resumeText.length} chars extracted). Velum: ${velumResult.fields_redacted.length} fields redacted.`
        : `Resume uploaded (${resumeText.length} chars). Velum: ${velumResult.fields_redacted.length} fields redacted.`,
    });
    if (guard.injection_detected) {
      v2.createReceipt({
        action: "velum_injection_flag",
        velum_reviewed: true,
        result_summary: `Resume upload flagged for prompt-injection (${guard.classification}, decision=${guard.decision}): ${guard.injection_flags.join(", ") || "n/a"}`,
        warnings: guard.reasons.join("; ").slice(0, 500) || null,
      });
    }
    return reply.send({
      ok: true,
      resume,
      extractedLength: resumeText.length,
      upload: {
        source: extracted.source,
        filename: extracted.filename ?? null,
        mime: extracted.mime ?? null,
        bytes: extracted.bytes ?? null,
      },
      velum: {
        reviewed: true,
        redacted: velumResult.redacted,
        fields_redacted: velumResult.fields_redacted,
        injection_detected: guard.injection_detected,
        injection_flags: guard.injection_flags,
        injection_decision: guard.decision,
      },
    });
  });

  // Resume tailoring — uses the provider to tailor a resume for a specific role.
  // The result is now PERSISTED as a toba_resume_versions row (tailoring history)
  // so it survives a refresh and can be diffed against the base resume. When the
  // optional mad-ptah bridge is on, the tailored text is QA-reviewed and the
  // findings are attached to the version row.
  server.post<{ Params: { id: string }; Body: { target_role: string; instructions?: string; application_id?: string } }>(
    "/toba/resumes/:id/tailor", async (req, reply) => {
      const resume = v2.getResume(req.params.id);
      if (!resume) return reply.status(404).send({ ok: false, error: "Resume not found" });
      const { target_role, instructions, application_id } = req.body ?? {};
      if (!target_role) return reply.status(400).send({ ok: false, error: "target_role required" });

      // Validate the application link if provided (so versions answer "which
      // resume did I send to Acme?").
      if (application_id && !v2.getApplication(application_id)) {
        return reply.status(400).send({ ok: false, error: `Application not found: ${application_id}` });
      }

      const profile = v1.getProfile();
      const profileContext = profile?.summary ? `Candidate summary: ${profile.summary}\n` : "";
      const skillsContext = profile?.skills ? `Skills: ${profile.skills}\n` : "";

      const tailorPrompt = [
        `You are a resume tailoring expert. Tailor the following resume for the role: "${target_role}".`,
        instructions ? `Additional instructions: ${instructions}` : "",
        "Rewrite the resume to highlight relevant experience, use keywords from the target role, and strengthen weak bullets with STAR format where possible.",
        "Do NOT invent experience, metrics, or qualifications the candidate doesn't have.",
        "Return ONLY the tailored resume text. No commentary.",
        "",
        profileContext + skillsContext,
        `--- ORIGINAL RESUME ---\n${resume.base_resume}`,
      ].filter(Boolean).join("\n");

      try {
        const result = await providerChat({
          messages: [{ role: "user", content: tailorPrompt }],
          max_tokens: 4096,
        });

        // Velum-review the tailored output (defensive: the model may echo PII).
        const velumResult = TobaV2DB.velumReview(result.content, "resume");

        // Optional mad-ptah pre-send QA gate on the tailored resume.
        let qaFindings: PtahFinding[] = [];
        const ptah = await reviewWithPtah("resume", velumResult.output, { target_role, ...(instructions ? { instructions } : {}) });
        if (ptah?.reviewed) {
          qaFindings = ptah.findings;
          v2.createReceipt({
            action: "ptah_review",
            result_summary: `Ptah resume QA for "${target_role}": ${qaFindings.length} finding(s)`,
          });
        }

        const version = v2.createResumeVersion({
          parent_resume_id: resume.id,
          target_role,
          application_id: application_id ?? null,
          tailored_text: velumResult.output,
          instructions: instructions ?? null,
          velum_fields_redacted: velumResult.fields_redacted,
          qa_findings: qaFindings.length > 0 ? qaFindings : null,
          provider: result.provider,
          model: result.model,
        });

        v2.createReceipt({
          action: "resume_tailor",
          provider: result.provider,
          model: result.model,
          local_mode: result.local,
          velum_reviewed: true,
          velum_redacted: velumResult.redacted,
          result_summary: `Tailored resume ${resume.id} for "${target_role}" → version ${version.id}${application_id ? ` (linked to application ${application_id})` : ""}`,
        });

        return reply.send({
          ok: true,
          original: resume.base_resume,
          tailored: velumResult.output,
          target_role,
          version,
          qa_findings: qaFindings,
          ptah_enabled: ptahEnabled(),
          velum: { reviewed: true, redacted: velumResult.redacted, fields_redacted: velumResult.fields_redacted },
          usage: result.usage ?? null,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ ok: false, error: `Tailoring failed: ${msg}` });
      }
    }
  );

  // List the tailoring history for a base resume (newest first).
  server.get<{ Params: { id: string } }>("/toba/resumes/:id/versions", async (req, reply) => {
    const resume = v2.getResume(req.params.id);
    if (!resume) return reply.status(404).send({ ok: false, error: "Resume not found" });
    const versions = v2.listResumeVersions(resume.id).map(v => ({
      ...v,
      velum_fields_redacted: v.velum_fields_redacted ? JSON.parse(v.velum_fields_redacted) : [],
      qa_findings: v.qa_findings ? JSON.parse(v.qa_findings) : [],
    }));
    return reply.send({ ok: true, base_resume: resume.base_resume, resume_id: resume.id, versions });
  });

  // Promote a tailored version into a brand-new base resume.
  server.post<{ Params: { id: string; versionId: string } }>(
    "/toba/resumes/:id/versions/:versionId/promote", async (req, reply) => {
      const resume = v2.getResume(req.params.id);
      if (!resume) return reply.status(404).send({ ok: false, error: "Resume not found" });
      const version = v2.getResumeVersion(req.params.versionId);
      if (!version || version.parent_resume_id !== resume.id) {
        return reply.status(404).send({ ok: false, error: "Resume version not found" });
      }
      const promoted = v2.createResume(version.tailored_text, resume.profile_version ?? undefined, version.target_role, {
        source: "promoted_version",
        summary: makeResumeSummary(version.tailored_text),
        velum_reviewed: 1,
        velum_redacted: 0,
        velum_fields_redacted: version.velum_fields_redacted,
      });
      v2.createReceipt({
        action: "resume_promote",
        result_summary: `Promoted version ${version.id} (tailored for "${version.target_role}") to new base resume ${promoted.id}`,
      });
      return reply.send({ ok: true, resume: promoted, promoted_from: version.id });
    }
  );

  // Resume update — save edited resume text
  server.patch<{ Params: { id: string }; Body: { base_resume?: string; tailored_for?: string; summary?: string } }>(
    "/toba/resumes/:id", async (req, reply) => {
      const updated = v2.updateResume(req.params.id, req.body ?? {});
      if (!updated) return reply.status(404).send({ ok: false, error: "Resume not found" });
      return reply.send({ ok: true, resume: updated });
    }
  );

  // Resume get — single resume by ID
  server.get("/toba/resumes/:id", async (req, reply) => {
    const resume = v2.getResume((req.params as any).id);
    if (!resume) return reply.status(404).send({ ok: false, error: "Resume not found" });
    return reply.send({ ok: true, resume });
  });

  // Outreach (stealth enforced)
  server.get("/toba/outreach", async (req, reply) => {
    const status = (req.query as Record<string, string>).status;
    return reply.send({ ok: true, outreach: v2.listOutreach(status as any || undefined) });
  });

  server.post<{ Body: { application_id?: string; type: string; subject: string; body: string } }>("/toba/outreach/stage", async (req, reply) => {
    const { type, subject, body: bodyText } = req.body ?? {};
    if (!type || !subject || !bodyText) return reply.status(400).send({ ok: false, error: "type, subject, and body required" });
    const velumResult = TobaV2DB.velumReview(bodyText, "outreach");
    let outreach = v2.stageOutreach({ ...req.body, body: velumResult.output } as any);

    // Optional mad-ptah pre-send QA gate. Findings are attached to the row and
    // shown as inline warnings on the approve screen. Bridge off → no-op.
    let qaFindings: PtahFinding[] = [];
    const ptah = await reviewWithPtah("outreach", velumResult.output, { type, subject });
    if (ptah?.reviewed) {
      qaFindings = ptah.findings;
      outreach = v2.setOutreachQaFindings(outreach.id, qaFindings) ?? outreach;
      v2.createReceipt({
        action: "ptah_review",
        result_summary: `Ptah outreach QA for "${subject}": ${qaFindings.length} finding(s)`,
      });
    }

    v2.createReceipt({
      action: "outreach_generate",
      velum_reviewed: true,
      velum_redacted: velumResult.redacted,
      result_summary: `Staged ${type}: "${subject}" (velum: ${velumResult.fields_redacted.length} redacted${qaFindings.length ? `, ptah: ${qaFindings.length} flags` : ""})`,
    });
    return reply.send({
      ok: true,
      outreach,
      qa_findings: qaFindings,
      ptah_enabled: ptahEnabled(),
      velum: { reviewed: true, redacted: velumResult.redacted, fields_redacted: velumResult.fields_redacted },
    });
  });

  server.post<{ Params: { id: string } }>("/toba/outreach/:id/approve", async (req, reply) => {
    const result = v2.approveOutreach(req.params.id);
    if (!result) return reply.status(400).send({ ok: false, error: "Can only approve staged outreach" });
    v2.createReceipt({ action: "outreach_approve", result_summary: `Approved outreach: "${result.subject}"` });
    return reply.send({ ok: true, outreach: result });
  });

  server.post<{ Params: { id: string } }>("/toba/outreach/:id/reject", async (req, reply) => {
    const ok = v2.rejectOutreach(req.params.id);
    if (!ok) return reply.status(400).send({ ok: false, error: "Can only reject staged outreach" });
    v2.createReceipt({ action: "outreach_reject", result_summary: `Rejected outreach ${req.params.id}` });
    return reply.send({ ok: true });
  });

  // Peh sessions
  server.get("/toba/peh/sessions", async (_req, reply) => {
    return reply.send({ ok: true, sessions: v2.listPehSessions() });
  });

  server.post<{ Body: { session_type?: string; type?: string } }>("/toba/peh/sessions", async (req, reply) => {
    return reply.send({ ok: true, session: v2.createPehSession((req.body?.session_type ?? req.body?.type ?? "checkin") as any) });
  });

  /**
   * Resolve the effective ProviderConfig for an agent — agent overrides win
   * over the in-process default. Returns the config plus the agent's
   * additional constraints (cloud_allowed, local_only).
   */
  function effectiveAgentConfig(agent: PehAgent | null): {
    cfg: ProviderConfig;
    agent_local_only: boolean;
    agent_cloud_allowed: boolean;
    using_fallback: boolean;
  } {
    const base = getProviderConfig();
    const cfg: ProviderConfig = { ...base };
    if (agent) {
      if (agent.provider)          cfg.provider = agent.provider;
      if (agent.model)             cfg.model    = agent.model;
      if (agent.base_url)          cfg.base_url = agent.base_url;
      else if (agent.provider && PROVIDER_REGISTRY[agent.provider]?.default_base_url && !base.base_url) {
        cfg.base_url = PROVIDER_REGISTRY[agent.provider]!.default_base_url!;
      }
      if (agent.api_key)           cfg.api_key  = agent.api_key;
      if (agent.local_only === 1)  cfg.local_only = true;
    }
    const agent_local_only    = agent?.local_only === 1;
    const agent_cloud_allowed = agent?.cloud_allowed !== 0; // null/1 = allowed; 0 = blocked
    return { cfg, agent_local_only, agent_cloud_allowed, using_fallback: false };
  }

  function buildPehContext(flags: PehContextFlags | undefined): {
    prompt: string;
    meta: {
      profile_included: boolean;
      resume_included: boolean;
      campaign_included: boolean;
      applications_included: number;
      receipts_included: number;
      velum_reviewed: boolean;
      velum_redacted: boolean;
      fields_redacted: string[];
      resume_available: boolean;
      resume_parse_status: "ok" | "missing" | "not_velum_reviewed";
    };
  } {
    const activeCampaign = v2.getActiveCampaign();
    const latestResume = v2.listResumes()[0] ?? null;
    const resumeDefault = !!latestResume && latestResume.velum_reviewed === 1;
    const include = {
      profile: flags?.profile !== false,
      campaign: flags?.campaign !== false,
      applications: flags?.applications !== false,
      receipts: flags?.receipts === true,
      resume: flags?.resume ?? resumeDefault,
    };

    const sections: string[] = [];
    const redactedFields: string[] = [];
    let contextRedacted = false;

    const addSection = (title: string, content: string) => {
      const raw = normalizeExtractedText(content);
      if (!raw) return;
      const reviewed = TobaV2DB.velumReview(raw, `peh_context_${title.toLowerCase().replace(/\s+/g, "_")}`);
      if (reviewed.redacted) {
        contextRedacted = true;
        for (const f of reviewed.fields_redacted) if (!redactedFields.includes(f)) redactedFields.push(f);
      }
      sections.push(`## ${title}\n${reviewed.output}`);
    };

    if (include.profile) {
      const profile = v1.getProfile();
      const profileV2 = v2.getProfileV2() ?? {};
      addSection("PROFILE", [
        `Name: ${profile?.name ?? "not set"}`,
        `Title: ${profile?.title ?? "not set"}`,
        `Location: ${profile?.location ?? "not set"}`,
        `Summary: ${profile?.summary ?? "not set"}`,
        `Target roles: ${parseJsonArray(profileV2["target_roles"]).join(", ") || "not set"}`,
        `Work preference: ${String(profileV2["work_preference"] ?? profile?.work_preference ?? "not set")}`,
        `Certifications: ${String(profileV2["certifications"] ?? profile?.certifications ?? "not set")}`,
        `Skills: ${String(profileV2["skills"] ?? profile?.skills ?? "not set")}`,
      ].join("\n"));
    }

    if (include.campaign && activeCampaign) {
      const eff = v2.effectiveCampaignContext(activeCampaign.id, v1);
      addSection("ACTIVE CAMPAIGN", [
        `Name: ${activeCampaign.name}`,
        `Phase: ${activeCampaign.phase}`,
        `Target roles: ${eff.target_roles.value.join(", ") || activeCampaign.target_role}`,
        `Work preference: ${eff.work_preference.value} (${eff.work_preference.source})`,
        `Locations: ${eff.locations.value.join(", ") || "not set"} (${eff.locations.source})`,
        `Salary: ${eff.salary_min.value ?? "?"} - ${eff.salary_max.value ?? "?"}`,
        `Certifications focus: ${eff.certifications.value ?? "not set"}`,
        `Notes: ${eff.notes.value ?? "none"}`,
      ].join("\n"));
    }

    let resumeParseStatus: "ok" | "missing" | "not_velum_reviewed" = "missing";
    if (latestResume) resumeParseStatus = latestResume.velum_reviewed === 1 ? "ok" : "not_velum_reviewed";
    if (include.resume && latestResume) {
      const resumeRedactedFields = parseJsonArray(latestResume.velum_fields_redacted);
      if (latestResume.velum_redacted === 1) {
        contextRedacted = true;
        for (const f of resumeRedactedFields) if (!redactedFields.includes(f)) redactedFields.push(f);
      }
      addSection("RESUME SUMMARY", [
        `Filename: ${latestResume.filename ?? "pasted text / unknown"}`,
        `Uploaded at: ${latestResume.uploaded_at ?? latestResume.created_at}`,
        `Source: ${latestResume.source ?? "unknown"}`,
        `Velum reviewed: ${latestResume.velum_reviewed === 1 ? "yes" : "unknown"}`,
        `Velum redacted fields: ${resumeRedactedFields.join(", ") || "none"}`,
        "",
        latestResume.summary || summarizeText(latestResume.base_resume, 2200),
      ].join("\n"));
    } else if (include.resume && !latestResume) {
      addSection("RESUME SUMMARY", "No parsed resume exists yet. Say: \"I can see your campaign and applications, but I don't have parsed resume text yet.\"");
    }

    let appCount = 0;
    if (include.applications && activeCampaign) {
      const apps = v2.listApplications(activeCampaign.id).slice(0, 12);
      appCount = apps.length;
      addSection("TARGET JOBS/APPLICATIONS", apps.length ? apps.map((a, i) => [
        `${i + 1}. ${a.company} - ${a.role}`,
        `   Status: ${a.status}`,
        `   Location: ${a.location ?? "not set"}; remote: ${a.remote ?? "not set"}`,
        `   URL: ${a.url ?? "not set"}`,
        `   Match score: ${a.match_score ?? "not set"}`,
        `   Source: ${a.source ?? "not set"}`,
        `   Salary: ${a.salary_range ?? "not set"}`,
        `   Notes/match reason: ${a.notes ?? "none"}`,
      ].join("\n")).join("\n\n") : "No applications/jobs are attached to the active campaign yet.");
    }

    let receiptCount = 0;
    if (include.receipts) {
      const receipts = v2.listReceipts(6);
      receiptCount = receipts.length;
      addSection("RECENT ACTIVITY", receipts.map(r => `- ${r.timestamp} ${r.action}: ${r.result_summary}`).join("\n") || "No recent receipts.");
    }

    sections.push([
      "## PRIVACY/VELUM NOTES",
      "Context above was assembled from local Toba data and Velum-reviewed before provider use.",
      "Do not claim you cannot access uploaded files when RESUME SUMMARY is present.",
      "If RESUME SUMMARY says no parsed resume exists, state that honestly and still use visible campaign/application context.",
    ].join("\n"));

    return {
      prompt: `Toba context for this Peh turn:\n\n${sections.join("\n\n")}`,
      meta: {
        profile_included: include.profile,
        resume_included: include.resume && !!latestResume,
        campaign_included: include.campaign && !!activeCampaign,
        applications_included: appCount,
        receipts_included: receiptCount,
        velum_reviewed: true,
        velum_redacted: contextRedacted,
        fields_redacted: redactedFields,
        resume_available: !!latestResume,
        resume_parse_status: resumeParseStatus,
      },
    };
  }

  /**
   * Run a Peh chat turn. Single implementation used by both the legacy
   * /toba/peh/chat (with optional body.agent_id) and the agent-scoped
   * /toba/peh/agents/:agentId/chat endpoint.
   */
  async function runPehChat(
    body: {
      session_id?: string;
      message?: string;
      messages?: ChatMessage[];
      system?: string;
      max_tokens?: number;
      temperature?: number;
      velum?: boolean;
      agent_id?: string;
      include_context?: PehContextFlags;
    },
    explicitAgent: PehAgent | null,
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const agent = explicitAgent ?? (body.agent_id ? v2.getPehAgent(body.agent_id) : null);
    if (body.agent_id && !agent) {
      return { status: 404, payload: { ok: false, error: `Peh agent not found: ${body.agent_id}` } };
    }
    if (agent && agent.enabled !== 1) {
      return { status: 400, payload: { ok: false, error: `Peh agent "${agent.id}" is disabled` } };
    }

    // ── Session resolution: find existing or create new ────────────────────
    let pehSession: PehSession | null = null;
    if (body.session_id) {
      pehSession = v2.getPehSession(body.session_id);
    }
    if (!pehSession) {
      // Try the most recent checkin session to continue a conversation
      const sessions = v2.listPehSessions();
      const recent = sessions.find(s => s.session_type === "checkin");
      if (recent) {
        pehSession = recent;
      } else {
        pehSession = v2.createPehSession("checkin");
      }
    }

    const userText = (body.message ?? "").toString();
    const explicitMessages = Array.isArray(body.messages) ? body.messages : null;
    if (!explicitMessages && !userText.trim()) {
      return { status: 400, payload: { ok: false, error: "message or messages required" } };
    }

    // Velum: Peh conversations touch career/profile data by definition. Default ON.
    const velumOn = body.velum !== false;
    const messages: ChatMessage[] = [];
    const systemPrompt = body.system ?? agent?.system_prompt ?? null;
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    const pehContext = buildPehContext(body.include_context);
    messages.push({ role: "system", content: pehContext.prompt });

    const fieldsRedacted: string[] = [];
    for (const f of pehContext.meta.fields_redacted) if (!fieldsRedacted.includes(f)) fieldsRedacted.push(f);
    let redacted = pehContext.meta.velum_redacted;
    // ── Load session history for context ───────────────────────────────
    if (pehSession && !explicitMessages) {
      try {
        const history: Array<{ role: string; content: string }> = JSON.parse(pehSession.messages || "[]");
        // Load all previous messages (user + assistant) as context
        for (const m of history) {
          if (m.role === "user" || m.role === "assistant") {
            messages.push({ role: m.role as "user" | "assistant", content: m.content });
          }
        }
      } catch { /* corrupted session history — start fresh */ }
    }

    // ── Current user message ───────────────────────────────────────────
    if (explicitMessages) {
      for (const m of explicitMessages) {
        if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") continue;
        let content = String(m.content ?? "");
        if (velumOn && m.role === "user") {
          const vr = TobaV2DB.velumReview(content, "peh_chat");
          content = vr.output;
          if (vr.redacted) { redacted = true; for (const f of vr.fields_redacted) if (!fieldsRedacted.includes(f)) fieldsRedacted.push(f); }
        }
        messages.push({ role: m.role, content });
      }
    } else {
      let content = userText;
      if (velumOn) {
        const vr = TobaV2DB.velumReview(content, "peh_chat");
        content = vr.output;
        if (vr.redacted) { redacted = true; fieldsRedacted.push(...vr.fields_redacted); }
      }
      messages.push({ role: "user", content });
    }

    if (velumOn) {
      v2.createReceipt({
        action: "velum_review",
        velum_reviewed: true,
        velum_redacted: redacted,
        peh_agent_id: agent?.id ?? null,
        result_summary: `Peh ${agent?.id ?? "chat"} Velum review: ${fieldsRedacted.length} fields redacted [${fieldsRedacted.join(", ") || "none"}]`,
      });
    }

    const eff = effectiveAgentConfig(agent);
    let cfg = eff.cfg;
    let usingFallback = false;

    // Per-agent guard: cloud_allowed=0 blocks cloud providers for this agent.
    if (!eff.agent_cloud_allowed && !providerIsLocal(cfg.provider)) {
      // If agent has a fallback configured, switch to it; otherwise reject.
      if (agent?.fallback_provider) {
        cfg = { ...cfg, provider: agent.fallback_provider, model: agent.fallback_model ?? cfg.model };
        if (PROVIDER_REGISTRY[cfg.provider]?.default_base_url && !cfg.base_url) {
          cfg = { ...cfg, base_url: PROVIDER_REGISTRY[cfg.provider]!.default_base_url! };
        }
        usingFallback = true;
        if (!providerIsLocal(cfg.provider)) {
          return { status: 403, payload: { ok: false, code: "agent_cloud_blocked",
            error: `Peh agent "${agent.id}" has cloud_allowed=false and its fallback "${cfg.provider}" is also cloud. Configure a local fallback.` } };
        }
      } else {
        return { status: 403, payload: { ok: false, code: "agent_cloud_blocked",
          error: `Peh agent "${agent?.id}" has cloud_allowed=false but the selected provider "${cfg.provider}" is cloud. Configure a local provider for this agent or set fallback_provider.` } };
      }
    }

    try {
      const maxTokens = body.max_tokens ?? agent?.max_tokens ?? undefined;
      const temperature = body.temperature ?? agent?.temperature ?? undefined;

      // ── Tool-aware chat path ────────────────────────────────────────────
      // If the agent has tools, use the tool-calling loop instead of plain chat.
      const agentTools = agent ? getToolsForAgent(agent.id) : [];
      const useToolChat = agent && agentTools.length > 0 && providerSupportsTools(cfg.provider);

      let resultContent: string;
      let resultProvider: string;
      let resultModel: string;
      let resultLocal: boolean;
      let resultFinishReason: string | undefined;
      let resultUsage: { input_tokens?: number; output_tokens?: number } | undefined;
      let toolCallsMade = 0;
      let toolsUsedList: string[] = [];

      if (useToolChat) {
        // Build tool-aware messages
        const toolMessages: ToolChatMessage[] = messages.map(m => ({
          role: m.role as "system" | "user" | "assistant",
          content: m.content,
        }));

        const toolResult = await toolChat({
          messages: toolMessages,
          tools: agentTools,
          ...(maxTokens !== undefined && maxTokens !== null ? { max_tokens: maxTokens } : {}),
          ...(temperature !== undefined && temperature !== null ? { temperature } : {}),
        }, cfg);

        resultContent = toolResult.content;
        resultProvider = toolResult.provider;
        resultModel = toolResult.model;
        resultLocal = toolResult.local;
        resultFinishReason = toolResult.finish_reason;
        resultUsage = toolResult.usage;
        toolCallsMade = toolResult.tool_calls_made;
        toolsUsedList = toolResult.tools_used;
      } else {
        // Standard chat path (no tools)
        const chatReq: { messages: ChatMessage[]; max_tokens?: number; temperature?: number } = {
          messages,
        };
        if (maxTokens !== undefined && maxTokens !== null) chatReq.max_tokens = maxTokens;
        if (temperature !== undefined && temperature !== null) chatReq.temperature = temperature;

        const plainResult = await providerChat(chatReq, cfg);
        resultContent = plainResult.content;
        resultProvider = plainResult.provider;
        resultModel = plainResult.model;
        resultLocal = plainResult.local;
        resultFinishReason = plainResult.finish_reason;
        resultUsage = plainResult.usage;
      }

      v2.createReceipt({
        action: agent ? "peh_agent_chat" : "model_call",
        provider: resultProvider,
        model: resultModel,
        local_mode: resultLocal,
        velum_reviewed: velumOn,
        velum_redacted: redacted,
        peh_agent_id: agent?.id ?? null,
        result_summary: `Peh ${agent ? agent.id : "chat"}: ${resultProvider}/${resultModel} (${resultContent.length} chars${resultFinishReason ? `, ${resultFinishReason}` : ""})${usingFallback ? " [fallback]" : ""}${toolCallsMade > 0 ? `, ${toolCallsMade} tool calls` : ""}`,
      });

      // ── Persist conversation to Peh session ─────────────────────────────
      if (pehSession) {
        if (userText.trim()) {
          v2.appendPehMessage(pehSession.id, "user", userText);
        }
        v2.appendPehMessage(pehSession.id, "assistant", resultContent);
      }

      return {
        status: 200,
        payload: {
          ok: true,
          reply: resultContent,
          session_id: pehSession?.id ?? null,
          agent: agent ? { id: agent.id, display_name: agent.display_name } : null,
          provider: { provider: resultProvider, model: resultModel, local: resultLocal, fallback_used: usingFallback },
          velum: velumOn ? { reviewed: true, redacted, fields_redacted: fieldsRedacted } : { reviewed: false },
          context: pehContext.meta,
          ...(resultUsage ? { usage: resultUsage } : {}),
          ...(resultFinishReason ? { finish_reason: resultFinishReason } : {}),
          ...(toolCallsMade > 0 ? { tools: { calls_made: toolCallsMade, tools_used: toolsUsedList } } : {}),
        },
      };
    } catch (err) {
      const isProviderErr = err instanceof ProviderError;
      const status = isProviderErr ? err.statusCode : 502;
      const code = isProviderErr ? err.code : "provider_call_failed";
      const msg = err instanceof Error ? err.message : String(err);
      v2.createReceipt({
        action: agent ? "peh_agent_chat" : "model_call",
        provider: cfg.provider,
        model: cfg.model,
        local_mode: providerIsLocal(cfg.provider),
        velum_reviewed: velumOn,
        velum_redacted: redacted,
        peh_agent_id: agent?.id ?? null,
        result_summary: `Peh ${agent ? agent.id : "chat"} failed: ${code}`,
        errors: msg.slice(0, 500),
      });
      void usingFallback;
      return {
        status,
        payload: {
          ok: false,
          error: msg,
          code,
          agent: agent ? { id: agent.id, display_name: agent.display_name } : null,
          provider: { provider: cfg.provider, model: cfg.model, local: providerIsLocal(cfg.provider) },
          context: pehContext.meta,
          hint: cfg.provider === "none"
            ? "Configure a provider: set TOBA_PROVIDER and TOBA_MODEL, or POST /toba/provider with {provider, model}."
            : undefined,
        },
      };
    }
  }

  server.post<{ Body: {
    session_id?: string;
    message?: string;
    messages?: ChatMessage[];
    system?: string;
    max_tokens?: number;
    temperature?: number;
    velum?: boolean;
    agent_id?: string;
    include_context?: PehContextFlags;
  } }>("/toba/peh/chat", async (req, reply) => {
    const result = await runPehChat(req.body ?? {}, null);
    return reply.status(result.status).send(result.payload);
  });

  // ───── Peh agent registry ──────────────────────────────────────────────────

  server.get("/toba/peh/agents", async (_req, reply) => {
    const agents = v2.listPehAgents().map(a => TobaV2DB.sanitizePehAgent(a));
    return reply.send({ ok: true, agents, default_provider: getProviderStatus() });
  });

  server.get<{ Params: { id: string } }>("/toba/peh/agents/:id", async (req, reply) => {
    const agent = v2.getPehAgent(req.params.id);
    if (!agent) return reply.status(404).send({ ok: false, error: `Peh agent not found: ${req.params.id}` });
    return reply.send({ ok: true, agent: TobaV2DB.sanitizePehAgent(agent), default_provider: getProviderStatus() });
  });

  const patchAgent = async (
    req: { params: { id: string }; body?: Record<string, unknown> | null },
    reply: { status: (n: number) => { send: (b: unknown) => unknown }; send: (b: unknown) => unknown },
  ) => {
    const b = req.body ?? {};
    const id = req.params.id;
    const existing = v2.getPehAgent(id);
    if (!existing) return reply.status(404).send({ ok: false, error: `Peh agent not found: ${id}` });

    // Validate provider if supplied.
    if (typeof b["provider"] === "string" && !PROVIDER_REGISTRY[(b["provider"] as string).toLowerCase()]) {
      return reply.status(400).send({ ok: false, code: "unknown_provider",
        error: `Unknown provider "${b["provider"]}". Available: ${Object.keys(PROVIDER_REGISTRY).join(", ")}.` });
    }
    if (typeof b["fallback_provider"] === "string" && b["fallback_provider"] !== "" &&
        !PROVIDER_REGISTRY[(b["fallback_provider"] as string).toLowerCase()]) {
      return reply.status(400).send({ ok: false, code: "unknown_provider",
        error: `Unknown fallback provider "${b["fallback_provider"]}".` });
    }
    // Local-only contradiction: agent local_only=1 with cloud provider.
    const nextProvider = (typeof b["provider"] === "string" ? (b["provider"] as string).toLowerCase() : existing.provider) ?? null;
    const nextLocalOnly = (typeof b["local_only"] === "boolean" ? (b["local_only"] ? 1 : 0)
      : typeof b["local_only"] === "number" ? (b["local_only"] ? 1 : 0) : existing.local_only);
    if (nextLocalOnly === 1 && nextProvider && !PROVIDER_REGISTRY[nextProvider]?.local) {
      return reply.status(400).send({ ok: false, code: "local_only_violation",
        error: `Cannot set local_only=true on agent "${id}" with cloud provider "${nextProvider}".` });
    }
    // Global local_only blocks cloud per-agent providers too.
    if (getProviderConfig().local_only && nextProvider && !PROVIDER_REGISTRY[nextProvider]?.local) {
      return reply.status(400).send({ ok: false, code: "local_only_violation",
        error: `Global TOBA_LOCAL_ONLY=true blocks cloud provider "${nextProvider}" for agent "${id}".` });
    }

    const patch: Partial<PehAgent> = {};
    const passthrough = ["display_name", "role", "provider", "model", "base_url", "api_key",
      "temperature", "max_tokens", "system_prompt", "fallback_provider", "fallback_model"];
    for (const k of passthrough) {
      if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k];
    }
    for (const k of ["enabled", "local_only", "cloud_allowed"]) {
      if (b[k] !== undefined) {
        const v = b[k];
        (patch as Record<string, unknown>)[k] = typeof v === "boolean" ? (v ? 1 : 0) : v === null ? null : Number(v) ? 1 : 0;
      }
    }
    const updated = v2.updatePehAgent(id, patch);
    v2.createReceipt({
      action: "peh_agent_update",
      peh_agent_id: id,
      provider: updated?.provider ?? null,
      model: updated?.model ?? null,
      local_mode: updated?.local_only === 1 || (updated?.provider ? PROVIDER_REGISTRY[updated.provider]?.local ?? false : true),
      result_summary: `Peh agent ${id} updated: ${Object.keys(patch).join(", ") || "(no changes)"}`,
    });
    return reply.send({ ok: true, agent: updated ? TobaV2DB.sanitizePehAgent(updated) : null });
  };
  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/toba/peh/agents/:id", patchAgent as never);
  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/toba/peh/agents/:id/provider", patchAgent as never);

  server.post<{ Params: { id: string }; Body: {
    session_id?: string;
    message?: string;
    messages?: ChatMessage[];
    system?: string;
    max_tokens?: number;
    temperature?: number;
    velum?: boolean;
    include_context?: PehContextFlags;
  } }>("/toba/peh/agents/:id/chat", async (req, reply) => {
    const agent = v2.getPehAgent(req.params.id);
    if (!agent) return reply.status(404).send({ ok: false, error: `Peh agent not found: ${req.params.id}` });
    const result = await runPehChat(req.body ?? {}, agent);
    return reply.status(result.status).send(result.payload);
  });

  // Profile V2 extensions
  server.get("/toba/profile/v2", async (_req, reply) => {
    return reply.send({ ok: true, profile: v2.getProfileV2() });
  });

  server.patch<{ Body: Record<string, unknown> }>("/toba/profile/v2", async (req, reply) => {
    v2.updateProfileV2(req.body ?? {});
    return reply.send({ ok: true, profile: v2.getProfileV2() });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Analytics
  // ═══════════════════════════════════════════════════════════════════════════

  server.get<{ Params: { id: string } }>("/toba/analytics/campaign/:id", async (req, reply) => {
    const analytics = v2.getCampaignAnalytics(req.params.id);
    if (!analytics) return reply.status(404).send({ ok: false, error: "Campaign not found" });
    v2.createReceipt({
      action: "insight_generate",
      campaign_id: req.params.id,
      local_mode: true,
      result_summary: `Generated ${analytics.insights.length} insights for campaign "${analytics.campaign_name}"`,
    });
    return reply.send({ ok: true, analytics });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Automation Queue
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/automation", async (req, reply) => {
    const status = (req.query as Record<string, string>).status as AutomationStatus | undefined;
    return reply.send({ ok: true, tasks: v2.listAutomationTasks(status || undefined), mode: TOBA_AUTOMATION_MODE });
  });

  server.delete("/toba/automation", async (_req, reply) => {
    return reply.send({ ok: true, cleared: v2.clearAutomation() });
  });

  server.post<{ Body: { kind: string; title: string; detail?: string; campaign_id?: string; application_id?: string; schedule?: string } }>("/toba/automation", async (req, reply) => {
    const { kind, title } = req.body ?? {};
    if (!kind || !title) return reply.status(400).send({ ok: false, error: "kind and title required" });
    const task = v2.createAutomationTask(req.body as any);
    v2.createReceipt({
      action: "automation_create",
      campaign_id: req.body.campaign_id,
      result_summary: `Automation task created: "${title}" (${kind})`,
    });
    return reply.send({ ok: true, task });
  });

  server.post<{ Params: { id: string } }>("/toba/automation/:id/approve", async (req, reply) => {
    const resolved = v2.resolveAutomationTask(req.params.id, "approved");
    if (!resolved) return reply.status(400).send({ ok: false, error: "Cannot approve this task (invalid state)" });
    v2.createReceipt({
      action: "automation_approve",
      campaign_id: resolved.campaign_id,
      result_summary: `Approved automation: "${resolved.title}"`,
    });
    return reply.send({ ok: true, task: resolved });
  });

  server.post<{ Params: { id: string } }>("/toba/automation/:id/reject", async (req, reply) => {
    const resolved = v2.resolveAutomationTask(req.params.id, "rejected");
    if (!resolved) return reply.status(400).send({ ok: false, error: "Cannot reject this task (invalid state)" });
    v2.createReceipt({
      action: "automation_reject",
      campaign_id: resolved.campaign_id,
      result_summary: `Rejected automation: "${resolved.title}"`,
    });
    return reply.send({ ok: true, task: resolved });
  });

  server.post<{ Params: { id: string } }>("/toba/automation/:id/execute", async (req, reply) => {
    const resolved = v2.resolveAutomationTask(req.params.id, "executed");
    if (!resolved) return reply.status(400).send({ ok: false, error: "Can only execute approved tasks" });
    v2.createReceipt({
      action: "automation_execute",
      campaign_id: resolved.campaign_id,
      result_summary: `Executed automation: "${resolved.title}"`,
    });
    return reply.send({ ok: true, task: resolved });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Velum (review/redact)
  // ═══════════════════════════════════════════════════════════════════════════

  server.post<{ Body: { text: string; context?: string } }>("/toba/velum/review", async (req, reply) => {
    const { text, context } = req.body ?? {};
    if (!text) return reply.status(400).send({ ok: false, error: "text required" });
    const result = TobaV2DB.velumReview(text, context);
    v2.createReceipt({
      action: "velum_review",
      velum_reviewed: true,
      velum_redacted: result.redacted,
      result_summary: `Velum review (${context ?? "general"}): ${result.fields_redacted.length} fields redacted`,
    });
    return reply.send({ ok: true, velum: result });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Receipts
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/receipts", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = parseInt(q.limit ?? "50", 10);
    const action = q.action as ReceiptAction | undefined;
    return reply.send({ ok: true, receipts: v2.listReceipts(limit, action) });
  });

  server.delete("/toba/receipts", async (_req, reply) => {
    return reply.send({ ok: true, cleared: v2.clearReceipts() });
  });

  server.post<{ Body: { keep_provider_config?: boolean; dry_run?: boolean } }>("/toba/reset", async (req, reply) => {
    if (req.body?.dry_run) {
      return reply.send({
        ok: true,
        dry_run: true,
        would_clear: ["profile", "onboarding", "resumes", "campaigns", "applications", "receipts", "automation", "peh sessions"],
      });
    }
    const profile = v1.clearProfile();
    const cleared = v2.resetPersonalData({ keepProviderConfig: !!req.body?.keep_provider_config });
    return reply.send({ ok: true, cleared, profile, onboarding: v2.getOnboarding() });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Provider/Model Config
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/provider", async (_req, reply) => {
    return reply.send({ ok: true, provider: getProviderStatus() });
  });

  // Reports where the active provider config came from (env|file|default), a
  // secret-free view of it, and whether it is persisted across restarts (C3).
  server.get("/toba/provider/status", async (_req, reply) => {
    return reply.send({ ok: true, ...getProviderRuntimeStatus() });
  });

  // Runtime selection — applied in-process AND persisted to state/provider-config.json
  // (audit C3) so operator changes survive restarts. Env vars remain defaults that a
  // persisted file overrides. The response carries `persisted` so callers know it stuck.
  const applyProvider = async (
    req: { body?: Record<string, unknown> | null },
    reply: { status: (n: number) => { send: (b: unknown) => unknown }; send: (b: unknown) => unknown },
  ) => {
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof b["provider"] === "string") patch["provider"] = b["provider"];
    if (typeof b["model"] === "string") patch["model"] = b["model"];
    if (typeof b["base_url"] === "string") patch["base_url"] = b["base_url"];
    if (typeof b["api_key"] === "string") patch["api_key"] = b["api_key"];
    if (typeof b["local_only"] === "boolean") patch["local_only"] = b["local_only"];
    try {
      const next = applyConfigPatch(patch);
      const persisted = persistProviderConfig();
      return reply.send({ ok: true, provider: next, persisted });
    } catch (err) {
      if (err instanceof ProviderError) {
        return reply.status(err.statusCode).send({ ok: false, error: err.message, code: err.code });
      }
      throw err;
    }
  };
  server.patch<{ Body: Record<string, unknown> }>("/toba/provider", applyProvider as never);
  server.post<{ Body: Record<string, unknown> }>("/toba/provider", applyProvider as never);

  // ═══════════════════════════════════════════════════════════════════════════
  // Job Scout (campaign-aware query derivation — standalone)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/job-scout/context", async (_req, reply) => {
    // ── Per-field source tracing — see effectiveCampaignContext for the ladder.
    //    No silent inference: every field reports {value, source}. Default
    //    work_preference is "any" (NOT "remote"); locations default to [].
    const eff = v2.effectiveCampaignContext(null, v1);
    return reply.send({
      ok: true,
      // Job Scout is standalone: it derives search context from local DB and
      // returns it for use by an external tool (manual or semi-manual ingestion
      // via POST /toba/job-scout/ingest). Live external job search is not
      // implemented in-process — Toba does not crawl boards itself.
      live_search_implemented: false,
      ingestion_mode: "manual_or_external_tool",
      effective: eff,
      context: {
        // ── Resolved (back-compat — same field names as before, with values from `effective`) ──
        campaign_id: eff.campaign_id,
        campaign_name: eff.campaign_name,
        primary_target_role: eff.target_roles.value[0] ?? null,
        all_target_roles: eff.target_roles.value,
        // `location` used to be a scalar; keep it for back-compat but prefer `locations` array.
        location: eff.locations.value[0] ?? null,
        locations: eff.locations.value,
        remote_preference: eff.work_preference.value,        // "any" by default — NOT "remote"
        salary_range: (eff.salary_min.value != null || eff.salary_max.value != null)
          ? { min: eff.salary_min.value, max: eff.salary_max.value } : null,
        certifications: eff.certifications.value,
        years_experience_target: eff.years_experience_target.value,
        notes: eff.notes.value,
        provider: getProviderMeta(),
      },
    });
  });

  server.post<{ Body: { lane_id?: string; jobs: Array<{ company: string; role: string; url?: string; salary_range?: string; match_score?: number; match_reason?: string; source?: string; location?: string; remote?: string }> } }>("/toba/job-scout/ingest", async (req, reply) => {
    const { jobs, lane_id } = req.body ?? {};
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return reply.status(400).send({ ok: false, error: "jobs array required" });
    }
    const activeCampaign = v2.getActiveCampaign();
    if (!activeCampaign) {
      return reply.status(400).send({ ok: false, error: "No active campaign to ingest jobs into" });
    }

    // Validate lane_id if provided
    if (lane_id) {
      const lane = v2.getSearchLane(lane_id);
      if (!lane) {
        return reply.status(400).send({ ok: false, error: `Search lane not found: ${lane_id}` });
      }
      if (lane.campaign_id !== activeCampaign.id) {
        return reply.status(400).send({ ok: false, error: "Search lane does not belong to the active campaign" });
      }
    }

    const persisted = [];
    const skippedDuplicates: string[] = [];
    for (const job of jobs) {
      if (!job.company || !job.role) continue;
      const fp = TobaV2DB.jobFingerprint(job.company, job.role, job.url);
      if (v2.hasFingerprint(fp)) {
        skippedDuplicates.push(`${job.company} — ${job.role}`);
        continue;
      }
      const app = v2.createApplication({
        campaign_id: activeCampaign.id,
        company: job.company,
        role: job.role,
        url: job.url,
        salary_range: job.salary_range,
        match_score: job.match_score,
        notes: job.match_reason ? `Match: ${job.match_reason}` : undefined,
        source: job.source,
        location: job.location,
        remote: job.remote,
        lane_id: lane_id,
      });
      persisted.push(app);
    }

    const provStatus = getProviderStatus();
    v2.createReceipt({
      action: "job_scout_run",
      campaign_id: activeCampaign.id,
      provider: provStatus.provider,
      model: provStatus.model,
      local_mode: provStatus.local,
      result_summary: `Job Scout ingested ${persisted.length}/${jobs.length} jobs into campaign "${activeCampaign.name}"${lane_id ? ` (lane: ${lane_id})` : ""}${skippedDuplicates.length > 0 ? `. ${skippedDuplicates.length} duplicates skipped.` : ""}`,
    });

    return reply.send({
      ok: true,
      ingested: persisted.length,
      duplicates_skipped: skippedDuplicates.length,
      campaign_id: activeCampaign.id,
      lane_id: lane_id ?? null,
      applications: persisted,
    });
  });

  // ── Self-driving Job Scout: search + extract + score via the analyst ──────
  // Closes the loop the old hard-coded `live_search_implemented: false` left
  // open. Uses the job-scout-analyst tool-chat (web_search + web_extract) over
  // each active lane's ready-made search_queries, screens extracted postings for
  // prompt-injection (velum guardContext), and — per the no-auto-submission data
  // contract — STAGES discovered jobs as toba_automation tasks for approval when
  // TOBA_AUTOMATION_MODE=approval-required (the default). In other modes it feeds
  // results straight into the dedup-aware ingest path.
  server.post<{ Body: { lane_ids?: string[]; max_jobs_per_lane?: number } }>("/toba/job-scout/run", async (req, reply) => {
    const activeCampaign = v2.getActiveCampaign();
    if (!activeCampaign) {
      return reply.status(400).send({ ok: false, error: "No active campaign — create one before running the scout." });
    }

    const agent = v2.getPehAgent("job-scout-analyst");
    if (!agent || agent.enabled !== 1) {
      return reply.status(400).send({ ok: false, error: "job-scout-analyst agent is missing or disabled." });
    }

    // Resolve which lanes to scan first — nothing to scout short-circuits before
    // we worry about provider capabilities.
    let lanes = v2.getActiveSearchLanes(activeCampaign.id);
    if (Array.isArray(req.body?.lane_ids) && req.body.lane_ids.length > 0) {
      const wanted = new Set(req.body.lane_ids);
      lanes = lanes.filter(l => wanted.has(l.id));
    }
    if (lanes.length === 0) {
      return reply.send({ ok: true, ran: false, reason: "no_lanes", discovered: 0, staged: 0, ingested: 0,
        message: "No active search lanes to scout. Create a lane first." });
    }

    const eff = effectiveAgentConfig(agent);
    if (!providerSupportsTools(eff.cfg.provider)) {
      return reply.status(422).send({
        ok: false,
        ran: false,
        reason: "provider_no_tools",
        error: `The job-scout-analyst provider "${eff.cfg.provider}" does not support tool calling. Configure a tool-capable provider (e.g. openai, openrouter) for live search.`,
      });
    }

    const maxPerLane = Math.min(10, Math.max(1, Number(req.body?.max_jobs_per_lane) || 5));
    const tools = getToolsForAgent("job-scout-analyst");
    const profile = v1.getProfile();
    const profileBlurb = [profile?.title, profile?.summary, profile?.skills].filter(Boolean).join(" · ").slice(0, 600);

    const discovered: Array<Record<string, unknown>> = [];
    const injectionFlagged: string[] = [];
    const laneErrors: Array<{ lane: string; error: string }> = [];

    for (const lane of lanes) {
      const titles = JSON.parse(lane.target_titles || "[]") as string[];
      const keywords = JSON.parse(lane.keywords || "[]") as string[];
      const locs = JSON.parse(lane.locations || "[]") as string[];
      const queries = titles.flatMap(t => {
        const q = [`${t} ${keywords.join(" ")}`.trim()];
        for (const loc of locs.length > 0 ? locs : ["remote"]) q.push(`${t} ${loc}`.trim());
        return q;
      }).slice(0, 6);

      const sys = `${agent.system_prompt ?? "You analyze job postings for fit and legitimacy."}\n\n` +
        `Use web_search (detailed=true) and web_extract to find REAL, currently-open job postings for the lane below. ` +
        `Score each posting 0-100 for fit against the candidate, and grade legitimacy. ` +
        `Return ONLY a JSON array (no prose) of at most ${maxPerLane} objects with keys: ` +
        `company, role, url, salary_range, match_score (0-100), match_reason, location, remote, posting_excerpt. ` +
        `posting_excerpt must be a short verbatim snippet of the posting text you extracted.`;
      const user = `Candidate: ${profileBlurb || "(profile sparse)"}\n` +
        `Lane "${lane.name}" (${lane.priority}). Target titles: ${titles.join(", ") || "n/a"}. ` +
        `Keywords: ${keywords.join(", ") || "n/a"}. Locations: ${locs.join(", ") || "remote"}.\n` +
        `Search queries to try: ${queries.join(" | ")}`;

      try {
        const result = await toolChat({
          messages: [{ role: "system", content: sys }, { role: "user", content: user }],
          tools,
          max_tokens: 3000,
        }, eff.cfg);

        const jobs = parseJobsFromModel(result.content);
        for (const job of jobs.slice(0, maxPerLane)) {
          // ── Injection defense on the extracted posting content ──
          const screenText = `${job.role ?? ""} ${job.company ?? ""} ${job.match_reason ?? ""} ${job.posting_excerpt ?? ""}`.trim();
          const guard = guardContext(screenText, "tool");
          const flags = guard.injection_detected ? guard.injection_flags : [];
          if (guard.injection_detected) {
            injectionFlagged.push(`${job.company ?? "?"} — ${job.role ?? "?"}`);
            v2.createReceipt({
              action: "velum_injection_flag",
              campaign_id: activeCampaign.id,
              result_summary: `Job posting "${job.company ?? "?"} — ${job.role ?? "?"}" flagged for prompt-injection (${guard.classification}): ${flags.join(", ") || "n/a"}`,
              warnings: guard.reasons.join("; ").slice(0, 500) || null,
            });
          }
          discovered.push({ ...job, lane_id: lane.id, lane_name: lane.name, injection_flags: flags });
        }
      } catch (err) {
        laneErrors.push({ lane: lane.name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const provStatus = getProviderStatus();
    // Dedup against existing pipeline.
    const fresh = discovered.filter(j => {
      const company = String(j.company ?? "").trim();
      const role = String(j.role ?? "").trim();
      if (!company || !role) return false;
      const fp = TobaV2DB.jobFingerprint(company, role, j.url ? String(j.url) : undefined);
      return !v2.hasFingerprint(fp);
    });

    const approvalRequired = TOBA_AUTOMATION_MODE === "approval-required";
    let stagedTasks: unknown[] = [];
    let ingested: unknown[] = [];

    if (approvalRequired) {
      // Stage each discovered job as an approval task — never auto-create an
      // application (respects the no-auto-submission data contract).
      stagedTasks = fresh.map(j => v2.createAutomationTask({
        kind: "job_scout",
        title: `Review discovered job: ${j.company} — ${j.role}`,
        detail: JSON.stringify({ ...j, campaign_id: activeCampaign.id }),
        campaign_id: activeCampaign.id,
      }));
    } else {
      ingested = fresh.map(j => v2.createApplication({
        campaign_id: activeCampaign.id,
        company: String(j.company),
        role: String(j.role),
        url: j.url ? String(j.url) : undefined,
        salary_range: j.salary_range ? String(j.salary_range) : undefined,
        match_score: typeof j.match_score === "number" ? j.match_score : undefined,
        notes: j.match_reason ? `Match: ${j.match_reason}` : undefined,
        source: "job_scout_run",
        location: j.location ? String(j.location) : undefined,
        remote: j.remote ? String(j.remote) : undefined,
        lane_id: String(j.lane_id),
      }));
    }

    v2.createReceipt({
      action: "job_scout_run",
      campaign_id: activeCampaign.id,
      provider: provStatus.provider,
      model: provStatus.model,
      local_mode: provStatus.local,
      result_summary: `Job Scout run over ${lanes.length} lane(s): ${discovered.length} discovered, ${fresh.length} fresh, ${approvalRequired ? `${stagedTasks.length} staged for approval` : `${ingested.length} ingested`}${injectionFlagged.length ? `, ${injectionFlagged.length} injection-flagged` : ""}.`,
      warnings: laneErrors.length ? laneErrors.map(e => `${e.lane}: ${e.error}`).join("; ").slice(0, 500) : null,
    });

    return reply.send({
      ok: true,
      ran: true,
      automation_mode: TOBA_AUTOMATION_MODE,
      campaign_id: activeCampaign.id,
      lanes_scanned: lanes.length,
      discovered: discovered.length,
      fresh: fresh.length,
      duplicates_skipped: discovered.length - fresh.length,
      injection_flagged: injectionFlagged,
      lane_errors: laneErrors,
      staged: approvalRequired ? stagedTasks.length : 0,
      ingested: approvalRequired ? 0 : ingested.length,
      staged_tasks: approvalRequired ? stagedTasks : [],
      applications: approvalRequired ? [] : ingested,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Search Lanes
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/lanes", async (req, reply) => {
    const cid = (req.query as Record<string, string>).campaign_id;
    return reply.send({ ok: true, lanes: v2.listSearchLanes(cid || undefined) });
  });

  server.get<{ Params: { id: string } }>("/toba/lanes/:id", async (req, reply) => {
    const lane = v2.getSearchLane(req.params.id);
    if (!lane) return reply.status(404).send({ ok: false, error: "Lane not found" });
    return reply.send({ ok: true, lane });
  });

  server.post<{ Body: { campaign_id: string; name: string; target_titles?: string[]; keywords?: string[]; negative_keywords?: string[]; locations?: string[]; remote_preference?: string; source_filters?: string[]; priority?: LanePriority } }>("/toba/lanes", async (req, reply) => {
    const { campaign_id, name } = req.body ?? {};
    if (!campaign_id || !name) return reply.status(400).send({ ok: false, error: "campaign_id and name required" });
    const lane = v2.createSearchLane(req.body);
    v2.createReceipt({ action: "campaign_create", campaign_id, result_summary: `Search lane created: "${name}" (${req.body.priority ?? "primary"})` });
    return reply.status(201).send({ ok: true, lane });
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/toba/lanes/:id", async (req, reply) => {
    const updated = v2.updateSearchLane(req.params.id, req.body ?? {});
    if (!updated) return reply.status(404).send({ ok: false, error: "Lane not found" });
    return reply.send({ ok: true, lane: updated });
  });

  server.delete<{ Params: { id: string } }>("/toba/lanes/:id", async (req, reply) => {
    const ok = v2.deleteSearchLane(req.params.id);
    if (!ok) return reply.status(404).send({ ok: false, error: "Lane not found" });
    return reply.send({ ok: true });
  });

  // Lane-aware job scout context
  server.get("/toba/job-scout/lane-context", async (_req, reply) => {
    const activeCampaign = v2.getActiveCampaign();
    if (!activeCampaign) return reply.send({ ok: true, context: null, lanes: [] });

    const lanes = v2.getActiveSearchLanes(activeCampaign.id);
    const profile = v1.getProfile();
    const onboarding = v2.getOnboarding();

    const laneContexts = lanes.map(lane => {
      const titles = JSON.parse(lane.target_titles) as string[];
      const keywords = JSON.parse(lane.keywords) as string[];
      const negKw = JSON.parse(lane.negative_keywords) as string[];
      const locs = JSON.parse(lane.locations) as string[];
      return {
        lane_id: lane.id,
        lane_name: lane.name,
        priority: lane.priority,
        target_titles: titles,
        keywords,
        negative_keywords: negKw,
        locations: locs.length > 0 ? locs : [profile?.location ?? onboarding?.preferred_locations?.split(/[,;]+/)[0]?.trim() ?? "Remote"],
        remote_preference: lane.remote_preference ?? onboarding?.work_preference ?? null,
        search_queries: titles.flatMap(t => {
          const queries = [`${t} ${keywords.join(" ")}`.trim()];
          for (const loc of locs.length > 0 ? locs : ["remote"]) {
            queries.push(`${t} ${loc}`.trim());
          }
          return queries;
        }),
      };
    });

    return reply.send({
      ok: true,
      campaign_id: activeCampaign.id,
      campaign_name: activeCampaign.name,
      lanes: laneContexts,
      certifications: onboarding?.certifications ?? null,
      salary_range: onboarding?.salary_min || onboarding?.salary_max
        ? { min: onboarding.salary_min, max: onboarding.salary_max } : null,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Job Evaluations (A-G report)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/evaluations", async (req, reply) => {
    const appId = (req.query as Record<string, string>).application_id;
    return reply.send({ ok: true, evaluations: v2.listJobEvaluations(appId || undefined) });
  });

  server.get<{ Params: { id: string } }>("/toba/evaluations/:id", async (req, reply) => {
    const ev = v2.getJobEvaluation(req.params.id);
    if (!ev) return reply.status(404).send({ ok: false, error: "Evaluation not found" });
    return reply.send({ ok: true, evaluation: ev });
  });

  server.post<{ Body: { application_id: string; role_summary: string; fit_analysis: string; gap_strategy?: string; compensation_notes?: string; resume_plan?: string; interview_prep?: string; legitimacy_grade?: EvalGrade; overall_grade?: EvalGrade } }>("/toba/evaluations", async (req, reply) => {
    const { application_id, role_summary, fit_analysis } = req.body ?? {};
    if (!application_id || !role_summary || !fit_analysis) {
      return reply.status(400).send({ ok: false, error: "application_id, role_summary, and fit_analysis required" });
    }
    const evaluation = v2.createJobEvaluation(req.body);
    v2.createReceipt({
      action: "insight_generate",
      result_summary: `Job evaluation created for application ${application_id}: overall=${req.body.overall_grade ?? "C"}, legitimacy=${req.body.legitimacy_grade ?? "C"}`,
    });
    return reply.status(201).send({ ok: true, evaluation });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Interview Story Bank
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/stories", async (_req, reply) => {
    return reply.send({ ok: true, stories: v2.listStories() });
  });

  server.get<{ Params: { id: string } }>("/toba/stories/:id", async (req, reply) => {
    const story = v2.getStory(req.params.id);
    if (!story) return reply.status(404).send({ ok: false, error: "Story not found" });
    return reply.send({ ok: true, story });
  });

  server.post<{ Body: { title: string; format?: StoryFormat; situation: string; task: string; action: string; result: string; reflection?: string; linked_project_ids?: number[]; linked_experience_ids?: number[]; tags?: string[] } }>("/toba/stories", async (req, reply) => {
    const { title, situation, task, action, result } = req.body ?? {};
    if (!title || !situation || !task || !action || !result) {
      return reply.status(400).send({ ok: false, error: "title, situation, task, action, and result required" });
    }
    const story = v2.createStory(req.body);
    v2.createReceipt({ action: "insight_generate", result_summary: `Interview story added: "${title}" (${req.body.format ?? "star"})` });
    return reply.status(201).send({ ok: true, story });
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/toba/stories/:id", async (req, reply) => {
    const updated = v2.updateStory(req.params.id, req.body ?? {});
    if (!updated) return reply.status(404).send({ ok: false, error: "Story not found" });
    return reply.send({ ok: true, story: updated });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Follow-up Cadence
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/follow-ups/stale", async (req, reply) => {
    const days = parseInt((req.query as Record<string, string>).days ?? "7", 10);
    const stale = v2.getStaleApplications(days);
    return reply.send({ ok: true, stale_applications: stale, days });
  });

  server.post<{ Params: { id: string } }>("/toba/applications/:id/follow-up", async (req, reply) => {
    const updated = v2.recordFollowUp(req.params.id);
    if (!updated) return reply.status(404).send({ ok: false, error: "Application not found" });
    v2.createReceipt({ action: "application_update", campaign_id: updated.campaign_id, result_summary: `Follow-up recorded for ${updated.company} — ${updated.role} (#${(updated as any).follow_up_count})` });
    return reply.send({ ok: true, application: updated });
  });

  server.post<{ Params: { id: string }; Body: { days: number } }>("/toba/applications/:id/cadence", async (req, reply) => {
    const days = req.body?.days;
    if (!days || days < 1) return reply.status(400).send({ ok: false, error: "days >= 1 required" });
    const updated = v2.setFollowUpCadence(req.params.id, days);
    if (!updated) return reply.status(404).send({ ok: false, error: "Application not found" });
    return reply.send({ ok: true, application: updated });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Application Legitimacy
  // ═══════════════════════════════════════════════════════════════════════════

  server.patch<{ Params: { id: string }; Body: { legitimacy_tier?: string; date_first_seen?: string; date_expired?: string; apply_url_status?: string } }>("/toba/applications/:id/legitimacy", async (req, reply) => {
    const updated = v2.updateApplicationLegitimacy(req.params.id, req.body ?? {});
    if (!updated) return reply.status(404).send({ ok: false, error: "Application not found" });
    return reply.send({ ok: true, application: updated });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tracker Applications (for application-tracker agent)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/toba/tracker/applications", async (req, reply) => {
    const status = (req.query as Record<string, string>).status as TrackerAppStatus | undefined;
    const apps = listTrackerApps(toolDb, status || undefined);
    return reply.send({ ok: true, applications: apps, count: apps.length });
  });

  server.get<{ Params: { id: string } }>("/toba/tracker/applications/:id", async (req, reply) => {
    const app = getTrackerApp(toolDb, req.params.id);
    if (!app) return reply.status(404).send({ ok: false, error: "Tracker application not found" });
    return reply.send({ ok: true, application: app });
  });

  server.post<{ Body: { company: string; position: string; url?: string; date_applied?: string; status?: TrackerAppStatus; follow_up_date?: string; notes?: string } }>("/toba/tracker/applications", async (req, reply) => {
    const { company, position } = req.body ?? {};
    if (!company || !position) return reply.status(400).send({ ok: false, error: "company and position required" });
    const { createTrackerApp } = await import("./tools/applications.js");
    const app = createTrackerApp(toolDb, req.body!);
    return reply.status(201).send({ ok: true, application: app });
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/toba/tracker/applications/:id", async (req, reply) => {
    const updated = updateTrackerApp(toolDb, req.params.id, req.body as Parameters<typeof updateTrackerApp>[2]);
    if (!updated) return reply.status(404).send({ ok: false, error: "Tracker application not found" });
    return reply.send({ ok: true, application: updated });
  });

  server.delete<{ Params: { id: string } }>("/toba/tracker/applications/:id", async (req, reply) => {
    const deleted = deleteTrackerApp(toolDb, req.params.id);
    if (!deleted) return reply.status(404).send({ ok: false, error: "Tracker application not found" });
    return reply.send({ ok: true, deleted: true });
  });

  // ── Tool info for agents ─────────────────────────────────────────────────
  server.get<{ Params: { id: string } }>("/toba/peh/agents/:id/tools", async (req, reply) => {
    const agent = v2.getPehAgent(req.params.id);
    if (!agent) return reply.status(404).send({ ok: false, error: `Peh agent not found: ${req.params.id}` });
    const tools = getToolsForAgent(agent.id);
    return reply.send({
      ok: true,
      agent_id: agent.id,
      has_tools: tools.length > 0,
      tools: tools.map(t => ({ name: t.function.name, description: t.function.description })),
    });
  });
}
