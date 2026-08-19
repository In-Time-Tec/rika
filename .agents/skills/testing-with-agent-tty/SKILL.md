---
name: testing-with-agent-tty
description: Drives and records Rika TUI sessions with Ghostty-backed snapshots, PNG screenshots, and recordings. Use for exhaustive TUI acceptance testing and reviewer-facing Amp parity evidence.
---

# Testing with agent-tty

Use agent-tty for stable semantic snapshots and visual proof artifacts.

## Workflow

1. Create an isolated agent-tty home.
2. Run `doctor --json` before visual capture.
3. Create a shell session and launch the packaged Rika or Amp binary inside it.
4. Use `batch`, `wait`, and `send-keys`; avoid blind sleeps.
5. Capture semantic snapshots and PNG screenshots at matching dimensions.
6. Export an asciicast or WebM for long workflows.
7. Destroy every session.

```bash
TTY_HOME="$(mktemp -d)"
agent-tty --home "$TTY_HOME" doctor --json
SID=$(agent-tty --home "$TTY_HOME" create --json -- /bin/bash | jq -r '.result.sessionId')
agent-tty --home "$TTY_HOME" run "$SID" 'rika' --no-wait --json
agent-tty --home "$TTY_HOME" wait "$SID" --text 'Welcome to Rika' --json
agent-tty --home "$TTY_HOME" snapshot "$SID" --format text --json
agent-tty --home "$TTY_HOME" screenshot "$SID" --json
agent-tty --home "$TTY_HOME" record export "$SID" --format webm --json
agent-tty --home "$TTY_HOME" destroy "$SID" --json
```

Use fixed dimensions, isolated databases, deterministic model scripts, unique completion markers, and actual filesystem assertions. Capture both Rika and Amp with the same renderer, font, dimensions, and terminal settings before making pixel claims.
