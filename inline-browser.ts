import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Child, ChildManager } from "./manager.ts";

const active = (child: Child) => ["starting", "running", "stop_unconfirmed"].includes(child.status);
const money = (cost: number) => `$${cost.toFixed(cost > 0 && cost < 0.0001 ? 8 : cost > 0 && cost < 0.01 ? 4 : 2)}`;
const display = (s: string, n: number) => {
  const clean = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ");
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
};
const elapsed = (child: Child) => {
  const seconds = Math.max(0, Math.floor(((child.finishedAt ?? Date.now()) - child.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
};

type BrowserAction = "s" | "r" | "x" | "d";
type EditorState = { getText(): string; isShowingAutocomplete?(): boolean };

/** Persistent, editor-driven browser. No modal and no Pi session switch. */
export class InlineBrowser {
  private selectedId: string | null | undefined; // undefined = composer; null = main agent
  private showDismissed = false;
  private expanded = false;
  private scroll = Infinity;
  private transcriptRows = 5;
  private transcriptCache?: { id: string; lines: string[] };

  constructor(private readonly manager: ChildManager, private readonly changed: () => void,
    private readonly action: (type: BrowserAction, id: string) => void) {}

  private children(): Child[] {
    return this.manager.list().filter(c => this.showDismissed || !c.dismissed)
      .sort((a, b) => Number(active(b)) - Number(active(a)) || b.startedAt - a.startedAt);
  }
  private selection(children: Child[]): number {
    if (this.selectedId === undefined) return -1;
    if (this.selectedId === null) return 0;
    const index = children.findIndex(c => c.id === this.selectedId);
    if (index >= 0) return index + 1;
    this.selectedId = null;
    this.scroll = Infinity;
    return 0;
  }
  get isBrowsing(): boolean { return this.selectedId !== undefined; }
  invalidateTranscript(): void { this.transcriptCache = undefined; this.changed(); }
  private transcript(id: string): string[] {
    if (this.transcriptCache?.id === id) return this.transcriptCache.lines;
    const lines = this.manager.transcript(id).split("\n");
    this.transcriptCache = { id, lines };
    return lines;
  }
  focus(id: string | null | undefined): void {
    this.selectedId = id;
    this.scroll = Infinity;
    this.expanded = false;
    this.changed();
  }
  shouldShow(branch: ReadonlySet<string>): boolean {
    return this.isBrowsing || this.manager.list().some(c => active(c) && !c.dismissed && (!c.anchor || branch.has(c.anchor)));
  }
  /** Returns false to let the unmodified Pi editor handle the key. */
  handleInput(data: string, editor: EditorState): boolean {
    if (editor.getText().length || editor.isShowingAutocomplete?.()) {
      if (this.isBrowsing) this.focus(undefined);
      return false;
    }
    if (!this.isBrowsing) {
      if (!matchesKey(data, "down")) return false;
      this.focus(null);
      return true;
    }
    const children = this.children();
    const position = this.selection(children);
    if (matchesKey(data, "down")) {
      const next = children[Math.min(children.length - 1, position)]?.id;
      if (next) this.focus(next);
      return true;
    }
    if (matchesKey(data, "up")) {
      this.focus(position <= 0 ? undefined : position === 1 ? null : children[position - 2]?.id ?? null);
      return true;
    }
    if (matchesKey(data, "escape")) { this.focus(undefined); return true; }
    if (data === "h") {
      this.showDismissed = !this.showDismissed;
      this.selection(this.children());
      this.changed();
      return true;
    }
    if (this.selectedId !== null && this.selectedId !== undefined) {
      if (matchesKey(data, "shift+up") || matchesKey(data, "pageup")) { this.scrollBy(-this.transcriptRows); return true; }
      if (matchesKey(data, "shift+down") || matchesKey(data, "pagedown")) { this.scrollBy(this.transcriptRows); return true; }
      if (data === "g") { this.scroll = 0; this.changed(); return true; }
      if (data === "G") { this.scroll = Infinity; this.changed(); return true; }
      if (matchesKey(data, "enter") || matchesKey(data, "space") || data === " ") {
        this.expanded = !this.expanded;
        this.scroll = Infinity;
        this.changed();
        return true;
      }
      if (["s", "r", "x", "d"].includes(data)) {
        this.action(data as BrowserAction, this.selectedId);
        return true;
      }
    } else if (matchesKey(data, "enter")) { this.focus(undefined); return true; }
    // Typing a normal prompt should never get trapped in the browser.
    this.focus(undefined);
    return false;
  }
  private scrollBy(delta: number): void {
    if (!this.selectedId) return;
    const lines = this.transcript(this.selectedId);
    const end = Math.max(0, lines.length - this.transcriptRows);
    const start = this.scroll === Infinity ? end : Math.max(0, Math.min(this.scroll, end));
    const next = Math.max(0, Math.min(end, start + delta));
    this.scroll = next === end ? Infinity : next;
    this.changed();
  }
  render(width: number, tui: TUI, theme: Theme, branch: ReadonlySet<string>): string[] {
    if (!this.isBrowsing) {
      const running = this.manager.list().filter(c => active(c) && !c.dismissed && (!c.anchor || branch.has(c.anchor)));
      const lines = [`Subagents · ${running.length} active · ↓ browse`,
        ...running.slice(0, 3).map((c, i) => {
          const usage = this.manager.currentUsage(c);
          return `${i === running.length - 1 ? "└─" : "├─"} ${c.name || c.definition.name} · ${c.status} · ${c.toolCount} tools${usage ? ` · ${money(usage.cost.total)}` : ""}`;
        }),
        ...(running.length > 3 ? [`  +${running.length - 3} more`] : [])];
      return lines.map((line, i) => truncateToWidth(i === 0 ? theme.fg("accent", line) : line, width));
    }
    const children = this.children();
    const selected = this.selection(children);
    const selectedChild = selected > 0 ? children[selected - 1] : undefined;
    const rows = Math.max(8, Math.min(18, Math.floor(tui.terminal.rows * 0.5)));
    const inner = Math.max(1, width - 4);
    const items: { text: string; selected?: boolean }[] = [
      { text: theme.fg("accent", `Agents  ${children.filter(active).length} active · ${children.length} subagents`) },
      { text: theme.fg("text", `${selected === 0 ? "❯" : " "} Main agent · composer`), selected: selected === 0 },
    ];
    const maxChildren = selectedChild ? Math.max(1, Math.min(4, rows - 9)) : Math.max(1, Math.min(6, rows - 5));
    const startIndex = selectedChild ? Math.max(0, Math.min(selected - 2, children.length - maxChildren)) : 0;
    for (let i = startIndex; i < Math.min(children.length, startIndex + maxChildren); i++) {
      const child = children[i]!;
      const usage = this.manager.currentUsage(child);
      const color = child.status === "failed" ? "error" : child.status === "partial" ? "warning" : child.status === "completed" ? "success" : "accent";
      const label = child.name || child.definition.name;
      const snippet = display(child.task, Math.max(9, inner - label.length - 32));
      items.push({ text: theme.fg(color, `${selected === i + 1 ? "❯" : " "} ${label} · ${snippet} · ${child.status}${usage ? ` · ${money(usage.cost.total)}` : ""}`), selected: selected === i + 1 });
    }
    if (selectedChild) {
      if (rows > 9) items.push({ text: theme.fg("dim", `   ↳ ${elapsed(selectedChild)} · ${selectedChild.toolCount} tools · ${selectedChild.lastTool || "waiting"} · ${selectedChild.id.slice(0, 8)}`) });
      if (this.expanded && rows >= 12) {
        items.push({ text: theme.fg("muted", `Task: ${display(selectedChild.task, inner - 6)}`) });
        if (selectedChild.result) items.push({ text: theme.fg("muted", `Report: ${display(selectedChild.result.replace(/^\[Turn limit [^\n]+\]\n/, ""), inner - 8)}`) });
      }
      const lines = this.transcript(selectedChild.id);
      const transcriptRows = Math.max(1, rows - items.length - 5);
      this.transcriptRows = transcriptRows;
      const end = Math.max(0, lines.length - transcriptRows);
      const start = this.scroll === Infinity ? end : Math.max(0, Math.min(this.scroll, end));
      items.push({ text: theme.fg("muted", `Transcript  ${start + 1}-${Math.min(start + transcriptRows, lines.length)}/${lines.length} · ⇧↑/↓ scroll`) });
      items.push(...lines.slice(start, start + transcriptRows).map(text => ({ text: theme.fg(text.startsWith("tool ") ? "accent" : text.startsWith("assistant") ? "text" : "dim", display(text, 2000)) })));
    }
    const footer = theme.fg("dim", selectedChild
      ? "Esc composer · ↑↓ agent · ⇧↑/↓ scroll · Enter expand · g/G ends"
      : "↓ agents · ↑ composer · h history · Esc composer");
    const w = Math.max(6, width);
    const border = (value: string) => theme.fg("border", value);
    const pad = ({ text, selected }: { text: string; selected?: boolean }) => {
      const clipped = truncateToWidth(text, w - 4);
      const body = ` ${clipped}${" ".repeat(Math.max(0, w - 4 - visibleWidth(clipped)))} `;
      return `${border("│")}${selected ? theme.bg("selectedBg", body) : body}${border("│")}`;
    };
    return [border(`╭${"─".repeat(w - 2)}╮`), ...items.slice(0, rows - 3).map(pad), pad({ text: footer }), border(`╰${"─".repeat(w - 2)}╯`)]
      .map(line => truncateToWidth(line, width));
  }
}
