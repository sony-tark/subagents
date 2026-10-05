export interface Definition {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  source: string;
  model?: string;
  isolation?: "worktree";
  maxTurns?: number;
  memory?: "user" | "project";
  mcpServers?: Record<string, { command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string>; cwd?: string; timeout?: number }>;
  hooks?: { PreToolUse?: Array<{ command: string; args?: string[] }>; PostToolUse?: Array<{ command: string; args?: string[] }> };
}

export const availableTools = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export const generalPurpose: Definition = {
  name: "general-purpose",
  description: "General-purpose subagent with tools selected by its parent at spawn",
  prompt: "You are a delegated coding assistant. Complete the task using only the tools your parent delegated to you. Report findings, changes and any uncertainty succinctly.",
  tools: [],
  source: "built-in",
};

/** Only grant tools both requested and currently held by the spawning parent. */
export function delegateTools(requested: string[], parentTools: string[]): string[] {
  if (!Array.isArray(requested) || requested.some(t => typeof t !== "string" || !availableTools.includes(t as typeof availableTools[number]))) {
    throw new Error(`Subagent tools must be selected from: ${availableTools.join(", ")}`);
  }
  const unique = [...new Set(requested)];
  const missing = unique.filter(t => !parentTools.includes(t));
  if (missing.length) throw new Error(`Parent cannot delegate tools it does not have: ${missing.join(", ")}`);
  return unique;
}

/** Root Pi tools use plain names; child tools use agent_* aliases. */
export function parentToolNames(names: string[], nested = false): string[] {
  return availableTools.filter(t => names.includes(nested ? `agent_${t}` : t));
}
