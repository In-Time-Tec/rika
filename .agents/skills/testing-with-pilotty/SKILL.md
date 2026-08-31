---
name: testing-with-pilotty
description: Drives Rika and reference TUIs through managed PTY sessions using Pilotty. Use for fast interaction checks, terminal resizing, keyboard and mouse input, semantic snapshots, and Amp parity comparisons.
---

# Testing with Pilotty

Use Pilotty for rapid Rika interaction and rendered-screen assertions.

## Workflow

1. Stop stale sessions with `pilotty stop`.
2. Spawn Rika and Amp as separate named sessions in the same workspace.
3. Resize both sessions to identical dimensions before comparison.
4. Use `wait-for` for observable readiness instead of sleeps.
5. Drive keys, typing, clicks, and scrolling through Pilotty.
6. Capture JSON and text snapshots at every comparison checkpoint.
7. Kill sessions or stop the daemon when finished.

```bash
pilotty spawn --name rika --cwd "$PWD" rika
pilotty spawn --name amp --cwd "$PWD" amp --dangerously-allow-all
pilotty resize -s rika 100 30
pilotty resize -s amp 100 30
pilotty wait-for -s rika "Welcome to Rika" -t 15000
pilotty snapshot -s rika --format text
pilotty type -s rika "test prompt"
pilotty key -s rika Enter
pilotty scroll -s rika up 5
pilotty kill -s rika
pilotty kill -s amp
```

Use isolated `HOME`, product SQLite, Generalist SQLite, and `RIKA_TEST_MODEL_SCRIPT` for deterministic agentic workflows. Never treat text echoed in the composer as proof of model completion; wait for a unique scripted response or tool result.

Compare exact terminal dimensions, borders, spacing, labels, colors, cursor placement, wrapping, overlays, transcript cards, and responsive behavior. Save evidence beneath `artifacts/`.
