/**
 * Toba — Tool-Aware Chat
 * ======================
 * Extends the provider's chat functionality with tool-calling support.
 * Uses the existing provider config but makes its own HTTP calls to pass
 * the `tools` parameter for OpenAI-compatible function calling.
 *
 * The tool-calling loop:
 *   1. Send messages + tool definitions to the LLM
 *   2. If the LLM returns tool_calls, execute them
 *   3. Feed tool results back as messages
 *   4. Repeat until the LLM returns a final text response (no tool_calls)
 *   5. Max iterations to prevent infinite loops
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import {
  getConfig as getProviderConfig,
  PROVIDER_REGISTRY,
  ProviderError,
  isLocalProvider,
  type ProviderConfig,
} from "../provider.js";
import {
  executeTool,
  type OpenAITool,
  type ToolCall,
  type ToolCallResult,
} from "./registry.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ToolChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolChatRequest {
  messages: ToolChatMessage[];
  tools?: OpenAITool[];
  max_tokens?: number;
  temperature?: number;
}

export interface ToolChatResponse {
  content: string;
  tool_calls_made: number;
  tools_used: string[];
  provider: string;
  model: string;
  local: boolean;
  finish_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export const MAX_TOOL_ITERATIONS = 8;

/** Providers that support OpenAI-compatible function calling. */
export const TOOL_CAPABLE_PROVIDERS = new Set(["openai", "openrouter", "xiaomi", "groq", "mistral", "together", "deepseek"]);

/** Check if a provider supports tool calling. */
export function providerSupportsTools(provider: string): boolean {
  return TOOL_CAPABLE_PROVIDERS.has(provider);
}

// ── HTTP Helper ────────────────────────────────────────────────────────────

function httpJson(method: string, urlStr: string, headers: Record<string, string>, payload: unknown, timeoutMs = 90_000): Promise<{ status: number; body: string }> {
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

// ── OpenAI-compatible tool-calling chat ─────────────────────────────────────

interface OpenAIChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason?: string;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Make a single OpenAI-compatible API call with tool support.
 */
async function callOpenAICompat(
  cfg: ProviderConfig,
  req: ToolChatRequest,
  providerId: string,
): Promise<{ content: string; tool_calls: ToolCall[]; finish_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } }> {
  const base = cfg.base_url || PROVIDER_REGISTRY[providerId]?.default_base_url || "";
  const path = providerId === "openai" ? "/v1/chat/completions" : "/chat/completions";
  const headers: Record<string, string> = {
    "authorization": `Bearer ${cfg.api_key}`,
  };

  const payload: Record<string, unknown> = {
    model: cfg.model,
    messages: req.messages,
    ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
  if (req.tools && req.tools.length > 0) {
    payload.tools = req.tools;
  }

  const res = await httpJson("POST", `${base.replace(/\/$/, "")}${path}`, headers, payload);
  if (res.status < 200 || res.status >= 300) {
    throw new ProviderError(502, `${providerId}_error`, `${providerId} returned ${res.status}: ${res.body.slice(0, 200)}`);
  }

  const parsed = JSON.parse(res.body) as OpenAIResponse;
  const choice = parsed.choices?.[0];
  const toolCalls = (choice?.message?.tool_calls ?? []).map(tc => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }));

  return {
    content: choice?.message?.content ?? "",
    tool_calls: toolCalls,
    finish_reason: choice?.finish_reason,
    usage: parsed.usage ? { input_tokens: parsed.usage.prompt_tokens, output_tokens: parsed.usage.completion_tokens } : undefined,
  };
}

// ── Main Tool-Calling Loop ─────────────────────────────────────────────────

/**
 * Execute a tool-aware chat turn. Sends messages + tools to the LLM,
 * executes any tool calls, and loops until a final text response.
 */
export async function toolChat(
  req: ToolChatRequest,
  overrides?: Partial<ProviderConfig>,
): Promise<ToolChatResponse> {
  const cfg: ProviderConfig = { ...getProviderConfig(), ...(overrides ?? {}) };
  const issues = cfg.provider === "none"
    ? ["No provider configured"]
    : cfg.api_key ? [] : PROVIDER_REGISTRY[cfg.provider]?.requires_api_key ? ["No API key"] : [];

  if (issues.length > 0) {
    throw new ProviderError(503, "provider_misconfigured", issues.join(" "));
  }

  if (!TOOL_CAPABLE_PROVIDERS.has(cfg.provider)) {
    throw new ProviderError(400, "unsupported_provider_for_tools",
      `Provider "${cfg.provider}" does not support tool calling. Use one of: ${[...TOOL_CAPABLE_PROVIDERS].join(", ")}`);
  }

  let messages: ToolChatMessage[] = [...req.messages];
  let totalToolCalls = 0;
  const toolsUsed: string[] = [];
  let lastContent = "";
  let lastFinishReason: string | undefined;
  let totalUsage: { input_tokens?: number; output_tokens?: number } | undefined;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const result = await callOpenAICompat(cfg, { ...req, messages }, cfg.provider);

    lastContent = result.content;
    lastFinishReason = result.finish_reason;
    if (result.usage) {
      totalUsage = {
        input_tokens: (totalUsage?.input_tokens ?? 0) + (result.usage.input_tokens ?? 0),
        output_tokens: (totalUsage?.output_tokens ?? 0) + (result.usage.output_tokens ?? 0),
      };
    }

    if (result.tool_calls.length === 0) {
      // No tool calls — this is the final response
      return {
        content: result.content,
        tool_calls_made: totalToolCalls,
        tools_used: toolsUsed,
        provider: cfg.provider,
        model: cfg.model,
        local: isLocalProvider(cfg.provider),
        finish_reason: result.finish_reason,
        usage: totalUsage,
      };
    }

    // Execute tool calls
    totalToolCalls += result.tool_calls.length;

    // Add the assistant message with tool_calls to the conversation
    messages.push({
      role: "assistant",
      content: result.content || "",
      tool_calls: result.tool_calls,
    });

    // Execute each tool call and add results
    for (const toolCall of result.tool_calls) {
      if (!toolsUsed.includes(toolCall.function.name)) {
        toolsUsed.push(toolCall.function.name);
      }

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        // If arguments aren't valid JSON, try as a simple string
        args = { input: toolCall.function.arguments };
      }

      const toolResult = await executeTool(toolCall.function.name, args);
      const toolResultMsg: ToolChatMessage = {
        role: "tool",
        content: JSON.stringify(toolResult),
        tool_call_id: toolCall.id,
      };
      messages.push(toolResultMsg);
    }
  }

  // If we hit max iterations, return what we have
  return {
    content: lastContent || "(Tool calling loop exceeded maximum iterations)",
    tool_calls_made: totalToolCalls,
    tools_used: toolsUsed,
    provider: cfg.provider,
    model: cfg.model,
    local: isLocalProvider(cfg.provider),
    finish_reason: lastFinishReason,
    usage: totalUsage,
  };
}
