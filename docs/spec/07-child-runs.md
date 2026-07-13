# Child Runs and Multi-Agent Work

## Requirements

- Child Runs have isolated context.
- Parent definitions may narrow child instructions, tools, mode, model route, budget, permissions, and output schema.
- Parent child-join waits are non-actionable progress. The parent follower remains attached through the join and continues until parent terminal state or a separate explicit external permission request.
- Fan-out supports bounded parallelism.
- Joins support all, first-success, quorum, and best-effort policies.
- Parent and child cancellation are explicit.
- Partial failures remain visible and typed.
- Process termination does not orphan or duplicate Child Runs.

## Product Wiring

Rika submits one immutable Relay fan-out definition with a caller-stable fan-out id, ordered child ids, a positive concurrency bound, and an explicit join policy. General Task prompts select the narrow built-in profile before submission; review checks always use the Review profile and default to best-effort aggregation. Relay owns admission, restart recovery, join transitions, and cancellation propagation. Rika only projects ordered member state, output, and typed failure details beneath the parent Turn.

The fan-out runtime materializes each persisted child override as a deterministic child-specific immutable Relay agent definition before starting that child. The definition applies Relay 0.2.13's supported instruction, model selection and request variant, compaction policy, tool, permission, output-schema, and metadata fields. Fan-out members never replace or mutate the shared root definition, so concurrent main and Oracle children retain their own routes. Every direct, preset, and model-initiated child execution owns a deterministic isolated durable Session, allowing inherited, preset, and explicit compaction policies to survive replay without sharing parent context.

Repeating a submission after restart uses the same fan-out and child ids. A different definition under an existing id is an error; Rika never retries by allocating replacement ids. Child cancellation addresses the Relay child execution directly, while parent cancellation uses Relay's parent execution cancellation and propagation.

## Product Agents

Built-in profiles include `search`, `review`, `oracle`, `librarian`, `painter`, `read-thread`, and general `task`.

## Model-Facing Spawning

The top-level Thread agent may spawn a Child Run on its own initiative. Rika enables Relay's durable child-run tools on the parent agent definition only: the generic `spawn_child_run` tool that targets a registered preset, and one `transfer_to_<profile>` tool per advertised profile. These tools durably start the preset Child Run and resume the parent Turn with the child's terminal output. The media-gated Painter profile is not advertised as a named tool. Child Runs never receive these tools, so subagents cannot spawn further subagents.

## Relay Gate

Rika does not emulate durable children in product code. Missing parallel spawn or join behavior is implemented and released in Relay before Rika consumes it.
