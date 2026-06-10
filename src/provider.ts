/**
 * Toba Native Provider Registry
 * ==============================
 * Standalone provider/model selection.
 *
 * Built-in providers:
 *   - "none"      — no provider configured (returns friendly unconfigured errors)
 *   - "echo"      — local debugging provider; echoes the last user message
 *   - "ollama"    — local Ollama daemon (OpenAI-compatible /api/chat shape)
 *   - "openai"    — OpenAI-compatible /v1/chat/completions
 *   - "anthropic" — Anthropic /v1/messages
 *   - "openrouter"— OpenAI-compatible via OpenRouter (e.g. deepseek/deepseek-v4-pro)
 *
 * Local providers (no network/API key): "none", "echo", "ollama".
 * All others are treated as cloud and blocked when TOBA_LOCAL_ONLY=true.
 *
 * Env vars (TOBA_* preferred, CURSUS_* accepted as fallback):
 *   TOBA_PROVIDER             = "none"
 *   TOBA_MODEL                = "none"
 *   TOBA_PROVIDER_BASE_URL    = ""       (alias: TOBA_PROVIDER_API_BASE)
 *   TOBA_PROVIDER_API_KEY     = ""       (never echoed in status)
 *   TOBA_LOCAL_ONLY           = "false"  (when true, cloud providers are rejected)
 *
 * OpenRouter-specific:
 *   TOBA_OPENROUTER_API_KEY   — preferred API key env for openrouter
 *   TOBA_OPENROUTER_REFERER   — optional HTTP-Referer header
 *   TOBA_OPENROUTER_TITLE     — optional X-Title header (default "Toba")
 *
 * Per-call overrides:
 *   The `chat(req, overrides)` entry point accepts a partial config that wins over
 *   the in-process default. Per-agent Peh selection uses this to route specific
 *   agents to specific provider/model combinations.
 */
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ProviderId = "none" | "echo" | "ollama" | "openai" | "anthropic" | "openrouter" | "xiaomi" | string;

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
  openrouter: { id: "openrouter", label: "OpenRouter (OpenAI-compat)",   local: false, requires_api_key: true,  requires_base_url: false, default_base_url: "https://openrouter.ai/api/v1" },
  xiaomi:     { id: "xiaomi",     label: "Xiaomi MiMo Direct",            local: false, requires_api_key: true,  requires_base_url: false, default_base_url: "https://api.xiaomimimo.com/v1" },
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
  local_only_mode: boolean;  // is TOBA_LOCAL_ONLY=true?
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
  usage?: { input_tokens?: number; output_tokens?: number; cached_tokens?: number };
}

export class ProviderError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

// ── Config (in-process, runtime mutable) ────────────────────────────────────

// Env helper: TOBA_* preferred, CURSUS_* fallback
const penv = (toba: string, cursus: string) => process.env[toba] ?? process.env[cursus];

function defaultConfigFromEnv(): ProviderConfig {
  const provider = (penv("TOBA_PROVIDER", "CURSUS_PROVIDER") ?? "none").toLowerCase();
  const model = penv("TOBA_MODEL", "CURSUS_MODEL") ?? "none";
  const base_url =
    penv("TOBA_PROVIDER_BASE_URL", "CURSUS_PROVIDER_BASE_URL") ??
    penv("TOBA_PROVIDER_API_BASE", "CURSUS_PROVIDER_API_BASE") ??
    PROVIDER_REGISTRY[provider]?.default_base_url ??
    "";
  const apiKeyForProvider =
    provider === "openrouter" ? penv("TOBA_OPENROUTER_API_KEY", "CURSUS_OPENROUTER_API_KEY") :
    provider === "openai"     ? penv("TOBA_OPENAI_API_KEY", "CURSUS_OPENAI_API_KEY")     :
    provider === "anthropic"  ? penv("TOBA_ANTHROPIC_API_KEY", "CURSUS_ANTHROPIC_API_KEY")  :
    provider === "xiaomi"    ? penv("TOBA_XIAOMI_API_KEY", "CURSUS_XIAOMI_API_KEY") ?? penv("TOBA_PROVIDER_API_KEY", "CURSUS_PROVIDER_API_KEY") :
    undefined;
  const api_key = apiKeyForProvider ?? penv("TOBA_PROVIDER_API_KEY", "CURSUS_PROVIDER_API_KEY") ?? "";
  const local_only = (penv("TOBA_LOCAL_ONLY", "CURSUS_LOCAL_ONLY") ?? "").toLowerCase() === "true";
  return { provider, model, base_url, api_key, local_only };
}

// ── Persistence (audit C3) ──────────────────────────────────────────────────
// In-memory config is lost on restart, silently reverting operator changes made
// via PATCH /toba/provider. We persist to a JSON file so runtime changes survive
// restarts. Env vars are defaults; a persisted file (if present) overrides them.

export type ConfigSource = "env" | "file" | "default";

let providerConfigPath: string =
  penv("TOBA_PROVIDER_CONFIG", "CURSUS_PROVIDER_CONFIG") ?? "state/provider-config.json";

/** Override the persistence path (used by tests; production uses the default). */
export function setProviderConfigPath(path: string): void {
  providerConfigPath = path;
}
export function getProviderConfigPath(): string {
  return providerConfigPath;
}

function envSource(): ConfigSource {
  return (penv("TOBA_PROVIDER", "CURSUS_PROVIDER") ?? "") !== "" ? "env" : "default";
}

let currentConfig: ProviderConfig = defaultConfigFromEnv();
let configSource: ConfigSource = envSource();

export function getConfig(): ProviderConfig {
  return { ...currentConfig };
}

export function getConfigSource(): ConfigSource {
  return configSource;
}

export function resetConfigFromEnv(): ProviderConfig {
  currentConfig = defaultConfigFromEnv();
  configSource = envSource();
  return getConfig();
}

/**
 * Startup loader: if a persisted config file exists it overrides env defaults
 * (per-field, falling back to env for anything missing). Call once at startup.
 * Returns the resolved source so the caller can log where config came from.
 */
export function loadProviderConfig(filePath: string = providerConfigPath): ConfigSource {
  const envCfg = defaultConfigFromEnv();
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ProviderConfig>;
      currentConfig = {
        provider: (raw.provider ?? envCfg.provider).toLowerCase(),
        model: raw.model ?? envCfg.model,
        base_url: raw.base_url ?? envCfg.base_url,
        api_key: raw.api_key ?? envCfg.api_key,
        local_only: typeof raw.local_only === "boolean" ? raw.local_only : envCfg.local_only,
      };
      configSource = "file";
      return configSource;
    } catch {
      // Corrupt file — fall back to env so the service still starts.
    }
  }
  currentConfig = envCfg;
  configSource = envSource();
  return configSource;
}

/** Whether a persisted provider-config file currently exists. */
export function isConfigPersisted(filePath: string = providerConfigPath): boolean {
  return existsSync(filePath);
}

/**
 * Write the in-memory config to the persistence file (mode 0600 — it can hold
 * an API key, same sensitivity as .env). On success the active source becomes
 * "file". Returns whether the write succeeded.
 */
export function persistConfig(filePath: string = providerConfigPath): boolean {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const data = JSON.stringify(
      {
        provider: currentConfig.provider,
        model: currentConfig.model,
        base_url: currentConfig.base_url,
        api_key: currentConfig.api_key,
        local_only: currentConfig.local_only,
      },
      null,
      2,
    );
    writeFileSync(filePath, data, { mode: 0o600 });
    configSource = "file";
    return true;
  } catch {
    return false;
  }
}

/**
 * Runtime status for GET /toba/provider/status — reports where the active
 * config came from, a secret-free view of it, and whether it is persisted.
 */
export function getRuntimeStatus(): {
  source: ConfigSource;
  config: { provider: string; model: string; base_url: string | null; local_only: boolean; api_key_set: boolean };
  persisted: boolean;
} {
  const cfg = currentConfig;
  return {
    source: configSource,
    persisted: isConfigPersisted(),
    config: {
      provider: cfg.provider,
      model: cfg.model,
      base_url: cfg.base_url || null,
      local_only: cfg.local_only,
      api_key_set: cfg.api_key.length > 0,
    },
  };
}

export function isLocalProvider(providerId: string = currentConfig.provider): boolean {
  return PROVIDER_REGISTRY[providerId]?.local ?? false;
}

export function getConfigurationIssues(cfg: ProviderConfig = currentConfig): string[] {
  const issues: string[] = [];
  const def = PROVIDER_REGISTRY[cfg.provider];
  if (!def) {
    issues.push(`Unknown provider "${cfg.provider}". Set TOBA_PROVIDER to one of: ${Object.keys(PROVIDER_REGISTRY).join(", ")}.`);
    return issues;
  }
  if (cfg.provider === "none") {
    issues.push("No provider configured. Set TOBA_PROVIDER and TOBA_MODEL (e.g. TOBA_PROVIDER=ollama, TOBA_MODEL=llama3).");
    return issues;
  }
  if (!cfg.model || cfg.model === "none") {
    issues.push(`Model not set. Set TOBA_MODEL for provider "${cfg.provider}".`);
  }
  if (def.requires_api_key && !cfg.api_key) {
    issues.push(`Provider "${cfg.provider}" requires an API key. Set TOBA_PROVIDER_API_KEY.`);
  }
  if (def.requires_base_url && !cfg.base_url) {
    issues.push(`Provider "${cfg.provider}" requires a base URL. Set TOBA_PROVIDER_BASE_URL.`);
  }
  if (cfg.local_only && !def.local) {
    issues.push(`TOBA_LOCAL_ONLY=true blocks cloud provider "${cfg.provider}". Choose a local provider (none, echo, ollama).`);
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
      `TOBA_LOCAL_ONLY=true blocks cloud provider "${next.provider}". Choose a local provider (none, echo, ollama) or disable local-only mode.`);
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
  const context = req.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  return {
    content: `[echo:${cfg.model || "none"}]\n${context ? `${context}\n\n` : ""}${lastUser}`,
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

async function chatOpenAICompat(req: ChatRequest, cfg: ProviderConfig, providerId: "openai" | "openrouter" | "xiaomi"): Promise<ChatResponse> {
  const base = cfg.base_url || PROVIDER_REGISTRY[providerId]!.default_base_url!;
  // OpenAI uses /v1/chat/completions; OpenRouter's v1 is baked into its base URL,
  // so the path on OpenRouter is just /chat/completions.
  const path = providerId === "openrouter" || providerId === "xiaomi" ? "/chat/completions" : "/v1/chat/completions";
  const headers: Record<string, string> = {
    "authorization": `Bearer ${cfg.api_key}`,
  };
  if (providerId === "openrouter") {
    const referer = penv("TOBA_OPENROUTER_REFERER", "CURSUS_OPENROUTER_REFERER");
    const title = penv("TOBA_OPENROUTER_TITLE", "CURSUS_OPENROUTER_TITLE") ?? "Toba";
    if (referer) headers["HTTP-Referer"] = referer;
    headers["X-Title"] = title;
  }
  const res = await httpJson("POST", `${base.replace(/\/$/, "")}${path}`, headers, {
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
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  const choice = parsed.choices?.[0];
  const cachedTokens = parsed.usage?.prompt_tokens_details?.cached_tokens;
  if (cachedTokens !== undefined && parsed.usage?.prompt_tokens && parsed.usage.prompt_tokens > 0) {
    const hitPct = ((cachedTokens / parsed.usage.prompt_tokens) * 100).toFixed(1);
    console.log(`[toba] Cache hit: ${cachedTokens} tokens (${hitPct}% of prompt)`);
  }
  return {
    content: choice?.message?.content ?? "",
    provider: providerId,
    model: cfg.model,
    local: false,
    finish_reason: choice?.finish_reason,
    usage: parsed.usage ? { input_tokens: parsed.usage.prompt_tokens, output_tokens: parsed.usage.completion_tokens, cached_tokens: cachedTokens } : undefined,
  };
}

/**
 * Build the exact request that would go on the wire for a given provider/cfg.
 * Used by tests to verify URL/headers/body shape without making real calls.
 * Never includes the resolved API key in the returned `headers` object —
 * the bearer is replaced with a length-only placeholder.
 */
export function buildRequestPreview(cfg: ProviderConfig, req: ChatRequest): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  switch (cfg.provider) {
    case "openrouter":
    case "xiaomi":
    case "openai": {
      const providerId = cfg.provider as "openai" | "openrouter" | "xiaomi";
      const base = cfg.base_url || PROVIDER_REGISTRY[providerId]!.default_base_url!;
      const path = providerId === "openrouter" || providerId === "xiaomi" ? "/chat/completions" : "/v1/chat/completions";
      const headers: Record<string, string> = {
        "authorization": cfg.api_key ? `Bearer [REDACTED:${cfg.api_key.length}]` : "Bearer [unset]",
      };
      if (providerId === "openrouter") {
        const referer = penv("TOBA_OPENROUTER_REFERER", "CURSUS_OPENROUTER_REFERER");
        const title = penv("TOBA_OPENROUTER_TITLE", "CURSUS_OPENROUTER_TITLE") ?? "Toba";
        if (referer) headers["HTTP-Referer"] = referer;
        headers["X-Title"] = title;
      }
      return {
        url: `${base.replace(/\/$/, "")}${path}`,
        headers,
        body: {
          model: cfg.model,
          messages: req.messages,
          ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        },
      };
    }
    case "anthropic": {
      const base = cfg.base_url || "https://api.anthropic.com";
      return {
        url: `${base.replace(/\/$/, "")}/v1/messages`,
        headers: {
          "x-api-key": cfg.api_key ? `[REDACTED:${cfg.api_key.length}]` : "[unset]",
          "anthropic-version": "2023-06-01",
        },
        body: { model: cfg.model, messages: req.messages },
      };
    }
    case "ollama": {
      const base = cfg.base_url || "http://127.0.0.1:11434";
      return {
        url: `${base.replace(/\/$/, "")}/api/chat`,
        headers: {},
        body: { model: cfg.model, messages: req.messages, stream: false },
      };
    }
    default:
      return { url: "", headers: {}, body: {} };
  }
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
      "No provider configured. Set TOBA_PROVIDER and TOBA_MODEL, or POST /toba/provider with {provider, model}. " +
      "Local options: ollama, echo. Cloud options: openai, anthropic, openrouter (require TOBA_PROVIDER_API_KEY).");
  }
  if (issues.length > 0) {
    throw new ProviderError(503, "provider_misconfigured", issues.join(" "));
  }
  if (cfg.local_only && !isLocalProvider(cfg.provider)) {
    throw new ProviderError(403, "local_only_violation",
      `TOBA_LOCAL_ONLY=true blocks cloud provider "${cfg.provider}". Switch to a local provider or disable local-only mode.`);
  }
  switch (cfg.provider) {
    case "echo":       return chatEcho(req, cfg);
    case "ollama":     return chatOllama(req, cfg);
    case "openai":     return chatOpenAICompat(req, cfg, "openai");
    case "openrouter": return chatOpenAICompat(req, cfg, "openrouter");
    case "xiaomi":     return chatOpenAICompat(req, cfg, "xiaomi");
    case "anthropic":  return chatAnthropic(req, cfg);
    default:
      throw new ProviderError(400, "unknown_provider", `Provider "${cfg.provider}" has no adapter.`);
  }
}
