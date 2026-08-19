# Local and remote execution

Creating a Thread without a placement option creates a `local-device` Thread. Creating it with the explicit remote option creates an `e2b` Thread. Placement is durable and immutable; an unavailable Executor reports its state instead of silently moving the Thread.

The selected Executor owns Workspace access, kernels, coding tools, and processes. The control plane hosts Baton's PostgreSQL runtime, model loop, and encrypted provider credential use, then dispatches Workspace operations through Baton's stable remote-tool operation key. The Executor connects outbound, accepts work only while holding the current assignment generation, durably deduplicates operation keys, and publishes resumable results. Every mutation includes the assignment and generation so a replaced Executor is fenced even if its old process is still running.

An E2B Executor receives a fresh Project checkout, runs repository setup, pauses after fifteen idle minutes, and resumes when authorized work arrives. Pause and snapshots improve Workspace continuity but are not authority. Recovery uses committed Baton and control-plane cursors, checkout identity, and checkpoint metadata; a replacement increments the assignment generation before accepting work. No E2B controller credential reaches a CLI or TUI.
