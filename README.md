# Subagents for Pi

This extension runs **persistent in-process Pi SDK child sessions**, rather than Pi's separate-process one-shot subagent example. It was built for Pi 1.0.2. Install the **entire** `subagents/` directory at `<agent-dir>/extensions/subagents/` (by default `~/.pi/agent/extensions/subagents/`); `index.ts` imports the other files. Set `PI_CODING_AGENT_DIR` to change `<agent-dir>`. Pi loads the extension in every project automatically, without `-e` or project trust. Start a new Pi session (or run `/reload` after a fresh install), then run `/subagents definitions` to confirm it loaded. If you renamed an extension already loaded in a running Pi session, restart Pi without any old `-e` path instead of relying on `/reload`.

## Install from GitHub

This public repository is a Pi package: `package.json` points Pi to `index.ts`. On the other machine, install Pi, set up access to your model, then run (no GitHub credentials required):

```sh
pi install git:github.com/sony-tark/subagents
pi list
pi
# In Pi, run: /subagents definitions
```

Run `pi update --extensions` to pull later changes. Pi installs the package into its own managed directory and adds it to your personal settings. **Do not also keep a manual copy in `<agent-dir>/extensions/subagents/` on that machine**, or Pi will load both copies and their commands/tools will conflict. The extension was tested with Pi 1.0.2 (`pi --version`); other versions may need changes. Copy custom definitions from `<agent-dir>/agents/` separately if you use them.

### Install without GitHub

If GitHub is unavailable, you can transfer the directory manually instead. On the source machine (macOS/Linux), package and transfer the whole directory:

```sh
tar -czf subagents.tar.gz -C "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions" subagents
scp subagents.tar.gz USER@HOST:~/
```

On the destination (replace `USER@HOST` above with its SSH login):

```sh
mkdir -p "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
tar -xzf ~/subagents.tar.gz -C "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
pi
# In Pi, run: /subagents definitions
```

If an older copy is installed under the previous directory name, remove it before starting Pi; loading two copies causes command/tool name collisions. Saved child sessions, model credentials, and other Pi settings are not included in the archive.

## Use

- Ask the model to use `delegate_agent({agent:"explore",task:"Find ..."})`. Other built-ins: `general-purpose`, `reviewer` (inspection-only), and `worker` (write/execute, with **approval on every** bash/edit/write call). `send_agent`, `agent_status`, and `stop_agent` are model-facing tools.
- `/subagents run explore Find authentication files` waits for a fresh child to finish.
- `/subagents background general-purpose Investigate the failure` accepts a long-running child. First send a normal message so the parent session is saved. Background is available only in TUI and long-lived RPC, not print/JSON.
- In the **empty Pi composer**, press **Down once** to select **Main agent** in the inline panel below the composer. Press Down again to select the first subagent; further Down/Up moves through active-first subagents. Up from Main agent returns to normal composer navigation. Selecting a subagent shows its live transcript *without a popup or session switch*, so child tool restrictions remain in force. **Shift+Up/Down** (or Page Up/Down) scrolls that transcript; `g` jumps to the beginning and `G` resumes following new output. Enter/Space expands the task and report; `h` shows dismissed history; `s` sends a message, `r` resumes, `d` detaches, `x` stops/dismisses; Esc returns to the composer. With draft text or autocomplete active, the editor keeps its normal keys. In regular terminal mode the mouse wheel belongs to terminal scrollback; use the keyboard to scroll the inline transcript. The passive panel shows only active children, while finished children remain in inline history and saved transcripts. `/subagents tasks` is an optional way to select Main agent, not a popup.
- `/subagents open ID` (also `/subagents show ID`) selects that child directly in the inline TUI panel. `/subagents send ID TEXT`, `/subagents resume ID TEXT`, `/subagents stop ID`, `/subagents detach ID`, `/subagents definitions` also work directly. Non-TUI `show` remains a truncated notification. User commands require a UI; print-mode scripts should use model tools. `Alt+Shift+B` detaches the newest foreground child without restarting it; Pi already uses Ctrl+B for cursor-left.
- `/subtask TASK` or `delegate_agent({agent:"explore",task:"...",fork:true})` snapshots parent context, including its effective system prompt and an **in-flight assistant tool call**. Any missing tool result becomes an explicit *synthetic error placeholder*, not a replay of the operation or its real result. The child uses the parent's model and its own approved tools. Forks persist the inherited prompt and conversation in the private child store; do not fork context you would not expose to that child. This is not a bit-exact fork of provider state.
- `delegate_agent({agent:"worker",task:"...",worktree:true})` starts at a detached Git `HEAD` in a separate worktree. Uncommitted parent changes are *not* copied. Worktrees and any changes remain for inspection; nothing is merged or deleted automatically. **Caution:** creating a worktree can itself execute configured Git checkout hooks or filters before an `agent_bash` approval; use only in repositories with trusted Git configuration.

User agent definitions can be placed recursively under `~/.pi/agent/agents/*.md`; trusted project definitions under `.pi/agents/*.md`. Project definitions require Pi project trust (the new directory does not trigger Pi's trust prompt by itself). Example:

```markdown
---
name: investigator
description: Inspect a subsystem
model: azure-openai-responses/gpt-6-sol
tools: read, grep, find, ls
isolation: worktree
maxTurns: 6
memory: user
---
Inspect carefully and report concrete evidence.
```

Supported fields: `name`, `description`, `model`, `tools`, `disallowedTools`, `isolation: worktree`, `maxTurns` (integer 1–100), `memory: user|project`, `mcpServers`, and `hooks` (`PreToolUse`/`PostToolUse`). Unsupported fields and invalid tools are reported by `/subagents definitions`, not silently honored. `delegate_agent({...,maxTurns:3})` overrides the definition for that child. If earlier turns used tools, the last allowed assistant turn is reserved for a **tool-free partial report**, with verified findings and what's left undone; no extra turn is purchased. Reaching the cap yields **partial**, not success. If the model still produces no narrative (or `maxTurns:1` runs out on a tool call), the result states how many tools ran, the last tool and any clearly labeled unverified note, and offers a resume path instead of an empty report. Follow-up/resume restores the approved tools and resets the per-run turn count. Any queued messages cut off by the cap are marked uncertain, never silently replayed; inspect the transcript and resend as needed. The effective tool set is frozen in the saved child record; resuming after trust, tool, memory, hook or MCP policy changes is refused. Runs are limited to three child layers and 20 concurrent child sessions per parent session. A child can delegate foreground **or background** descendants and message a running sibling. A nested background report goes to its *immediate* parent; that parent waits for active descendants to settle and process notices before it reports completion. Names cannot be reused under the same parent; IDs remain stable across runs.

**Explicit resources (not inherited by default):** `memory: user` stores a per-definition file under `~/.pi/agent/subagent-memory/`; `memory: project` requires a trusted project definition and uses `.pi/agent-memory/<name>.md`. The first 12,000 characters are provided as reference context and `agent_memory` can read it; replacing it requires a separate human approval displaying the *entire* file content to be written (at most 1200 characters including its path). Memory is data, not an approval. `mcpServers` maps server names to a `command`/`args` or `url` plus optional `env`, `headers`, `cwd`, `timeout`. The human must approve each server startup **and** each MCP tool/resource call; `env`/`headers` values must be exact `${VAR}` references, never literal credentials or `!command`. URLs require HTTPS except on loopback and cannot embed credentials or a query string. `hooks` accepts `PreToolUse` and `PostToolUse` lists of `{command,args?}`; hook commands run without a shell, with a 5-second limit and an independent human approval on **every** invocation. A denied/failed pre-hook blocks the tool; post-hook errors are warnings, not changes to past results. MCP and hooks are refused without an owning TUI/RPC approval UI. These are intentionally **narrower** than Claude's general hooks/MCP/memory system; no implicit parent resources, skills, codemode, user extensions or project settings are loaded.

## Lifecycle and safety

The registry, inbox and child sessions live under `~/.pi/agent/subagents/<parent-session-id>/`. Child SDK sessions and subscriptions are disposed after each finished run; saved transcripts and records remain for viewing and a later follow-up. Closing/replacing the Pi session aborts active children; a later long-lived **TUI/RPC** parent can cold-resume saved history with `/subagents resume ID TASK`, **not** a pending tool call. Cold resume from print/JSON is refused because its new background run would be killed when the host exits. User-stopped children require a human resume. Crash-window messages not found in the transcript are marked uncertain and are **not** silently replayed. Background status messages are held until the owning parent branch is active and a launch tool result has been persisted. A panel-row dismissal does not delete saved history.

Child sessions do not **implicitly** discover executable extensions, MCP servers, skills, templates, hooks, or project settings. Only explicit, trusted definition MCP servers and hook commands run, with the human gates described above. Built-in operations are exposed through `agent_*` wrappers: background model-launched children cannot run a tool until their parent launch result is persisted. Read tools are **not** an OS/file-access sandbox: they can still read anything accessible to the Pi account. `worker` enables *aliased* `agent_bash`, `agent_edit` and `agent_write` only; each invocation calls the owning human's Pi UI approval dialog with **all** arguments and a timeout, and is denied if the UI/session is gone or the argument JSON exceeds 1200 characters (it must not hide a dangerous suffix in a truncated approval). Worktrees isolate Git working files, not OS permissions. Run Pi under a separate OS user/container if stronger isolation is needed.

**Usage and remaining differences:** completed-response costs (not tokens still streaming) are shown as estimated USD in the task list, live view, and passive panel; model-tool results and completion notices show finished cost. Foreground model-tool results include aggregate descendant usage once; human-launched foreground `/subagents run` and `/subtask` commands record usage directly because they have no model-tool result. Background usage is added as a run-keyed Pi `UsageEntry` on the owning active branch after launch acknowledgment (including nested background usage in the intermediate parent). Those entries contribute to Pi's `/session` cost total; the child record retains separately measured usage. An orphaned branch or an unconfirmed crash window can leave usage only in the child ledger; never assume physical exactly-once parent accounting across concurrent process crashes. A fork's unfinished tool results are **placeholders**, not exact live provider/tool state. Pi CLI print/JSON cannot keep background work running; arbitrary Claude memory/hook/MCP semantics, skills, team mailboxes, and the independent-session `claude agents` dashboard remain outside this module. Notifications are manager-authored messages, not human commands, and exactly-once delivery is not promised.

Run `node --test tests/extension.test.cjs` for unit/SDK regressions, then `python3 tests/tui-smoke.py` for an offline **real Pi TUI** check of Down/Up navigation and Shift+Up/Down scrolling with a disposable synthetic child. The tests require the Pi 1.0.2 installation (or `PI_SUBAGENT_ESBUILD` and `PI_SUBAGENT_SDK` paths); the TUI smoke test also needs `pi`, Node, and Python 3 on `PATH`.
