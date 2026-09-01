# Tool contracts

Rika exposes exactly four native execution tools beside Generalist's built-in child delegation:

- `bash({ command, workdir?, timeout_ms? })`
- `edit({ path, old_str, new_str, replace_all? })`
- `read({ path, read_range? })`
- `shell_command_status({ processId, waitMillis? })`

Provider-neutral Effect schemas live in `packages/product`; live local and remote behavior lives in `packages/execution`. The schemas bound input and output sizes, produce typed failures, and generate the model-facing surface description so instructions cannot drift from runtime validation.

`bash` runs a recorded command in the shared scoped process registry. A command that outlives its foreground wait returns a process ID. The model must call `shell_command_status` explicitly to observe later output and settlement. `read` returns bounded numbered lines. `edit` requires an exact old string, applies an optional all-occurrences replacement, and returns the authoritative diff.

Read and status calls may be repeated against current state. A timed-out or disconnected `bash` or `edit` can have an unknown outcome and is never replayed blindly. Runner and Orb execution place the native request inside one durable outer operation with stable operation, attempt, tool-call, and machine identities.
