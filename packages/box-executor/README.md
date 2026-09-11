# Box executor

This package controls Box workspace lifecycle only. Generalist remains the durable authority for accepted inputs, lifecycle intent and outcome, agent turns, model calls, and tool operations. API composition must invoke `boxWorkspaceLifecycleTool` only after an Orb input has been canonically accepted; constructing an actor or reading a Thread or Session must not invoke it.

## Runtime boundary

`BoxProvider` implements the typed Box HTTP control plane. Its Layer constructor closes over the redacted fleet credential; lifecycle schemas, Generalist operation payloads, outcomes, and errors contain no credential field. `WorkspaceEnrollment` is the separate injected daemon boundary. A Box becomes usable only after its provider state is ready, one narrowed enrollment completes, and `HandshakeEvidence` matches every field of the admitted `WorkspaceBinding`.

Preparation and fork require a finite TTL of at most 24 hours, `noEnv: true`, and an empty per-Box environment. Stop always sends `force: false`. Resume and fork require a fresh assignment fence; a fork also requires a different workspace and lineage. Stop returns the provider's snapshot reference rather than downloading or rebuilding an archive.

Generalist 0.65.3 supplies its Runtime-backed `NestedOperation` host to independent `host.tools.start` executions as well as Agent tool operations. API composition can schedule each canonically accepted lifecycle intent as an independent Tool Run without a model. Calls outside a Generalist Tool operation context still fail with `durability-unavailable` before contacting Box; there is no `NestedOperation.layerDirect` fallback. The model-free Runtime test verifies exact-command recovery across fresh Layers without repeating fork or enrollment. The separate scripted-model test qualifies Agent-tool replay, not production scheduling or authorization.

## Provider limits

- Box retains create and fork idempotency keys for 24 hours. The HTTP adapter retries transport failures, 5xx responses, and `idempotency_in_progress` only with the exact key and body inside that window. It fails closed on `idempotency_key_reused`; after expiry it performs no billable request because the public API exposes no lookup by idempotency key that could prove absence.
- A template pin is a stopped source Box ID plus its latest completed snapshot ID. The controller checks both immediately before and after fork. Box fork has no immutable snapshot selector or conditional snapshot parameter, so the provider contract cannot eliminate a concurrent-resume race or prove which snapshot the fork consumed. Keep template Boxes under exclusive fleet control.
- `noEnv: true` and `env: {}` constrain the outbound create, fork, and resume request. Box responses do not attest the effective `noEnv` setting, so the request alone is not proof that no environment values reached the machine. Verify credential isolation separately during enrollment and runtime qualification.
- Snapshots preserve filesystem state, installed files, and enabled services. They do not preserve memory, hand-run processes, PTYs, open ports, network identity, SSH host keys, or Docker build cache. Resume uses the same Box ID on a new machine; fork creates a new Box from the source's latest snapshot.
- Create, fork, and resume each consume a machine start. Current concurrency, start-rate, billing, and per-member limits come from `GET /limits`; this package does not hard-code plan capacity.
- Box currently places cloud VMs and snapshots in Germany, Finland, and France. Cloud sizes use shared x86_64 vCPUs and documented storage floors; this package makes no E2B-equivalence claim about region, architecture, isolation, or capacity.
- A snapshot failure causes ordinary stop to be refused while the Box remains recoverable. This package exposes no delete or force-stop operation.

Provider contracts: [Public API v1](https://docs.ascii.dev/box/api/v1), [Snapshots & Copies](https://docs.ascii.dev/box/snapshots.md), [Build a Platform on Box](https://docs.ascii.dev/box/platform-guide.md), [Billing & Limits](https://docs.ascii.dev/box/billing.md), and [Machine Capabilities](https://docs.ascii.dev/box/machines.md).
