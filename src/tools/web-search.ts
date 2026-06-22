/**
 * Toba — Web Search & Extract Tools
 * ==================================
 * Web search via Tavily API with advanced depth for detailed job content.
 * Web extract via Tavily Extract for fetching specific job posting pages.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { registerTool, type ToolResult } from "./registry.js";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  full_content?: string;
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

function getApiKey(): string {
  return process.env["TAVILY_API_KEY"] ?? process.env["TOBA_TAVILY_API_KEY"] ?? "";
}

// ── Tavily Search (Advanced) ───────────────────────────────────────────────

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string;
  score: number;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

async function searchTavily(query: string, maxResults: number, detailed: boolean): Promise<SearchResult[]> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No Tavily API key configured (set TAVILY_API_KEY)");

  const res = await httpJson("POST", "https://api.tavily.com/search", {}, {
    api_key: apiKey,
    query,
    max_results: maxResults,
    search_depth: detailed ? "advanced" : "basic",
    include_raw_content: detailed,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Tavily returned HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }

  const parsed = JSON.parse(res.body) as TavilyResponse;
  return (parsed.results ?? []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
    ...(detailed && r.raw_content ? { full_content: r.raw_content.slice(0, 12000) } : {}),
  }));
}

// ── Tavily Extract ─────────────────────────────────────────────────────────

interface TavilyExtractResult {
  url: string;
  raw_content: string;
}

interface TavilyExtractResponse {
  results: TavilyExtractResult[];
  failed_results: Array<{ url: string; error: string }>;
}

async function extractTavily(urls: string[]): Promise<Array<{ url: string; content: string; error?: string }>> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No Tavily API key configured (set TAVILY_API_KEY)");

  const res = await httpJson("POST", "https://api.tavily.com/extract", {}, {
    api_key: apiKey,
    urls,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Tavily Extract returned HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }

  const parsed = JSON.parse(res.body) as TavilyExtractResponse;
  const results: Array<{ url: string; content: string; error?: string }> = [];

  for (const r of parsed.results ?? []) {
    results.push({ url: r.url, content: (r.raw_content ?? "").slice(0, 15000) });
  }
  for (const f of parsed.failed_results ?? []) {
    results.push({ url: f.url, content: "", error: f.error });
  }
  return results;
}

// ── Register Tools ─────────────────────────────────────────────────────────

export function registerWebSearchTool(): void {
  // Web search — now with detailed mode for job postings
  registerTool({
    definition: {
      name: "web_search",
      description: "Search the web using Tavily API. When detailed=true, returns full page content (up to 12k chars per result) — use this for job postings to get requirements, equipment, qualifications. When detailed=false, returns snippets only.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query. For job searches include: job title, location, and 'requirements' or 'qualifications' to get detailed results.",
          },
          max_results: {
            type: "string",
            description: "Maximum results (1-10, default 3 for detailed, 5 for basic)",
          },
          detailed: {
            type: "string",
            description: "Set to 'true' to get full page content for each result (use for job postings). Default 'false' for snippets only.",
          },
        },
        required: ["query"],
      },
    },
    execute: async (args): Promise<ToolResult> => {
      const query = String(args.query ?? "").trim();
      if (!query) return { success: false, error: "query is required" };

      const detailed = String(args.detailed ?? "false").toLowerCase() === "true";
      const defaultMax = detailed ? 3 : 5;
      const maxResults = Math.min(10, Math.max(1, parseInt(String(args.max_results ?? String(defaultMax)), 10) || defaultMax));

      try {
        const results = await searchTavily(query, maxResults, detailed);
        return {
          success: true,
          data: { query, results, count: results.length, detailed },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Web search failed: ${msg}` };
      }
    },
  });

  // Web extract — fetch specific URLs for full content
  registerTool({
    definition: {
      name: "web_extract",
      description: "Fetch and extract full content from specific URLs. Use this after web_search to get detailed job posting content from promising results. Returns up to 15k chars per URL. Best for reading job requirements, equipment lists, and qualifications.",
      parameters: {
        type: "object",
        properties: {
          urls: {
            type: "string",
            description: "Comma-separated URLs to extract content from (max 3 at once)",
          },
        },
        required: ["urls"],
      },
    },
    execute: async (args): Promise<ToolResult> => {
      const urlStr = String(args.urls ?? "").trim();
      if (!urlStr) return { success: false, error: "urls is required" };

      const urls = urlStr.split(",").map(u => u.trim()).filter(Boolean).slice(0, 3);
      if (urls.length === 0) return { success: false, error: "No valid URLs provided" };

      try {
        const results = await extractTavily(urls);
        return {
          success: true,
          data: { results, count: results.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Web extract failed: ${msg}` };
      }
    },
  });
}
