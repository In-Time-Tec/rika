# Tool contracts

Model-visible tools use Schema inputs, typed success and failure results, declared timeouts, and bounded output. Calls run through Effect scopes so timeout or Execution cancellation interrupts work and releases owned resources.

The canonical model-visible local contract uses the lowercase names `read`, `edit`, `write`, and `bash`. `read` accepts an optional inclusive `read_range` and returns numbered lines. `write` creates or overwrites a file. `edit` replaces `old_str` with `new_str`, with optional `replace_all`. `bash` runs a shell command string with optional `workdir` and `timeout_ms`. There is no model-visible `apply_patch` tool.

Each contract states whether repeating a call is safe. Read-only calls may be retried against current local state; writes and process calls are not assumed idempotent, and callers must not repeat a mutation whose outcome is unknown.
