#!/usr/bin/env python3
"""Offline end-to-end check of inline navigation and transcript scrolling in Pi's real TUI.

Run: python3 tests/tui-smoke.py
Creates a disposable saved child with synthetic transcript lines. No model is called.
"""

import fcntl
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from uuid import uuid4

ROOT = Path(__file__).resolve().parent.parent
SDK = Path(os.environ.get("PI_SUBAGENT_SDK", Path.home() / ".pi/agent/install/releases/1.0.2/node_modules/@earendil-works/pi-coding-agent/dist/index.js"))
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")
FIXTURE = r"""
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { SessionManager } = await import(pathToFileURL(process.env.PI_SUBAGENT_SDK).href);
const agent = process.env.PI_CODING_AGENT_DIR, root = process.env.FIXTURE_ROOT;
const store = SessionManager.create(process.cwd(), path.join(agent, 'synthetic-sessions'));
for (let n = 0; n < 80; n++) store.appendMessage({ role: 'user', content: `line ${n}`, timestamp: Date.now() + n });
const child = {
  id: randomUUID(), runId: randomUUID(), parentSessionId: root, anchor: null, depth: 1,
  definition: { name: 'general-purpose', description: 'Fixture', prompt: 'Fixture', tools: ['read'], source: 'built-in' },
  task: 'Synthetic read-only child', status: 'completed', startedAt: Date.now() - 20000,
  finishedAt: Date.now(), toolCount: 0, result: 'Synthetic report', file: store.getSessionFile(), background: true,
};
const dir = path.join(agent, 'subagents', root);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'records.json'), JSON.stringify([child]));
"""


def run():
    if not SDK.is_file():
        raise RuntimeError("Pi SDK unavailable; set PI_SUBAGENT_SDK to its dist/index.js")
    agent = Path(tempfile.mkdtemp(prefix="pi-inline-tui-test-"))
    root_id = str(uuid4())
    env = {
        **os.environ,
        "PI_CODING_AGENT_DIR": str(agent),
        "PI_SUBAGENT_SDK": str(SDK),
        "FIXTURE_ROOT": root_id,
        "PI_OFFLINE": "1",
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
    }
    master = None
    process = None
    try:
        subprocess.run(["node", "--input-type=module", "-e", FIXTURE], env=env, check=True, stdout=subprocess.DEVNULL)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        process = subprocess.Popen(
            ["pi", "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-approve",
             "--tui-mode", "fullscreen", "--session-id", root_id, "--session-dir", str(agent / "root-sessions"),
             "--extension", str(ROOT / "index.ts")],
            stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True,
        )
        os.close(slave)

        def receive(timeout):
            output = bytearray()
            until = time.monotonic() + timeout
            while time.monotonic() < until and process.poll() is None:
                ready, _, _ = select.select([master], [], [], 0.1)
                if ready:
                    try:
                        output.extend(os.read(master, 16384))
                    except OSError:
                        break
            return ANSI.sub("", output.decode("utf-8", "replace"))

        def press(key, expected, label):
            os.write(master, key)
            output = receive(0.8)
            if not expected(output):
                raise AssertionError(f"{label} failed (child running: {process.poll() is None})")

        receive(2.5)  # Offline startup, without a provider request.
        press(b"\x1b[B", lambda text: "Main agent" in text, "Down selects Main agent")
        press(b"\x1b[B", lambda text: "Transcript" in text and "line 79" in text,
              "Down selects child and follows its latest transcript")
        press(b"\x1b[1;2A", lambda text: "Transcript" in text and bool(re.search(r"line 7[0-8]", text)),
              "Shift+Up scrolls the child transcript")
        press(b"\x1b[1;2B", lambda text: "line 79" in text, "Shift+Down returns to the latest line")
        press(b"\x1b[A", lambda text: "Main agent" in text, "Up selects Main agent")
        press(b"\x1b[A", lambda text: "Main agent" not in text and bool(text.strip()),
              "Up returns to the composer")
        print("Pi TUI inline selector and transcript scrolling: PASS (offline synthetic child)")
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if master is not None:
            os.close(master)
        shutil.rmtree(agent, ignore_errors=True)


if __name__ == "__main__":
    run()
