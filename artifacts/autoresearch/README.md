# Rika Autoresearch Record

Started: 2026-07-14T18:01:22Z

This directory is the append-only coordinator record for `TASK.md`.

## Current state

- Active Rika stress finding: [Rika #117](https://github.com/dallenpyrah/rika/issues/117), idle packaged TUI CPU use.
- First workload: packaged TUI startup, idle welcome, one deterministic Turn, and terminal idle.
- Pilotty and agent-tty are available through `bunx`; neither command is installed directly on `PATH`.
- The main worktree contained unrelated changes before autoresearch began. They are not owned by this loop.

## Records

- `environment.md`: starting revision, package, host, tool, and worktree snapshot.
- `issues.md`: starting GitHub issue inventory and newly discovered findings.
- `runs/001-idle-cpu.md`: first repeated packaged TUI stress result.

## Next experiment

Run the TUI from source with symbols and isolate client rendering from Resident Rika Service transport/runtime activity. Measure each process before changing code, then dispatch the proved owner to an isolated fixer worktree.
