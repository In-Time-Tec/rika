# TypeScript cell migration

Every conversational Rika Agent advertises exactly one model-facing tool, `typescript({ code })`, executed by a persistent Bun kernel owned per Baton Session. Rika's capability surface reaches the model as `rika.*` host bindings mounted into that kernel, not as a per-role menu of `Tool.make` declarations.

The reason is context economy and composition. A fixed tool menu spends context on schemas the model may never call, forces every capability to be a separate model turn, and cannot express filtering, partitioning, or delegation over context that no longer fits the window. A persistent programmable environment lets the model read Session history, thread transcripts, and the continual harness as data, compute over them locally, and return only what it chose to print.

Authority does not move. Baton keeps durable Runs, children, cancellation, approvals, and the operation ledger; every `rika.*` call that crosses an authoritative or external boundary runs as a Baton nested durable operation, so edit, process, web, and child-call certainty and approval stay exactly as granular as they are today. Kernel variables are working memory and are never described as durable.

Presentation does not move either. The transcript gains one `Cell` block; subagent cards, diffs, images, process rows, approvals, and recovery cards keep being driven by Baton child-tree and tool events, never by parsing cell source.

The cost accepted is that operation-level read/write/shell permission categories cannot be security controls against arbitrary TypeScript, so they are deleted rather than left as misleading UI. The kernel runs with the local user's OS authority and is a lifecycle boundary, not a sandbox. If per-role OS isolation ever becomes a requirement, the capability-only Agent Program design is the correct answer and this migration stops.

The many-tool route, QuickJS Code Mode, and `@rika/javascript-sandbox` are deleted at cutover. No permanent dual production path.
