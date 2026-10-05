# Subagents for Pi

This Pi 1.0.2 extension runs persistent, in-process Pi SDK child sessions. **Every new child is general-purpose.** Its parent chooses its exact tool allowlist when spawning it; there are no role presets or agent-definition files. `~/.pi/agent/agents/*.md` and `.pi/agents/*.md` are not read.

## Install

On another machine, install Pi and configure your model, then install this public Pi package (no GitHub credentials required):

```sh
pi install git:github.com/sony-tark/subagents
pi
# In Pi: /subagents tools
```

Use `pi update --extensions` to pull changes later. Do **not** also copy this package into `<agent-dir>/extensions/subagents/` on the same machine: Pi would load it twice. This extension was tested on Pi 1.0.2 (`pi --version`); other versions may need changes. You can instead install the entire repository directory at `~/.pi/agent/extensions/subagents/` for local development; set `PI_CODING_AGENT_DIR` to change the agent directory. Restart Pi after changing extension code or switching install methods.

## Use

- A parent delegates with `delegate_agent({task:"Inspect the code",tools:["read"]})`. `tools:[]` gives the child no file or command tools. The only supported delegable tools are `read`, `grep`, `find`, `ls`, `bash`, `edit` and `write`. Only tools **currently active on the spawning parent** can be granted; nested children can receive only a subset of their parent's grant. `/subagents tools` shows the root parent's available tools. Pi's default root tools are typically `read`, `bash`, `edit` and `write`; enable other tools on the parent before delegating them.
- `bash`, `edit` and `write` run **without extra human confirmation once delegated**. Parent approval here is the tool list supplied at spawn, not a per-call prompt. Give children the minimum access needed; this is not an OS sandbox. The child receives `agent_*` aliases, not unwrapped Pi tools.
- `/subagents run --tools=read Inspect the code` waits for a fresh child. `/subagents background --tools=read Investigate the failure` starts one in the background. A root background launch requires a previously saved parent conversation and a long-lived TUI or RPC session; print/JSON sessions cannot keep background work running.
- `/subtask --tools=read TASK` or `delegate_agent({task:"...",tools:["read"],fork:true})` forks the parent's conversation. In-flight tool calls are copied with explicit synthetic error results, not replayed. Forking persists parent context in the child's private store; grant only tools and context the child should see.
- `delegate_agent({task:"...",tools:["read","bash","edit","write"],worktree:true})` starts in a detached Git worktree at `HEAD`. Uncommitted parent changes are not copied; worktrees remain for inspection and are not merged or deleted. Worktree creation requires a delegated `bash` grant and can execute checkout hooks/filters; use only trusted Git configurations.
- `send_agent`, `agent_status`, and `stop_agent` communicate with running children. `/subagents send ID TEXT`, `/subagents resume ID TASK`, `/subagents stop ID`, `/subagents detach ID`, `/subagents open ID`, and `/subagents tasks` are user commands. `Alt+Shift+B` detaches the newest foreground child without restarting it.
- In an **empty Pi composer**, Down selects Main agent; Down again selects a subagent. Up moves back. The inline panel shows active-first children and a live transcript without switching Pi sessions. Shift+Up/Down (or Page Up/Down) scrolls; `g` jumps to the start and `G` follows the latest output. Enter/Space expands a task/report; `h` shows dismissed history; `s` sends a message, `r` resumes, `d` detaches, `x` stops/dismisses, Esc returns to the composer. Draft text and autocomplete retain the editor's normal keys. In regular terminal mode, use keyboard scrolling; the mouse wheel belongs to terminal scrollback.

`maxTurns` (1–100) can cap completed assistant turns. The last available turn is reserved for a tool-free partial report if earlier turns used tools; exhausting the cap returns **partial**, not success. Follow-up/resume resets that turn count but restores the child's **frozen** tool grant, never a broader one. Runs are limited to three child layers and 20 concurrent sessions. Names cannot be reused under the same parent; child IDs remain stable across runs. A nested background report goes to its immediate parent, which waits for descendants to settle before finishing.

## Lifecycle and safety

Child registry, inbox, and sessions are saved under `<agent-dir>/subagents/<parent-session-id>/`. Finished child SDK sessions are disposed; saved history remains for viewing and follow-up. Closing/replacing the Pi session aborts active children. A long-lived TUI/RPC owner can cold-resume saved history with `/subagents resume ID TASK`, not an in-flight tool call. A resume rechecks that the root still has all delegated tools and each nested child's tools remain a subset of its parent. Saved children from the removed role/definition system cannot be resumed; start a new general-purpose child instead. Human-stopped children require a human resume. Crash-window messages with uncertain delivery are not silently replayed.

Children do not implicitly load parent extensions, MCP servers, skills, templates, hooks, project settings, or arbitrary `~/.pi/agent/agents/` files. Tool grants are frozen in the saved child record. Background children wait for their parent launch result to persist before executing tools, and write/command aliases refuse work if their owning session or branch is no longer active. Read tools still have the Pi user's filesystem privileges; Git worktrees isolate tracked files, **not** OS permissions. If stronger isolation is needed, run Pi in a separate user/container.

Completed child usage is shown in the task list and accounted to the owning parent branch where possible. Crash windows and orphaned branches can leave usage in the child ledger without exactly-once parent accounting. Completion notices are automated messages, not human commands; exactly-once delivery is not promised.

## Tests

From the package directory, run `node --test tests/extension.test.cjs` and `python3 tests/tui-smoke.py`. The tests require Pi 1.0.2 (or `PI_SUBAGENT_ESBUILD` and `PI_SUBAGENT_SDK` paths); the offline TUI smoke test also needs `pi`, Node and Python 3 on `PATH`.
