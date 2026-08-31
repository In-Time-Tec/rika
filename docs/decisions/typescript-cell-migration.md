# TypeScript cell migration

Every conversational Rika Agent advertises `typescript({ code })`, executed by a persistent Bun kernel owned per Generalist Session. An Agent with recursive child authority also advertises Generalist's blocking `run_child` and `run_child_group`; a depth-limited leaf advertises only `typescript`, and Title advertises none. Rika's ordinary capability surface reaches the model as `rika.*` host bindings mounted into the kernel rather than as a per-role menu of `Tool.make` declarations.

The reason is context economy and composition. A fixed capability menu spends context on schemas the model may never call, forces every capability to be a separate model turn, and cannot express filtering or partitioning over context that no longer fits the window. A persistent programmable environment lets the model read Session history, thread transcripts, and the continual harness as data, compute over them locally, and return only what it chose to print. Child control is the narrow exception: Generalist, not a JavaScript promise, must persist suspension and resume the same parent Run after settlement.

Authority does not move. Generalist keeps durable Runs, children, cancellation, approvals, and the operation ledger; every `rika.*` call that crosses an authoritative or external boundary runs as a Generalist nested durable operation, so edit, process, and web certainty and approval stay granular. Child admission and waiting use Generalist's native child operations directly. Kernel variables are working memory and are never described as durable.

Presentation does not move either. The transcript gains one `Cell` block; subagent cards, diffs, images, process rows, approvals, and recovery cards keep being driven by Generalist child-tree and tool events, never by parsing cell source.

The cost accepted is that operation-level read/write/shell permission categories cannot be security controls against arbitrary TypeScript, so they are deleted rather than left as misleading UI. The kernel runs with the local user's OS authority and is a lifecycle boundary, not a sandbox. If per-role OS isolation ever becomes a requirement, the capability-only Agent Program design is the correct answer and this migration stops.

The broad many-tool route, QuickJS Code Mode, and `@rika/javascript-sandbox` are deleted at cutover. The cell and two Generalist-native child-control tools are the one production path.
