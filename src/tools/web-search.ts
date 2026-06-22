/**
 * Toba — Web Search Tool
 * ======================
 * Searches the web using DuckDuckGo HTML scraping (no API key needed).
 * Returns top results with title, URL, and snippet.
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

function fetchUrl(url: string, headers: Record<string, string>, timeoutMs = 15_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? httpsRequest : httpRequest;
    const req = lib({
      method: "GET",
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.5",
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        fetchUrl(redirectUrl, headers, timeoutMs).then(resolve).catch(reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error(`Timeout fetching ${url}`)); });
    req.end();
  });
}

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

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Parse DuckDuckGo HTML search results page.
 * Looks for result blocks with class "result" or "web-result".
 */
function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results use <a class="result__a"> for the title/link
  // and <a class="result__snippet"> for the snippet.
  // Also try the newer layout with <div class="result__body">

  // Pattern 1: Classic DDG HTML results
  const resultBlockRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const titleMatches = [...html.matchAll(resultBlockRegex)];
  const snippetMatches = [...html.matchAll(snippetRegex)];

  for (let i = 0; i < titleMatches.length && i < 10; i++) {
    const titleMatch = titleMatches[i]!;
    const href = titleMatch[1] ?? "";
    const title = stripHtml(titleMatch[2] ?? "");
    const snippet = i < snippetMatches.length ? stripHtml(snippetMatches[i]![1] ?? "") : "";

    // DDG wraps URLs through redirects; extract the actual URL
    let url = href;
    try {
      const u = new URL(href, "https://duckduckgo.com");
      const uddg = u.searchParams.get("uddg");
      if (uddg) url = decodeURIComponent(uddg);
    } catch { /* use raw href */ }

    if (title && url) {
      results.push({
        title: decodeHtmlEntities(title),
        url,
        snippet: decodeHtmlEntities(snippet),
      });
    }
  }

  // Pattern 2: Fallback — look for any links with result-related classes
  if (results.length === 0) {
    const fallbackRegex = /<h2[^>]*class="[^"]*result__title[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of html.matchAll(fallbackRegex)) {
      const url = match[1] ?? "";
      const title = stripHtml(match[2] ?? "");
      if (title && url) {
        results.push({ title: decodeHtmlEntities(title), url, snippet: "" });
      }
    }
  }

  return results.slice(0, 10);
}

/**
 * Search DuckDuckGo and return results.
 */
export async function webSearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

  const res = await fetchUrl(url, {});
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  }

  const results = parseResults(res.body);
  return results.slice(0, maxResults);
}

// ── Register Tool ──────────────────────────────────────────────────────────

export function registerWebSearchTool(): void {
  registerTool({
    definition: {
      name: "web_search",
      description: "Search the web using DuckDuckGo. Returns top results with title, URL, and snippet. Use this to find job postings, company info, recruiter contacts, or any web information.",
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
        const results = await webSearch(query, maxResults);
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
