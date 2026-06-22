/**
 * Toba — Tool System Tests
 * ========================
 * Tests for the tool registry, web search, application tracker, and tool-chat integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerTool,
  getTool,
  listTools,
  getToolsForAgent,
  agentHasTools,
  executeTool,
  clearTools,
  mapToolsToAgent,
  getAgentToolMap,
  type RegisteredTool,
  type ToolResult,
} from "./registry.js";
import {
  providerSupportsTools,
  TOOL_CAPABLE_PROVIDERS,
} from "./tool-chat.js";

// ── Registry Tests ─────────────────────────────────────────────────────────

describe("Tool Registry", () => {
  beforeEach(() => {
    clearTools();
  });

  it("registers and retrieves a tool", () => {
    const tool: RegisteredTool = {
      definition: {
        name: "test_tool",
        description: "A test tool",
        parameters: { type: "object", properties: { input: { type: "string", description: "test input" } } },
      },
      execute: async (args) => ({ success: true, data: args.input }),
    };
    registerTool(tool);
    expect(getTool("test_tool")).toBeDefined();
    expect(getTool("test_tool")?.definition.name).toBe("test_tool");
  });

  it("lists all registered tools", () => {
    registerTool({
      definition: { name: "tool_a", description: "A", parameters: { type: "object", properties: {} } },
      execute: async () => ({ success: true }),
    });
    registerTool({
      definition: { name: "tool_b", description: "B", parameters: { type: "object", properties: {} } },
      execute: async () => ({ success: true }),
    });
    expect(listTools()).toHaveLength(2);
  });

  it("returns undefined for unknown tool", () => {
    expect(getTool("nonexistent")).toBeUndefined();
  });

  it("executes a tool successfully", async () => {
    registerTool({
      definition: { name: "echo", description: "Echo tool", parameters: { type: "object", properties: { msg: { type: "string", description: "message" } } } },
      execute: async (args) => ({ success: true, data: args.msg }),
    });
    const result = await executeTool("echo", { msg: "hello" });
    expect(result.success).toBe(true);
    expect(result.data).toBe("hello");
  });

  it("returns error for unknown tool execution", async () => {
    const result = await executeTool("nonexistent", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("handles tool execution errors", async () => {
    registerTool({
      definition: { name: "fail_tool", description: "Fails", parameters: { type: "object", properties: {} } },
      execute: async () => { throw new Error("boom"); },
    });
    const result = await executeTool("fail_tool", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("clears all tools", () => {
    registerTool({
      definition: { name: "temp", description: "Temp", parameters: { type: "object", properties: {} } },
      execute: async () => ({ success: true }),
    });
    expect(listTools()).toHaveLength(1);
    clearTools();
    expect(listTools()).toHaveLength(0);
  });
});

// ── Agent Tool Mapping Tests ───────────────────────────────────────────────

describe("Agent Tool Mapping", () => {
  beforeEach(() => {
    clearTools();
    // Register tools that agents expect
    registerTool({
      definition: { name: "web_search", description: "Search the web", parameters: { type: "object", properties: { query: { type: "string", description: "search query" } } } },
      execute: async () => ({ success: true, data: [] }),
    });
    // Register all application tracker tools
    for (const name of ["create_application", "list_applications", "get_application", "update_application", "delete_application", "get_follow_ups"]) {
      registerTool({
        definition: { name, description: name, parameters: { type: "object", properties: {} } },
        execute: async () => ({ success: true }),
      });
    }
  });

  it("job-scout-analyst has web_search tool", () => {
    expect(agentHasTools("job-scout-analyst")).toBe(true);
    const tools = getToolsForAgent("job-scout-analyst");
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("web_search");
  });

  it("resume-reviewer has web_search tool", () => {
    expect(agentHasTools("resume-reviewer")).toBe(true);
    const tools = getToolsForAgent("resume-reviewer");
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("web_search");
  });

  it("outreach-drafter has web_search tool", () => {
    expect(agentHasTools("outreach-drafter")).toBe(true);
    const tools = getToolsForAgent("outreach-drafter");
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("web_search");
  });

  it("application-tracker has CRUD tools", () => {
    expect(agentHasTools("application-tracker")).toBe(true);
    const tools = getToolsForAgent("application-tracker");
    expect(tools.length).toBeGreaterThanOrEqual(5);
    const names = tools.map(t => t.function.name);
    expect(names).toContain("create_application");
    expect(names).toContain("list_applications");
    expect(names).toContain("get_application");
    expect(names).toContain("update_application");
    expect(names).toContain("delete_application");
  });

  it("strategist has no tools", () => {
    expect(agentHasTools("strategist")).toBe(false);
    expect(getToolsForAgent("strategist")).toHaveLength(0);
  });

  it("interview-coach has no tools", () => {
    expect(agentHasTools("interview-coach")).toBe(false);
    expect(getToolsForAgent("interview-coach")).toHaveLength(0);
  });

  it("returns empty for unknown agent", () => {
    expect(agentHasTools("unknown-agent")).toBe(false);
    expect(getToolsForAgent("unknown-agent")).toHaveLength(0);
  });

  it("mapToolsToAgent adds custom mapping", () => {
    mapToolsToAgent("custom-agent", ["web_search"]);
    expect(agentHasTools("custom-agent")).toBe(true);
    const tools = getToolsForAgent("custom-agent");
    expect(tools).toHaveLength(1);
  });
});

// ── Provider Tool Capability Tests ─────────────────────────────────────────

describe("Provider Tool Capability", () => {
  it("supports tool-capable providers", () => {
    expect(providerSupportsTools("openai")).toBe(true);
    expect(providerSupportsTools("openrouter")).toBe(true);
    expect(providerSupportsTools("xiaomi")).toBe(true);
    expect(providerSupportsTools("groq")).toBe(true);
    expect(providerSupportsTools("mistral")).toBe(true);
    expect(providerSupportsTools("together")).toBe(true);
    expect(providerSupportsTools("deepseek")).toBe(true);
  });

  it("rejects non-tool-capable providers", () => {
    expect(providerSupportsTools("echo")).toBe(false);
    expect(providerSupportsTools("none")).toBe(false);
    expect(providerSupportsTools("ollama")).toBe(false);
    expect(providerSupportsTools("anthropic")).toBe(false);
    expect(providerSupportsTools("unknown")).toBe(false);
  });

  it("TOOL_CAPABLE_PROVIDERS has correct size", () => {
    expect(TOOL_CAPABLE_PROVIDERS.size).toBe(7);
  });
});

// ── Web Search Tool Tests ──────────────────────────────────────────────────

describe("Web Search Tool", () => {
  it("web search tool is importable", async () => {
    const mod = await import("./web-search.js");
    expect(mod.registerWebSearchTool).toBeDefined();
    expect(typeof mod.registerWebSearchTool).toBe("function");
  });
});

// ── Application Tracker Tests ──────────────────────────────────────────────

describe("Application Tracker", () => {
  it("application tools are importable", async () => {
    const mod = await import("./applications.js");
    expect(mod.registerApplicationTools).toBeDefined();
    expect(mod.createTrackerApp).toBeDefined();
    expect(mod.listTrackerApps).toBeDefined();
    expect(mod.getTrackerApp).toBeDefined();
    expect(mod.updateTrackerApp).toBeDefined();
    expect(mod.deleteTrackerApp).toBeDefined();
  });
});
