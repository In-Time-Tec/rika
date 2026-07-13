# Tools and Permissions

## Tool Contract

Every tool defines:

- Schema input and typed output.
- Tagged boundary errors.
- Side-effect class.
- Permission metadata.
- Timeout and cancellation behavior.
- Output limits and spill behavior.
- Idempotency requirements.
- Test layer and deterministic transcript scenarios.

## Included Tool Families

- File finder and content search.
- File and media reading.
- Create, edit, and patch.
- Shell and process status.
- Git inspection.
- Web research.
- Thread retrieval.
- Skills and MCP resources.
- Oracle, Librarian, Painter, Task, and review operations.

Semantic search and ast-grep outline are not included.

Text reads return stable line anchors suitable for strict edits. Edits using stale anchors fail instead of guessing against changed content.

The initial local runtime implements bounded FFF-backed file discovery and content grep, line-numbered reads, create, exact-anchor edit, shell execution, Git status, and Parallel Search API web search. Shell and Git subprocess pipes are always drained, but retained pending output is bounded before polling or result construction; excess output sets a sticky truncation signal and completed process entries are released after terminal polling. One watched FFF index is retained for each tool-runtime lifecycle, honors repository ignore rules, and supplies the TUI `@` file picker. All built-in tool classes default to `allow`, matching Amp's bypass-permissions operation. Explicit user configuration may still select `ask` or `deny`. The runtime receives its Workspace path and redacted Parallel credential at composition and rejects errors through tagged boundaries. Packages never read the credential from the environment.

`web_search.searchQueries` is presented to models as a homogeneous string array with at least one item. Object-shaped and empty values remain invalid and are never normalized into queries.

The initial tools are one Effect AI Toolkit shared by the Baton agent definition and Relay ToolRuntime registration. Relay snapshots the same model-facing schemas it executes, and maps Rika `ask` metadata to durable tool approvals.

## Permission Decisions

The initial canonical policy matches released Baton and Relay behavior: allow, deny, and ask, with supported remembered answers. Relay persists waits when a user answer must survive process termination.

Only `permission.ask.requested` and `tool.approval.requested` create actionable permission cards. Generic `wait.created` records are execution progress and never imply permission, including child joins. The request kind is preserved through TUI action and app resolution; a tool approval can call only the tool-approval resolver and a permission ask can call only the permission resolver. Missing or mismatched kinds are not resolved by fallback.

Input replacement and synthetic results remain framework-blocked. They may be added only after Relay publishes a pre-persistence policy seam whose selected input or synthetic output and policy provenance are canonical, replayable execution facts. Plugin tool-call hooks use the same seam rather than a second policy system.

Visible side effects are idempotent or explicitly confirm-gated.
