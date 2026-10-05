import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import {
  DefaultResourceLoader, SettingsManager, createMcpExtension, getAgentDir,
  type AgentSession, type ExtensionContext, type ExtensionAPI, type ResourceLoader, type McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import type { Definition } from "./definitions.ts";

const execFile = promisify(execFileCallback);

/** Never discover the parent's extensions, MCP servers, skills, or project files implicitly. */
export async function childResources(options: {
  def: Definition; cwd: string; prompt: string; childId: string;
  owner?: ExtensionContext; rootSessionId: string;
  waitForLaunch: (signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  isOwner: () => boolean;
}): Promise<{ resourceLoader: ResourceLoader; settingsManager: SettingsManager; bind: boolean; close?: (session: AgentSession) => Promise<void> }> {
  const { def, cwd, prompt, childId, owner, rootSessionId, waitForLaunch, signal, isOwner } = options;
  const settingsManager = SettingsManager.inMemory({});
  let disabled = false;
  const servers = Object.entries(def.mcpServers || {});
  const pre = def.hooks?.PreToolUse || [];
  const post = def.hooks?.PostToolUse || [];
  const dangerous = servers.length || pre.length || post.length;
  if (dangerous && (!owner?.hasUI || owner.sessionManager.getSessionId() !== rootSessionId)) {
    throw new Error("MCP servers and hooks require the owning human's approval UI");
  }
  const approve = async (title: string, body: string, currentSignal: AbortSignal | undefined = signal): Promise<boolean> => {
    if (!owner?.hasUI || !isOwner() || currentSignal?.aborted || body.length > 1200) return false;
    const approved = await owner.ui.confirm(title, body, { timeout: 30000, signal: currentSignal });
    return approved && !disabled && !currentSignal?.aborted && isOwner();
  };
  for (const [name, config] of servers) {
    // Confirmation precedes connection/startup and displays the complete configuration (only env references, not secrets).
    if (!await approve(`Start MCP server ${name} for subagent?`, JSON.stringify({ name, ...config }))) {
      throw new Error(`MCP server ${name} startup denied (or configuration too long to display)`);
    }
  }
  const factories = [];
  if (servers.length) {
    factories.push(createMcpExtension({
      loadConfig: () => ({
        servers: disabled ? [] : servers.map(([name, spec]) => {
          const config: McpServerConfig = spec.command
            ? { type: "stdio", command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd, timeout: spec.timeout, exposure: "direct" }
            : { type: "http", url: spec.url!, headers: spec.headers, timeout: spec.timeout, exposure: "direct" };
          return { name, source: `subagent:${childId}`, scope: "extension" as const, config };
        }),
        errors: [], autoEnableCodemode: false,
      }),
    }));
  }
  if (dangerous) factories.push((pi: ExtensionAPI) => {
    // The child has no ambient permission UI. These gates run on every MCP call / configured hook.
    pi.on("tool_call", async (event, ctx) => {
      if (disabled) return;
      await waitForLaunch(ctx.signal);
      const payload = JSON.stringify({ tool: event.toolName, input: event.input });
      if (event.toolName.startsWith("mcp__") || ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(event.toolName)) {
        if (!await approve(`Allow subagent MCP call?`, payload, ctx.signal)) return { block: true, reason: "MCP call denied by human (or arguments too long to show in full)" };
      }
      for (const hook of pre) {
        const preview = JSON.stringify({ command: hook.command, args: hook.args || [], tool: event.toolName, input: event.input });
        if (!await approve(`Run PreToolUse hook for ${event.toolName}?`, preview, ctx.signal)) return { block: true, reason: "PreToolUse hook denied" };
        try {
          await execFile(hook.command, hook.args || [], {
            cwd, timeout: 5000, maxBuffer: 64 * 1024,
            env: { ...process.env, SUBAGENT_ID: childId, SUBAGENT_TOOL_NAME: event.toolName, SUBAGENT_TOOL_INPUT: payload },
            signal: ctx.signal,
          });
        } catch { return { block: true, reason: "PreToolUse hook failed or timed out; tool not executed" }; }
      }
      return undefined;
    });
    if (post.length) pi.on("tool_result", async (event, ctx) => {
      if (disabled) return;
      const payload = JSON.stringify({ tool: event.toolName, input: event.input, content: event.content });
      for (const hook of post) {
        const preview = JSON.stringify({ command: hook.command, args: hook.args || [], result: payload });
        if (!await approve(`Run PostToolUse hook for ${event.toolName}?`, preview, ctx.signal)) continue;
        try {
          await execFile(hook.command, hook.args || [], {
            cwd, timeout: 5000, maxBuffer: 64 * 1024,
            env: { ...process.env, SUBAGENT_ID: childId, SUBAGENT_TOOL_NAME: event.toolName, SUBAGENT_TOOL_RESULT: payload },
            signal: ctx.signal,
          });
        } catch { owner?.ui.notify(`PostToolUse hook failed or timed out for ${event.toolName}`, "warning"); }
      }
    });
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: prompt, extensionFactories: factories,
  });
  await resourceLoader.reload();
  const errors = resourceLoader.getExtensions().errors;
  if (errors.length) throw new Error(`Child extensions failed to load: ${errors.map(e => e.error).join("; ")}`);
  return {
    resourceLoader, settingsManager, bind: factories.length > 0,
    ...(factories.length ? { close: async (session: AgentSession) => {
      // AgentSession.dispose() does not emit session_shutdown in Pi 1.0.2. Its public
      // extensionRunner can dispatch that boundary directly, closing MCP transports
      // without session.reload() resetting process-global provider registrations.
      disabled = true;
      if (session.extensionRunner.hasHandlers("session_shutdown")) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } } : {}),
  };
}
