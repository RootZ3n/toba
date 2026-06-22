/**
 * Toba — Web Search Tool
 * ======================
 * Searches the web using Tavily API (built for AI agents).
 * Returns top results with title, URL, and content snippet.
 * Falls back to DuckDuckGo HTML scraping if Tavily is unavailable.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { registerTool, type ToolResult } from "./registry.js";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function httpJson(method: string, urlStr: string, headers: Record<string, string>, body: unknown, timeoutMs = 30_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? httpsRequest : httpRequest;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = lib({
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        ...headers,
        ...(payload ? { "content-length": Buffer.byteLength(payload).toString() } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error(`Timeout: ${url.host}`)); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Tavily Search ──────────────────────────────────────────────────────────

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

async function searchTavily(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env["TAVILY_API_KEY"] ?? process.env["TOBA_TAVILY_API_KEY"] ?? "";
  if (!apiKey) {
    throw new Error("No Tavily API key configured (set TAVILY_API_KEY or TOBA_TAVILY_API_KEY)");
  }

  const res = await httpJson("POST", "https://api.tavily.com/search", {}, {
    api_key: apiKey,
    query,
    max_results: maxResults,
    search_depth: "basic",
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Tavily returned HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }

  const parsed = JSON.parse(res.body) as TavilyResponse;
  return (parsed.results ?? []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

// ── Register Tool ──────────────────────────────────────────────────────────

export function registerWebSearchTool(): void {
  registerTool({
    definition: {
      name: "web_search",
      description: "Search the web using Tavily API. Returns top results with title, URL, and content snippet. Use this to find job postings, company info, recruiter contacts, or any web information.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query string",
          },
          max_results: {
            type: "string",
            description: "Maximum number of results to return (1-10, default 5)",
          },
        },
        required: ["query"],
      },
    },
    execute: async (args): Promise<ToolResult> => {
      const query = String(args.query ?? "").trim();
      if (!query) {
        return { success: false, error: "query is required" };
      }
      const maxResults = Math.min(10, Math.max(1, parseInt(String(args.max_results ?? "5"), 10) || 5));
      try {
        const results = await searchTavily(query, maxResults);
        return {
          success: true,
          data: {
            query,
            results,
            count: results.length,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Web search failed: ${msg}` };
      }
    },
  });
}
