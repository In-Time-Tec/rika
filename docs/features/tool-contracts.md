# Tool contracts

The one model-visible tool is `typescript`. The capabilities behind it are `rika.*` bindings, which use Schema inputs, typed success and failure results, and bounded output. Calls run through Effect scopes so timeout or Execution cancellation interrupts work and releases owned resources.

The canonical local contract is `rika.workspace.read`, `rika.workspace.write`, `rika.workspace.replace`, and `rika.processes.start`. `read` accepts an optional inclusive two-element `range` and returns numbered lines. `write` creates or overwrites a file. `replace` swaps `oldStr` for `newStr`, with optional `replaceAll`. `processes.start` runs a shell command string with optional `workdir` and `timeoutMillis`.

Each contract states whether repeating a call is safe. Read-only calls may be retried against current local state; writes and process calls are not assumed idempotent, and callers must not repeat a mutation whose outcome is unknown.
