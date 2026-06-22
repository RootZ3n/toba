/**
 * Toba — Tool Registry
 * ====================
 * Defines the tool system for agent tool-calling.
 * Tools are functions that accept structured parameters and return structured results.
 * The registry maps tool names to their definitions and execution functions.
 */

// ── Tool Definition Types ──────────────────────────────────────────────────

export interface ToolParameterProperty {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export type ToolExecuteFn = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecuteFn;
}

// ── OpenAI Function Calling Types ──────────────────────────────────────────

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallResult {
  tool_call_id: string;
  role: "tool";
  content: string;
}

// ── Agent Tool Mapping ─────────────────────────────────────────────────────

/** Which tools each agent has access to. Agents not listed have no tools. */
const AGENT_TOOL_MAP: Record<string, string[]> = {
  "job-scout-analyst": ["web_search", "web_extract"],
  "resume-reviewer": ["web_search", "web_extract"],
  "outreach-drafter": ["web_search", "web_extract"],
  "application-tracker": [
    "create_application",
    "list_applications",
    "get_application",
    "update_application",
    "delete_application",
    "get_follow_ups",
  ],
};

// ── Registry ───────────────────────────────────────────────────────────────

const tools = new Map<string, RegisteredTool>();

export function registerTool(tool: RegisteredTool): void {
  tools.set(tool.definition.name, tool);
}

export function getTool(name: string): RegisteredTool | undefined {
  return tools.get(name);
}

export function listTools(): RegisteredTool[] {
  return [...tools.values()];
}

/** Get the tool definitions for a specific agent (OpenAI function-calling format). */
export function getToolsForAgent(agentId: string): OpenAITool[] {
  const toolNames = AGENT_TOOL_MAP[agentId] ?? [];
  return toolNames
    .map(name => tools.get(name))
    .filter((t): t is RegisteredTool => !!t)
    .map(t => ({
      type: "function" as const,
      function: {
        name: t.definition.name,
        description: t.definition.description,
        parameters: t.definition.parameters,
      },
    }));
}

/** Check if an agent has any tools. */
export function agentHasTools(agentId: string): boolean {
  return (AGENT_TOOL_MAP[agentId]?.length ?? 0) > 0;
}

/** Execute a tool by name with the given arguments. */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = tools.get(name);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }
  try {
    return await tool.execute(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Tool execution failed: ${msg}` };
  }
}

/** Clear all registered tools (for testing). */
export function clearTools(): void {
  tools.clear();
}

/** Register a mapping of tool names to an agent. */
export function mapToolsToAgent(agentId: string, toolNames: string[]): void {
  AGENT_TOOL_MAP[agentId] = toolNames;
}

/** Get the full agent-tool map (for testing). */
export function getAgentToolMap(): Record<string, string[]> {
  return { ...AGENT_TOOL_MAP };
}
