/**
 * Cursus Native Provider Registry
 * ================================
 * Standalone provider/model selection. No dependency on Squidley.
 *
 * Built-in providers:
 *   - "none"      — no provider configured (returns friendly unconfigured errors)
 *   - "echo"      — local debugging provider; echoes the last user message
 *   - "ollama"    — local Ollama daemon (OpenAI-compatible /api/chat shape)
 *   - "openai"    — OpenAI-compatible /v1/chat/completions
 *   - "anthropic" — Anthropic /v1/messages
 *   - "openrouter"— OpenAI-compatible via OpenRouter
 *
 * Local providers (no network/API key): "none", "echo", "ollama".
 * All others are treated as cloud and blocked when CURSUS_LOCAL_ONLY=true.
 *
 * Env vars (defaults):
 *   CURSUS_PROVIDER           = "none"
 *   CURSUS_MODEL              = "none"
 *   CURSUS_PROVIDER_BASE_URL  = ""       (alias: CURSUS_PROVIDER_API_BASE)
 *   CURSUS_PROVIDER_API_KEY   = ""       (never echoed in status)
 *   CURSUS_LOCAL_ONLY         = "false"  (when true, cloud providers are rejected)
 */
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export type ProviderId = "none" | "echo" | "ollama" | "openai" | "anthropic" | "openrouter" | string;

export interface ProviderDef {
  id: ProviderId;
  label: string;
  local: boolean;
  requires_api_key: boolean;
  requires_base_url: boolean;
  default_base_url?: string;
}

export const PROVIDER_REGISTRY: Record<string, ProviderDef> = {
  none:       { id: "none",       label: "Unconfigured",                 local: true,  requires_api_key: false, requires_base_url: false },
  echo:       { id: "echo",       label: "Local echo (debug)",           local: true,  requires_api_key: false, requires_base_url: false },
  ollama:     { id: "ollama",     label: "Ollama (local daemon)",        local: true,  requires_api_key: false, requires_base_url: false, default_base_url: "http://127.0.0.1:11434" },
  openai:     { id: "openai",     label: "OpenAI",                       local: false, requires_api_key: true,  requires_base_url: false, default_base_url: "https://api.openai.com" },
  anthropic:  { id: "anthropic",  label: "Anthropic",                    local: false, requires_api_key: true,  requires_base_url: false, default_base_url: "https://api.anthropic.com" },
  openrouter: { id: "openrouter", label: "OpenRouter (OpenAI-compat)",   local: false, requires_api_key: true,  requires_base_url: false, default_base_url: "https://openrouter.ai/api" },
};

export interface ProviderConfig {
  provider: string;
  model: string;
  base_url: string;     // resolved (env or registry default), never the secret
  api_key: string;      // present only in memory; never returned by status
  local_only: boolean;
}

export interface ProviderStatus {
  provider: string;
  provider_label: string;
  model: string;
  local: boolean;            // is the selected provider local?
  local_only_mode: boolean;  // is CURSUS_LOCAL_ONLY=true?
  configured: boolean;       // does the provider have everything it needs to run?
  configuration_issues: string[];
  base_url: string | null;   // safe to show; "" -> null
  api_key_set: boolean;      // boolean only, never the secret itself
  available_providers: Array<{ id: string; label: string; local: boolean; default_base_url?: string }>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  provider: string;
  model: string;
  local: boolean;
  finish_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class ProviderError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

// ── Config (in-process, runtime mutable) ────────────────────────────────────

function defaultConfigFromEnv(): ProviderConfig {
  const provider = (process.env["CURSUS_PROVIDER"] ?? "none").toLowerCase();
  const model = process.env["CURSUS_MODEL"] ?? "none";
  const base_url =
    process.env["CURSUS_PROVIDER_BASE_URL"] ??
    process.env["CURSUS_PROVIDER_API_BASE"] ??
    PROVIDER_REGISTRY[provider]?.default_base_url ??
    "";
  const api_key = process.env["CURSUS_PROVIDER_API_KEY"] ?? "";
  const local_only = (process.env["CURSUS_LOCAL_ONLY"] ?? "").toLowerCase() === "true";
  return { provider, model, base_url, api_key, local_only };
}

let currentConfig: ProviderConfig = defaultConfigFromEnv();

export function getConfig(): ProviderConfig {
  return { ...currentConfig };
}

export function resetConfigFromEnv(): ProviderConfig {
  currentConfig = defaultConfigFromEnv();
  return getConfig();
}

export function isLocalProvider(providerId: string = currentConfig.provider): boolean {
  return PROVIDER_REGISTRY[providerId]?.local ?? false;
}

export function getConfigurationIssues(cfg: ProviderConfig = currentConfig): string[] {
  const issues: string[] = [];
  const def = PROVIDER_REGISTRY[cfg.provider];
  if (!def) {
    issues.push(`Unknown provider "${cfg.provider}". Set CURSUS_PROVIDER to one of: ${Object.keys(PROVIDER_REGISTRY).join(", ")}.`);
    return issues;
  }
  if (cfg.provider === "none") {
    issues.push("No provider configured. Set CURSUS_PROVIDER and CURSUS_MODEL (e.g. CURSUS_PROVIDER=ollama, CURSUS_MODEL=llama3).");
    return issues;
  }
  if (!cfg.model || cfg.model === "none") {
    issues.push(`Model not set. Set CURSUS_MODEL for provider "${cfg.provider}".`);
  }
  if (def.requires_api_key && !cfg.api_key) {
    issues.push(`Provider "${cfg.provider}" requires an API key. Set CURSUS_PROVIDER_API_KEY.`);
  }
  if (def.requires_base_url && !cfg.base_url) {
    issues.push(`Provider "${cfg.provider}" requires a base URL. Set CURSUS_PROVIDER_BASE_URL.`);
  }
  if (cfg.local_only && !def.local) {
    issues.push(`CURSUS_LOCAL_ONLY=true blocks cloud provider "${cfg.provider}". Choose a local provider (none, echo, ollama).`);
  }
  return issues;
}

export function getStatus(): ProviderStatus {
  const cfg = currentConfig;
  const def = PROVIDER_REGISTRY[cfg.provider];
  const issues = getConfigurationIssues(cfg);
  return {
    provider: cfg.provider,
    provider_label: def?.label ?? `Unknown (${cfg.provider})`,
    model: cfg.model,
    local: isLocalProvider(cfg.provider),
    local_only_mode: cfg.local_only,
    configured: cfg.provider !== "none" && issues.length === 0,
    configuration_issues: issues,
    base_url: cfg.base_url || null,
    api_key_set: cfg.api_key.length > 0,
    available_providers: Object.values(PROVIDER_REGISTRY).map(d => ({
      id: d.id, label: d.label, local: d.local,
      ...(d.default_base_url ? { default_base_url: d.default_base_url } : {}),
    })),
  };
}

export interface ProviderPatch {
  provider?: string;
  model?: string;
  base_url?: string;
  api_key?: string;
  local_only?: boolean;
}

export function applyConfigPatch(patch: ProviderPatch): ProviderStatus {
  const next: ProviderConfig = { ...currentConfig };
  if (patch.provider !== undefined) {
    const id = patch.provider.toLowerCase();
    if (!PROVIDER_REGISTRY[id]) {
      throw new ProviderError(400, "unknown_provider", `Unknown provider "${patch.provider}". Available: ${Object.keys(PROVIDER_REGISTRY).join(", ")}.`);
    }
    next.provider = id;
    // If switching provider, fill base_url from registry default unless caller supplied one.
    if (patch.base_url === undefined) {
      next.base_url = PROVIDER_REGISTRY[id]!.default_base_url ?? "";
    }
  }
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.base_url !== undefined) next.base_url = patch.base_url;
  if (patch.api_key !== undefined) next.api_key = patch.api_key;
  if (patch.local_only !== undefined) next.local_only = !!patch.local_only;

  if (next.local_only && !isLocalProvider(next.provider)) {
    throw new ProviderError(400, "local_only_violation",
      `CURSUS_LOCAL_ONLY=true blocks cloud provider "${next.provider}". Choose a local provider (none, echo, ollama) or disable local-only mode.`);
  }
  currentConfig = next;
  return getStatus();
}

// ── HTTP helper (no external deps) ──────────────────────────────────────────

interface HttpResult { status: number; body: string }

function httpJson(method: string, urlStr: string, headers: Record<string, string>, payload: unknown, timeoutMs = 60_000): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? httpsRequest : request;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = lib({
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        ...headers,
        ...(body ? { "content-length": Buffer.byteLength(body).toString() } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error(`Request to ${url.host} timed out after ${timeoutMs}ms`)); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Adapters ────────────────────────────────────────────────────────────────

async function chatEcho(req: ChatRequest, cfg: ProviderConfig): Promise<ChatResponse> {
  const lastUser = [...req.messages].reverse().find(m => m.role === "user")?.content ?? "";
  return {
    content: `[echo:${cfg.model || "none"}] ${lastUser}`,
    provider: "echo",
    model: cfg.model || "echo",
    local: true,
    finish_reason: "stop",
  };
}

async function chatOllama(req: ChatRequest, cfg: ProviderConfig): Promise<ChatResponse> {
  const base = cfg.base_url || "http://127.0.0.1:11434";
  const res = await httpJson("POST", `${base.replace(/\/$/, "")}/api/chat`, {}, {
    model: cfg.model,
    messages: req.messages,
    stream: false,
    options: {
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.max_tokens !== undefined ? { num_predict: req.max_tokens } : {}),
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new ProviderError(502, "ollama_error", `Ollama returned ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(res.body) as { message?: { content?: string }; done_reason?: string };
  return {
    content: parsed.message?.content ?? "",
    provider: "ollama",
    model: cfg.model,
    local: true,
    finish_reason: parsed.done_reason,
  };
}

async function chatOpenAICompat(req: ChatRequest, cfg: ProviderConfig, providerId: "openai" | "openrouter"): Promise<ChatResponse> {
  const base = cfg.base_url || PROVIDER_REGISTRY[providerId]!.default_base_url!;
  const path = providerId === "openrouter" ? "/v1/chat/completions" : "/v1/chat/completions";
  const res = await httpJson("POST", `${base.replace(/\/$/, "")}${path}`, {
    "authorization": `Bearer ${cfg.api_key}`,
  }, {
    model: cfg.model,
    messages: req.messages,
    ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new ProviderError(502, `${providerId}_error`, `${providerId} returned ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(res.body) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = parsed.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    provider: providerId,
    model: cfg.model,
    local: false,
    finish_reason: choice?.finish_reason,
    usage: parsed.usage ? { input_tokens: parsed.usage.prompt_tokens, output_tokens: parsed.usage.completion_tokens } : undefined,
  };
}

async function chatAnthropic(req: ChatRequest, cfg: ProviderConfig): Promise<ChatResponse> {
  const base = cfg.base_url || "https://api.anthropic.com";
  // Anthropic separates system from messages.
  const systemMsgs = req.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const nonSystem = req.messages.filter(m => m.role !== "system");
  const res = await httpJson("POST", `${base.replace(/\/$/, "")}/v1/messages`, {
    "x-api-key": cfg.api_key,
    "anthropic-version": "2023-06-01",
  }, {
    model: cfg.model,
    max_tokens: req.max_tokens ?? 1024,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(systemMsgs ? { system: systemMsgs } : {}),
    messages: nonSystem,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new ProviderError(502, "anthropic_error", `Anthropic returned ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(res.body) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (parsed.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("");
  return {
    content: text,
    provider: "anthropic",
    model: cfg.model,
    local: false,
    finish_reason: parsed.stop_reason,
    usage: parsed.usage,
  };
}

// ── Public entry point ─────────────────────────────────────────────────────

export async function chat(req: ChatRequest, overrides?: Partial<ProviderConfig>): Promise<ChatResponse> {
  const cfg: ProviderConfig = { ...currentConfig, ...(overrides ?? {}) };
  const issues = getConfigurationIssues(cfg);
  if (cfg.provider === "none") {
    throw new ProviderError(503, "provider_unconfigured",
      "No provider configured. Set CURSUS_PROVIDER and CURSUS_MODEL, or POST /cursus/provider with {provider, model}. " +
      "Local options: ollama, echo. Cloud options: openai, anthropic, openrouter (require CURSUS_PROVIDER_API_KEY).");
  }
  if (issues.length > 0) {
    throw new ProviderError(503, "provider_misconfigured", issues.join(" "));
  }
  if (cfg.local_only && !isLocalProvider(cfg.provider)) {
    throw new ProviderError(403, "local_only_violation",
      `CURSUS_LOCAL_ONLY=true blocks cloud provider "${cfg.provider}". Switch to a local provider or disable local-only mode.`);
  }
  switch (cfg.provider) {
    case "echo":       return chatEcho(req, cfg);
    case "ollama":     return chatOllama(req, cfg);
    case "openai":     return chatOpenAICompat(req, cfg, "openai");
    case "openrouter": return chatOpenAICompat(req, cfg, "openrouter");
    case "anthropic":  return chatAnthropic(req, cfg);
    default:
      throw new ProviderError(400, "unknown_provider", `Provider "${cfg.provider}" has no adapter.`);
  }
}
