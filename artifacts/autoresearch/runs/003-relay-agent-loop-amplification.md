# Run 003: Relay Agent-Loop Policy Loss and Empty Event Amplification

Date: 2026-07-14

Status: reproduced against Rika's released dependency path; independent design review pending

Owner candidates: Relay SDK policy persistence and Relay runtime steering projection

## Workload

- Rika revision: `a67703464bca934f51037f2978d74c8631b2c67c`
- Published dependencies: `@batonfx/core@0.4.3`, `@relayfx/sdk@0.2.15`
- Public Rika `ExecutionBackend` over Relay embedded SQLite
- Baton's deterministic TestModel
- Ten sequential `read_file` tool calls followed by one text completion
- No steering or follow-up input sent

The reduction is retained at `/tmp/rika-baton-turn-cap-repro.ts`. Output is retained at `raw/003-relay-turn-policy-repro.json`.

## Results

| Signal | Expected | Actual |
| --- | ---: | ---: |
| Baton model requests | at most the default turn policy | 11 |
| Tool turns | at most 8 | 10 |
| Durable `steering.received` events without steering | 0 | 11 |
| Total durable execution events | bounded by useful work | 48 |
| Execution result | turn-policy termination before excess calls | completed after all scripted calls |

## Policy-loss boundary

Rika registers:

```text
Agent.make("rika", ...)
```

Baton gives that agent its default portable `recurs(8)` policy.

Relay `0.2.15` reads the Baton policy snapshot, but its public client adapter deliberately omits the durable field when the policy is exactly `recurs(8)`. Relay's runtime later reconstructs a definition with no `turn_policy` or `max_tool_turns` as `recurs(Infinity)`.

Current Relay `main` contains the same behavior:

- `packages/relay/src/client.ts:813-824`
- `packages/runtime/src/agent/agent-loop-service.ts:142-147`
- `packages/relay/test/embedded-client.test.ts:819-844` currently asserts that the default policy is omitted

Conclusion: Relay fails to preserve the portable Baton policy it accepted. This removes Rika's agent-loop safety cap and allows model, tool, event, context, time, and cost growth beyond the product's configured agent semantics.

## Empty steering-event boundary

Relay's Baton steering adapter drains steering before model turns and follow-up input at completion. `packages/runtime/src/agent/relay-steering.ts:101-120` allocates an event sequence and appends `steering.received` even when the repository returned zero messages.

The reproduction emitted ten empty `kind: steering` events and one empty `kind: follow_up` event. Each had empty content, no message sequences, and `message_count: 0`.

Conclusion: Relay durably projects no-op drains as user-visible execution events. Long tool loops therefore amplify the event log and every downstream replay, projection, transport, logging, and rendering path even when no user input exists.

## Required design review

Before implementation, independently verify:

- whether Relay should always persist Baton's portable snapshot or only stop special-casing `recurs(8)`;
- compatibility for existing Relay definitions where both durable policy fields are absent;
- whether empty drains need repository records for idempotency while still avoiding an execution event;
- how event-sequence allocation remains monotonic without reserving unused event slots;
- restart, replay, concurrent steering, and follow-up delivery invariants;
- separate issue and release acceptance for the policy-loss and empty-event defects.
