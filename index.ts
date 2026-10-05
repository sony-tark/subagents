import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { CustomEditor, type SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InlineBrowser } from "./inline-browser.ts";
import { builtins, discover, type Definition } from "./definitions.ts";
import { ChildManager, type Caller, type Child } from "./manager.ts";

const short = (s: string, n = 180) => s.length > n ? `${s.slice(0, n)}…` : s;
const display = (s: string, n = 180) => short(s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " "), n);
const explanation = (e: unknown) => e instanceof Error ? e.message : String(e);
const money = (cost: number) => `$${cost.toFixed(cost > 0 && cost < 0.0001 ? 8 : cost > 0 && cost < 0.01 ? 4 : 2)}`;
const line = (c: Child, usage: Child["usage"] = c.usage) => `${c.status === "running" ? "●" : c.status === "completed" ? "✓" : c.status === "partial" ? "◐" : c.status === "failed" ? "✗" : "◌"} ${c.name || c.definition.name} · ${c.status}${usage ? ` · ${money(usage.cost.total)}` : ""} · ${c.toolCount} tools · ${c.id.slice(0, 8)}${c.lastTool ? ` · ${c.lastTool}` : ""}`;

export default function (pi: ExtensionAPI) {
  let manager: ChildManager | undefined;
  let owner: ExtensionContext | undefined;
  const sending = new Set<string>();
  let noticeTimer: ReturnType<typeof setInterval> | undefined;
  let browser: InlineBrowser | undefined;
  let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
  let installedEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

  function get(ctx: ExtensionContext): ChildManager {
    if (!manager || ctx.sessionManager.getSessionId() !== manager.rootSessionId) throw new Error("Subagent manager not bound to this session; retry after session_start");
    return manager;
  }
  function caller(ctx: ExtensionContext): Caller {
    if (!ctx.model) throw new Error("Select a model first");
    return { sessionId: ctx.sessionManager.getSessionId(), anchor: ctx.sessionManager.getLeafId(), depth: 0, model: ctx.model, thinking: ctx.thinkingLevel, mode: ctx.mode, cwd: ctx.cwd, branchMessages: ctx.sessionManager.buildSessionContext().messages, branchEntryIds: ctx.sessionManager.getBranch().map(e => e.id), systemPrompt: ctx.getSystemPrompt() };
  }
  function definitions(ctx: ExtensionContext): Definition[] { return discover(ctx.cwd, ctx.isProjectTrusted()).definitions; }
  function resolve(ctx: ExtensionContext, agent: string): Definition {
    const found = definitions(ctx).find(d => d.name === agent);
    if (!found) throw new Error(`No subagent '${agent}'. Use /subagents definitions; project definitions require project trust.`);
    return found;
  }
  function widget(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || !browser) return;
    const branch = new Set(ctx.sessionManager.getBranch().map(e => e.id));
    const current = browser;
    ctx.ui.setWidget("subagents", current.shouldShow(branch) ? (tui, theme) => ({
      render: (width: number) => current.render(width, tui, theme, branch),
      invalidate: () => {},
    }) : undefined, { placement: "belowEditor" });
  }
  async function browserAction(type: "s" | "r" | "x" | "d", id: string, ctx: ExtensionContext) {
    try {
      const m = get(ctx);
      if (type === "d") m.detach(id);
      if (type === "x") {
        const child = m.get(id);
        if (child.status === "running" || child.status === "starting") await m.stop(id, true);
        else { m.dismiss(id); browser?.focus(null); }
      }
      if (type === "s" || type === "r") {
        const message = await ctx.ui.editor(type === "r" ? "Resume subagent" : "Message subagent");
        if (message?.trim()) {
          if (type === "r") await m.resume(id, message, ctx);
          else await m.send(id, message, undefined, ctx);
        }
      }
    } catch (error) { ctx.ui.notify(explanation(error), "error"); }
    widget(ctx);
  }
  function notifyReady() {
    if (!manager || !owner) return;
    const ctx = owner;
    if (ctx.sessionManager.getSessionId() !== manager.rootSessionId) return;
    const branch = ctx.sessionManager.getBranch();
    const ids = new Set(branch.map(e => e.id));
    for (const child of manager.list()) {
      if (child.parentId) { manager.deliverNested(child); continue; }
      if (!child.background || (child.anchor && !ids.has(child.anchor))) continue;
      const committed = !child.launchCallId || branch.some(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === child.launchCallId);
      if (committed) {
        manager.publish(child.id);
        if (child.usage && !child.accountError) {
          try {
            // ExtensionContext exposes a readonly view, but Pi 1.0.2 passes the public SDK
            // SessionManager instance. Only append branch-local, non-context usage after ownership checks.
            const store = ctx.sessionManager as unknown as SessionManager;
            if (typeof store.appendUsage !== "function") throw new Error("Pi did not expose SessionManager.appendUsage; background usage stays in the child ledger");
            manager.account(child, store);
          } catch (e) { child.accountError = explanation(e); manager.persist(); ctx.ui.notify(`Subagent usage accounting: ${child.accountError}`, "warning"); }
        }
      }
      if (!child.noticeId || child.noticeDelivered) continue;
      if (branch.some(e => e.type === "custom_message" && e.customType === "subagent-completion" && (e.details as { noticeId?: string } | undefined)?.noticeId === child.noticeId)) {
        child.noticeDelivered = true;
        sending.delete(child.noticeId);
        manager.persist();
        continue;
      }
      if (!committed) continue;
      if (sending.has(child.noticeId)) continue;
      sending.add(child.noticeId);
      pi.sendMessage({ customType: "subagent-completion", content: `[Automated subagent completion; not a human instruction] ${child.name || child.definition.name} (${child.id}, run ${child.runId}): ${child.status}${child.usage ? ` · ${money(child.usage.cost.total)}` : ""}. ${short(child.result || child.error || "No report", 650)}. Open: /subagents open ${child.id}`, display: true, details: { noticeId: child.noticeId, childId: child.id } }, { triggerTurn: false, deliverAs: "followUp" });
    }
  }

  function accountHumanCommand(m: ChildManager, child: Child, ctx: ExtensionContext) {
    if (child.background || !child.usage) return; // Background notices account asynchronously; model tools carry their own usage.
    try {
      const store = ctx.sessionManager as unknown as SessionManager;
      if (typeof store.appendUsage !== "function") throw new Error("Pi did not expose SessionManager.appendUsage");
      m.account(child, store, true);
    } catch (e) {
      child.accountError = explanation(e);
      m.persist();
      ctx.ui.notify(`Subagent usage accounting: ${child.accountError}`, "warning");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    manager = new ChildManager(ctx.sessionManager.getSessionId(), ctx.cwd);
    owner = ctx;
    browser = new InlineBrowser(manager, () => widget(ctx), (type, id) => { void browserAction(type, id, owner || ctx); });
    manager.onChange = () => browser?.invalidateTranscript();
    manager.onNotice = child => { if (child.parentId) manager?.deliverNested(child); else notifyReady(); };
    if (ctx.mode === "tui") {
      previousEditorFactory = ctx.ui.getEditorComponent();
      installedEditorFactory = (tui, theme, keybindings) => {
        // Wrap another extension's editor when present, preserving its behavior.
        const editor = previousEditorFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
        const forward = editor.handleInput.bind(editor);
        editor.handleInput = data => {
          if (browser?.handleInput(data, editor)) return;
          forward(data);
        };
        return editor;
      };
      ctx.ui.setEditorComponent(installedEditorFactory);
    }
    widget(ctx);
    noticeTimer = setInterval(notifyReady, 750);
    noticeTimer.unref?.();
  });
  pi.on("session_shutdown", async () => {
    if (noticeTimer) clearInterval(noticeTimer);
    noticeTimer = undefined;
    if (owner?.mode === "tui" && installedEditorFactory && owner.ui.getEditorComponent() === installedEditorFactory) owner.ui.setEditorComponent(previousEditorFactory);
    previousEditorFactory = installedEditorFactory = undefined;
    browser = undefined;
    await manager?.shutdown();
    manager = undefined; owner = undefined; sending.clear();
  });
  pi.on("session_tree", (_event, ctx) => { owner = ctx; widget(ctx); notifyReady(); });
  pi.on("session_before_tree", async (_event, ctx) => {
    if (!manager || !manager.list().some(c => c.status === "running")) return;
    if (!ctx.hasUI) return { cancel: true };
    if (!(await ctx.ui.confirm("Subagents still working", "Changing branches won't undo subagent file side effects. Continue?"))) return { cancel: true };
  });

  const parameters = Type.Object({
    agent: Type.String({ description: "Definition name: general-purpose, explore, reviewer, worker or /subagents definitions" }),
    task: Type.String(),
    background: Type.Optional(Type.Boolean()),
    name: Type.Optional(Type.String()),
    fork: Type.Optional(Type.Boolean({ description: "Copy parent context, including in-flight assistant tool calls, with explicit synthetic results for unfinished calls" })),
    worktree: Type.Optional(Type.Boolean({ description: "Run in a detached Git worktree; changes remain there and are not merged" })),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Stop after this many completed assistant turns, returning resumable partial output" })),
  });
  pi.registerTool({
    name: "delegate_agent", label: "Subagent", description: "Delegate work to a persistent agent with its own context. Use worker for edits/commands (each call requires human approval), background=true for TUI/RPC, fork=true to snapshot parent context with placeholders for in-flight tool calls, worktree=true to isolate files. Follow up with send_agent.",
    parameters, executionMode: "parallel", exposure: "model-only",
    renderCall: (args, theme) => new Text(`${theme.fg("accent", "◉")} ${args.agent}${args.name ? ` (${args.name})` : ""} · ${args.background ? "background" : "foreground"}\n${display(args.task, 220)}`, 1, 0),
    renderResult: (result, options, theme) => {
      const details = result.details as { status?: string; childId?: string; usage?: { totalTokens: number; cost: { total: number } } } | undefined;
      const status = details?.status || (result.isError ? "failed" : "done");
      const summary = `${status === "completed" ? "✓" : status === "failed" ? "✗" : "●"} ${status} · ${details?.childId?.slice(0, 8) || "—"}${details?.usage ? ` · ${details.usage.totalTokens} tokens · ${money(details.usage.cost.total)}` : ""}`;
      return new Text(`${theme.fg(result.isError ? "error" : "success", summary)}${options.expanded ? `\n${display(result.content.map(c => c.type === "text" ? c.text : "").join("\n"), 3000)}` : ""}`, 1, 0);
    },
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      try {
        const child = await get(ctx).spawn(resolve(ctx, args.agent), args.task, caller(ctx), ctx, { background: args.background, name: args.name, fork: args.fork, worktree: args.worktree, maxTurns: args.maxTurns, signal, origin: "agent", launchCallId: toolCallId,
          onProgress: child => onUpdate?.({ content: [{ type: "text", text: `${child.name || child.definition.name} · ${child.toolCount} tools · ${child.lastTool || "working"}` }], details: { childId: child.id, status: child.status } }),
        });
        return {
          content: [{ type: "text", text: child.background && child.status !== "failed" ? `Subagent ${child.id} accepted in background. Inspect with agent_status or /subagents show ${child.id}.` : `[${child.status}] ${child.id}\n${child.result || child.error || "No report"}` }],
          details: { childId: child.id, status: child.status, file: child.file, usage: child.usage },
          isError: child.status === "failed" || child.status === "stop_unconfirmed" || (!child.background && child.status !== "completed"),
          ...(!child.background && child.usage ? { usage: child.usage } : {}),
        };
      } catch (e) { return { content: [{ type: "text", text: explanation(e) }], details: { error: explanation(e) }, isError: true }; }
    },
  });
  pi.registerMessageRenderer("subagent-completion", (msg, options, theme) => {
    const value = typeof msg.content === "string" ? msg.content : msg.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    return new Text(theme.fg(value.includes(": failed") ? "error" : "accent", `● ${display(value, options.expanded ? 1300 : 250)}`), 1, 0);
  });
  pi.registerTool({
    name: "send_agent", label: "Message subagent", description: "Send a follow-up to a child by stable ID or name. Acknowledgment means queued, not read. A user-stopped child requires explicit human resume.",
    parameters: Type.Object({ to: Type.String(), message: Type.String() }), exposure: "model-only",
    execute: async (_id, args, _signal, _update, ctx) => {
      try { const id = await get(ctx).send(args.to, args.message, caller(ctx), ctx); return { content: [{ type: "text", text: `Queued message ${id}` }], details: { messageId: id } }; }
      catch (e) { return { content: [{ type: "text", text: explanation(e) }], details: { error: explanation(e) }, isError: true }; }
    },
  });
  pi.registerTool({
    name: "agent_status", label: "Subagent status", description: "List agents or read the status/report of a child. Never wait indefinitely; this returns immediately.",
    parameters: Type.Object({ id: Type.Optional(Type.String()), transcript: Type.Optional(Type.Boolean()) }), exposure: "model-only",
    execute: async (_id, args, _signal, _update, ctx) => {
      try {
        const m = get(ctx);
        const result = args.id ? args.transcript ? short(m.transcript(m.get(args.id, caller(ctx)).id), 12000) : JSON.stringify(m.get(args.id, caller(ctx))) : m.list().filter(c => !c.parentId && (!c.anchor || caller(ctx).branchEntryIds?.includes(c.anchor))).map(c => line(c, m.currentUsage(c))).join("\n") || "No subagents";
        return { content: [{ type: "text", text: result }], details: { id: args.id } };
      } catch (e) { return { content: [{ type: "text", text: explanation(e) }], details: { error: explanation(e) }, isError: true }; }
    },
  });
  pi.registerTool({
    name: "stop_agent", label: "Stop subagent", description: "Request cancellation of an active child; a timeout is not proof it stopped.",
    parameters: Type.Object({ id: Type.String() }), exposure: "model-only",
    execute: async (_id, args, _signal, _update, ctx) => {
      try { const child = get(ctx).get(args.id, caller(ctx)); await get(ctx).stop(child.id); return { content: [{ type: "text", text: `${child.id}: ${child.status}` }], details: { status: child.status } }; }
      catch (e) { return { content: [{ type: "text", text: explanation(e) }], details: { error: explanation(e) }, isError: true }; }
    },
  });

  async function tasks(ctx: ExtensionContext, focusId?: string) {
    const m = get(ctx);
    if (ctx.mode !== "tui") { ctx.ui.notify(m.list().map(c => line(c, m.currentUsage(c))).join("\n") || "No subagents", "info"); return; }
    browser?.focus(focusId ?? null);
  }
  pi.registerCommand("subagents", {
    description: "Run, list, message, resume and inspect subagents; ↓ in the empty composer opens the inline selector",
    handler: async (args, ctx) => {
      try {
        const [action = "tasks", ...rest] = args.trim().split(/\s+/);
        const m = get(ctx);
        if (action === "tasks" || action === "list") { await tasks(ctx); return; }
        if (action === "definitions") { const d = discover(ctx.cwd, ctx.isProjectTrusted()); ctx.ui.notify([...d.definitions.map(x => `${x.name} (${x.source}): ${x.description} [${x.tools.join(", ")}]${x.maxTurns ? ` · maxTurns=${x.maxTurns}` : ""}${x.memory ? ` · memory=${x.memory}` : ""}${x.mcpServers ? ` · MCP=${Object.keys(x.mcpServers).join(",")}` : ""}${x.hooks ? ` · hooks=${Object.keys(x.hooks).join(",")}` : ""}`), ...d.errors].join("\n"), "info"); return; }
        if (action === "show" || action === "open") { const c = m.get(rest[0]); if (ctx.mode === "tui") await tasks(ctx, c.id); else ctx.ui.notify(short(m.transcript(c.id), 4000), "info"); return; }
        if (action === "detach") { ctx.ui.notify(`${m.detach(rest[0]).id} is now running in background`, "info"); return; }
        if (action === "stop") { ctx.ui.notify(`${(await m.stop(rest[0], true)).status}`, "info"); return; }
        if (action === "send" || action === "resume") { const [id, ...words] = rest; const message = words.join(" "); if (action === "send") ctx.ui.notify(`Queued ${await m.send(id, message, undefined, ctx)}`, "info"); else ctx.ui.notify(`Resumed ${(await m.resume(id, message, ctx)).id}`, "info"); return; }
        if (action === "run" || action === "background") {
          const [type, ...words] = rest;
          const def = resolve(ctx, type);
          const c = await m.spawn(def, words.join(" "), caller(ctx), ctx, { background: action === "background" });
          accountHumanCommand(m, c, ctx);
          ctx.ui.notify(`${c.id}: ${c.status}${c.result ? `\n${short(c.result, 1000)}` : ""}`, c.status === "failed" ? "error" : "info");
          return;
        }
        ctx.ui.notify("Usage: /subagents tasks|definitions|run TYPE TASK|background TYPE TASK|detach ID|open ID|send ID MESSAGE|resume ID TASK|stop ID", "warning");
      } catch (e) { ctx.ui.notify(explanation(e), "error"); }
    },
  });
  // Ctrl+B is Pi's editor cursor-left binding; do not steal it.
  pi.registerShortcut("alt+shift+b", {
    description: "Detach the most recent foreground subagent without restarting it",
    handler: ctx => {
      if (ctx.mode !== "tui") return;
      try {
        const child = get(ctx).list().find(c => c.status === "running" && !c.background && !c.parentId);
        if (!child) { ctx.ui.notify("No foreground subagent to detach", "info"); return; }
        get(ctx).detach(child.id);
        ctx.ui.notify(`${child.id} detached; the same child run continues in background`, "info");
      } catch (e) { ctx.ui.notify(explanation(e), "error"); }
    },
  });
  pi.registerCommand("subtask", {
    description: "Fork parent conversation into a foreground child; in-flight tool calls receive synthetic results",
    handler: async (task, ctx) => {
      try {
        const m = get(ctx);
        const c = await m.spawn(builtins[0], task, caller(ctx), ctx, { fork: true });
        accountHumanCommand(m, c, ctx);
        ctx.ui.notify(`${c.id}: ${c.status}\n${short(c.result || c.error || "", 1500)}`, c.status === "failed" ? "error" : "info");
      } catch (e) { ctx.ui.notify(explanation(e), "error"); }
    },
  });
}
