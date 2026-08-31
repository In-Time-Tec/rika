# Measured interactive latency

This note records the 2026-08-31 performance pass and the subsequent removal of its synthetic
startup preview. It separates the first real TUI frame from a usable connection, durable queue
admission, execution, and model completion. Those boundaries must not be collapsed into one
favorable number. Preview measurements remain below as historical evidence, not as the current
interaction or performance target.

Except for the current first-frame follow-up identified below, the measurements were made on
macOS arm64 with the packaged Rika 0.11.5 client, a local API and PostgreSQL database, and an
already authenticated profile. Provider-backed samples used only OpenRouter
`z-ai/glm-5.3-flash`. Results from another machine, network, database, or provider must be
measured again rather than inferred from these values.

## Boundaries

| Boundary                   | Meaning                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| First terminal byte        | The first OpenTUI terminal-capability probe or draw byte written by the new process.                                  |
| First real frame           | The first complete synchronized OpenTUI frame containing the welcome surface and orb.                                 |
| `process_start`            | Effect command dispatch has started after the runtime loaded and parsed the command.                                  |
| `first_draw`               | The real OpenTUI surface invoked its first-render callback. This corresponds to the real frame, not a native preview. |
| Connection ticket complete | The ticketed WebSocket setup request completed. This is a diagnostic sub-boundary, not usable connection by itself.   |
| `connection_ready`         | The authenticated hosted session reports connected and the selected local Runner reports ready.                       |
| Optimistic queue row       | The local reducer inserted the submitted prompt on the next render. It is not durable admission.                      |
| Durable queue admission    | The API accepted and persisted the command and returned its durable identity.                                         |
| Execution/model completion | TenetKit ran the turn and the selected provider finished. Provider time remains visible.                              |

Rika diagnostics emit `process_start`, `first_draw`, and `connection_ready` in
`client.performance.jsonl`. The API emits command receipt, enqueue, claim, turn start,
execution start, tool activity, and completion events in `api.performance.jsonl`. The command
sequence follows a submission across the API and Runner. File diagnostics flush on a timer, so
the timestamp inside an event is authoritative; the later moment a benchmark notices the file
is not connection latency.

## Current first-frame contract

The startup preview and its C launcher were removed after the interaction review. `bin/rika` is
now the compiled client itself. It leaves the previous terminal content visible while Bun,
command parsing, and OpenTUI initialize; the first synchronized Rika frame is the full animated
orb, “Welcome to Rika,” command hints, composer, and truthful connection status. There is no
intermediate “Starting Rika” frame and no private `.rika-client-runtime` process.

One hundred new-process launches of the packaged macOS arm64 client were recorded after one
installer-equivalent priming launch. Every sample initialized Bun, Effect, command parsing,
OpenTUI, and the complete frame. The harness included OpenTUI's terminal probes in first-byte
latency and accepted a frame only when the same synchronized draw contained both the welcome
text and an orb glyph.

| Current packaged boundary |        p50 |        p95 |    maximum |
| ------------------------- | ---------: | ---------: | ---------: |
| First terminal byte       | 142.495 ms | 166.463 ms | 196.088 ms |
| First real TUI frame      | 159.879 ms | 184.096 ms | 218.615 ms |

All 100 first frames contained the real welcome and orb, and none of the complete captured
output contained `Starting`. The first frame was 7,716 bytes, compared with the removed
115-byte preview. This deliberately gives up the old sub-50 ms synthetic-frame claim: the number
now measures the requested product surface rather than pixels from a launcher that had not
initialized Rika. Raw timing, PTY output, exact inventory, hashes, and a rendered text snapshot
are under `.agents/state/startup-real-frame/`.

## Superseded native preview benchmark

Before removal, the packaged launcher was extracted into a fresh directory for each of 100 PTY
samples. A separate 100-sample run measured an installer-primed launcher.

| Native preview        |      p50 |      p95 |    maximum | 50 ms p95 target |
| --------------------- | -------: | -------: | ---------: | ---------------- |
| Fresh extraction      | 1.738 ms | 2.373 ms | 150.208 ms | pass             |
| Installer primed      | 1.640 ms | 1.864 ms |   2.072 ms | pass             |
| Final package, primed | 1.668 ms | 1.887 ms |   2.222 ms | pass             |

The fresh run's one 150.208 ms maximum is a first-use macOS executable assessment/page-cache
outlier. Installation primes the final launcher, so the primed distribution represents normal
installed launch. Raw summaries are:

- `.amp/in/artifacts/performance-native-final/packaged-pty-launch.json`
- `.amp/in/artifacts/performance-native-final-primed/packaged-pty-launch.json`
- `.amp/in/artifacts/performance-native-final-release/packaged-pty-launch.json`

This proved a sub-50 ms visible preview at p95. It did **not** prove that Bun, OpenTUI,
authentication, or a network connection initialized within 50 ms. That distinction made the
measurement unsuitable for the desired interaction, so the preview and this target were retired.

## Historical full runtime and connection

Ten consecutive packaged runs used the same installed client, local authenticated profile, API,
and database.

| Boundary                         |              Distribution or range |
| -------------------------------- | ---------------------------------: |
| Native preview                   |                     1.927-2.543 ms |
| `process_start`                  |                   87.980-93.333 ms |
| Real `first_draw`                |                 135.980-139.333 ms |
| `connection_ready`               | 288.596-336.885 ms; p50 307.780 ms |
| `first_draw` → connection        |                         p50 171 ms |
| `first_draw` → ticket completion |                       p50 120.5 ms |

Evidence:

- `.amp/in/artifacts/glm-5.3-flash/packaged-final-primed-connection-distribution.jsonl`
- `.amp/in/artifacts/glm-5.3-flash/packaged-final-primed-connection-summary.json`

The truthful local connection path was about 0.3 seconds end to end, not the previously reported
10-15 seconds. The measured gap after the former 2 ms preview was not hidden by calling a socket
open “connected.”

Two startup-path deletions produced a controlled source-client improvement:

- an authenticated `/api/v1/me/context` request whose response was discarded was removed;
- after resolving the checkout root, independent Git common-directory, origin, HEAD, and branch
  reads now run concurrently.

Across ten same-home samples, real first draw to `connection_ready` improved from p50 210 ms to
165 ms, a 45 ms or 21.4% reduction. First draw to ticket completion improved from p50 156 ms to
116.5 ms. The raw before/after data is under
`.amp/in/artifacts/glm-5.3-flash/source-before-connection-distribution.jsonl`,
`.amp/in/artifacts/glm-5.3-flash/source-after-connection-distribution.jsonl`, and
`.amp/in/artifacts/glm-5.3-flash/source-connection-before-after-summary.json`.

## Command startup isolation

The client process no longer imports Runner, hosted interactive, or OpenTUI support before
command parsing selects an operation that needs them. Independent interactive modules are
loaded concurrently only for interactive operation; Runner support loads only for Runner
operation.

Twenty source `--version` samples changed from p50 239.009 ms to 163.244 ms, a 75.765 ms or
31.7% improvement. p95 changed from 245.330 ms to 233.449 ms because the optimized set retained
one high-tail sample. The packaged `--version` steady result was p50 86.121 ms and p95 86.552 ms
across 20 samples, with one first-use observation at 787.429 ms reported separately in the raw
data.

Evidence:

- `.amp/in/artifacts/performance-native-current/source-version-before.json`
- `.amp/in/artifacts/performance-native-current/source-version-after.json`
- `.amp/in/artifacts/performance-native-current/packaged-version-current.json`

## Queue, steering, and command-worker wake

Pressing Enter now inserts an optimistic pending row locally before network submission. The
real TUI harness proves that it is visible on the next render and that the server's durable
command identity reconciles rather than duplicates it. Ctrl+S submits steering directly through
the same durable command path instead of waiting for an overlay. Presentation is immediate;
the API remains the authority.

The command worker previously depended on its 30-second recovery poll even when the same API
process had just enqueued work. The command application now wakes its local worker directly and
retains the poll for crash and cross-process recovery.

| Cold CreateThread sample | Enqueue → claim |
| ------------------------ | --------------: |
| Before                   |       30,124 ms |
| After                    |           82 ms |

That is a 367× reduction for the observed cold wake. Evidence is in
`.amp/in/artifacts/glm-5.3-flash/create-thread-wake-before-after.json`. ACK responses also use the
replay cursor already known at command application time and no longer issue an immediate second
replay query.

## Model and tool latency

Provider-backed acceptance used a route manifest containing only OpenRouter
`z-ai/glm-5.3-flash`. A final packaged marker flow with the former preview measured:

- visible preview: 2.160 ms;
- truthful `connection_ready`: 350.016 ms;
- prompt to required marker: 7,154.952 ms.

The record is `.amp/in/artifacts/glm-5.3-flash/packaged-final-glm-full-1.json`.

Across repeated GLM 5.3 Flash samples, prompt completion tails included approximately 1.883 s,
5.521 s, 7.155 s, 14.896 s, 20.372 s, 25.271 s, and one run beyond a 45-second test deadline.
In the same controlled flows, durable queue waits were generally 77-108 ms and ordinary kernel
tool cells 113-168 ms. The multi-second variance begins after durable claim and TenetKit
execution start, so it belongs to the OpenRouter/model boundary rather than a hidden client queue
or kernel sleep. Rika preserves that time instead of manufacturing an early success state or
speculatively duplicating model/tool work.

## Runner version skew and unknown tool outcomes

The reported `host-terminated` / `Cell operation deadline exceeded` failures were not a short
client timeout. The live checkout was simultaneously owned by the current 0.11.6 TUI and a
headless 0.11.2 Runner that had remained alive across the TenetKit 0.44 and Effect rc112 clean
break. Its receipt store contained 25 cells: seven had reached the 120-second operation deadline,
and one was still running with an accepted/started receipt but no terminal frame. A later snapshot
contained 27 completed cells: nine deadline failures, 17 successes, and one ordinary command
failure. The old process also showed repeated reconnect cycles. The 120-second default was already
generous; increasing it would only keep an incompatible host authoritative for longer.

The defect was admission, not replay: Runner registration, fresh hello, and reconnect did not
carry a Runner implementation revision. The API could therefore admit an old installed Runner
to current tool work. All three Runner boundaries now require the same explicit revision and
reject a missing or obsolete process before session acquisition. The gate is Runner-only, so it
does not change E2B Orb access. Unknown outcomes remain unknown and non-replayable work is still
never guessed or duplicated.

The database-backed gateway suite proves a legacy hello and reconnect both close as malformed
before acquiring a session, while current reconnect, retained completion, cancellation, lease,
and authorization cases continue to pass. The local checkout schema test proves a pre-revision
HTTP registration cannot decode, and foreground Runner tests prove current hello and reconnect
frames carry the revision.

## Kernel execution

Seven independent Bun processes each ran one cold cell and 50 warm cells through one
`HostedKernel` session. The expression was `1 + 1`; percentiles use nearest rank.

| Kernel boundary | Samples |       p50 |       p95 |   maximum |
| --------------- | ------: | --------: | --------: | --------: |
| Cold cell       |       7 | 57.880 ms | 61.401 ms | 61.401 ms |
| Warm cell       |     350 |  1.300 ms |  3.326 ms |  5.767 ms |

Generating the bootstrap text itself measured approximately 0.0012 ms per call across seven
100,000-call loops. Caching it would add invalidation and lifecycle state to remove noise, not a
measured bottleneck, so no cache was added. Raw methodology and all samples are in
`.amp/in/artifacts/kernel-baseline/result.json`.

## Interactive memory boundary

Ten packaged launches were stopped after the authenticated `connection_ready` boundary. macOS
`getrusage` measured the child-process high-water resident set, including Bun, Effect, OpenTUI,
and local Runner startup.

| Boundary                       | Samples |         p50 |         p95 |     maximum |
| ------------------------------ | ------: | ----------: | ----------: | ----------: |
| Packaged TUI through connected |      10 | 158.844 MiB | 198.188 MiB | 198.188 MiB |

This is process high-water RSS, not a JavaScript heap measurement or proof of a leak. The raw
records and methodology are in
`.amp/in/artifacts/performance-memory/packaged-connection-rss.jsonl` and
`.amp/in/artifacts/performance-memory/packaged-connection-rss-summary.json`. No preload daemon,
runtime cache, or duplicate Runner was added to buy latency at the cost of a second resident
process.

## E2B and Orb boundary

After the credential-scanner correction, ten preparations of the exact uncommitted Rika
worktree all succeeded. Local selection, scanning, archiving, archive verification, and source
repository detection measured 609.247 ms p50 and 624.150 ms p95. This boundary excludes HTTP
upload and E2B preparation. Evidence is in
`.amp/in/artifacts/workspace-seed/current-worktree-distribution.jsonl` and
`.amp/in/artifacts/workspace-seed/current-worktree-summary.json`.

The E2B Executor Docker contract built and passed its complete image doctor in 304.160 seconds
from the earlier cold build. The final current source was rebuilt from the retained Docker cache
and passed the same doctor in 46.905 seconds. The latter is a correctness revalidation, not a
clean-build speed claim.

A secret-backed first attempt exposed a real setup-egress defect. With Rika's exact constrained
network policy and no stored phase policy, `registry.npmjs.org` was absent from `allowOut`.
Disallowed TLS ended at the network boundary, and Bun surfaced the misleading
`UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`. A controlled direct sandbox reproduced that result for
`bun add` on 3/3 attempts; trust-store overrides did not help. Adding only
`registry.npmjs.org`, while retaining `denyOut: 0.0.0.0/0`, restored certificate verification and
installed the full 664-package frozen workspace in 8.11 seconds.

Rika now uses `github.com` and `registry.npmjs.org` only as setup defaults when no stored policy
exists. Runtime has no default public destination, and an explicit stored policy—including an
empty one—still replaces the default. One fresh real Orb preparation with no stored policy reached
`ready/capabilities` in 35.546 seconds after preparation began; its setup hook took 26.508
seconds. Thread creation itself took 2.880 seconds. Two later post-fix preparations failed during
setup with the same Bun `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` while downloading from the
explicitly allowed `registry.npmjs.org` hostname. The observed post-fix result is therefore 1
ready and 2 setup failures across 3 attempts and 2 assignments. Creation, bootstrap, confined
dependency access, setup, and readiness are possible, but constrained-E2B TLS/setup reliability
is not proven and remains unresolved.

E2B documents hostname filtering as HTTP `Host` inspection on port 80 and TLS SNI inspection on
port 443. Reviewing E2B JavaScript SDK 2.41.0 through the current 2.46.1 found no intervening
change to hostname filtering, DNS, or in-sandbox TLS. An SDK-only upgrade is therefore not an
evidence-backed remedy for this failure. Rika does not hide the failure with a TLS bypass,
broader wildcard, or speculative setup retry.

The GLM-only live model step remains blocked by external configuration. Both the original and a
fresh secret-backed Amp orb received HTTP 401 `API key expired.` when calling only OpenRouter
`z-ai/glm-5.3-flash`. Therefore live E2B marker/tool/final-response, continuation, reconnect, and
cancellation evidence is not claimed. Transport reattachment alone completed at the API boundary
in 17-25 ms, but the successful-turn reconnect UX remains unproven. The scrubbed network
experiment, real Thread identifiers, timestamps, and blocker are in
`.amp/in/artifacts/e2b-orb-acceptance/`.

## Changes retained

- The public `bin/rika` is the compiled client; OpenTUI owns the first visible Rika frame and no
  launcher or private client runtime exists.
- CLI command parsing stays isolated from OpenTUI, models, SQL, plugins, MCP, and Runner startup.
- Interactive and Runner implementation modules load only for the selected operation.
- Trusted loopback development origins may use `ws://`; production still requires `wss://`.
- Independent checkout Git reads run concurrently and the unused startup context request is gone.
- Orb seed archiving overlaps independent repository and owner-context reads; seed upload overlaps
  ticket issuance. A TypeScript `Redacted` type declaration no longer trips credential scanning,
  while a real local access-token literal remains rejected.
- Absent setup-egress policy permits only GitHub and the npm registry; runtime stays closed by
  default and explicit policy remains authoritative.
- E2B create pins the already approved exact build, verifies the created template, and no longer
  repeats a build-status request that was not linked to the created sandbox.
- Queue insertion is optimistic, reconciled by durable command identity, and steering uses the
  same durable path.
- In-process command creation directly wakes the worker; the poll remains a recovery mechanism.
- ACK avoids a redundant replay query.
- Reconnect redelivery stays idempotent, and one process does not start duplicate Runners.
- TenetKit 0.44 remains the sole execution authority on Effect rc112 public APIs.

## Complexity deliberately rejected

- **Reintroducing a launcher or placeholder to preserve the sub-50 ms claim.** It would optimize
  pixels the user explicitly rejected while the real runtime remained unavailable.
- **Dropping durable admission for local speed.** The optimistic row is presentation only;
  reconnect still reconciles against API authority.
- **Removing the worker recovery poll.** Direct wake covers one process. The poll remains the
  boring crash and cross-replica recovery path.
- **Speculative model retries or request hedging.** Duplicate model and tool work can amplify
  provider tails and produce conflicting effects.
- **Connection caches, preload daemons, or a second localhost protocol.** They add stale identity,
  process lifecycle, and recovery states to save a local path already measured in hundreds of
  milliseconds.
- **Skipping Runner readiness.** It would make `connection_ready` faster only by making the name
  dishonest.
- **Starting the same Runner from two owners.** Reconnect reuses the one process owner rather than
  coordinating duplicate services.
- **Distributed projection locks added from one stale-revision observation.** Two local API
  replicas deliberately pointed at one benchmark database produced duplicate observer work, but
  PostgreSQL revision checks preserved the winning projection. A new lock/coordinator would add
  a failure mode without evidence of a correctness defect.
- **Broad dependency upgrades without measured benefit.** TenetKit 0.44 is current. Newer FoldKit,
  OpenTUI, or E2B versions require their own compatibility and product evidence instead of being
  mixed into this latency change. Registry versions checked for this decision are recorded in
  `.amp/in/artifacts/dependency-versions/verified-2026-08-31.json`.
- **TLS bypasses, broad Orb egress, or blind setup retries.** Controlled E2B tests proved one
  missing destination and repeated real preparations exposed a separate intermittent failure.
  Neither result proves a CA defect, a missing wildcard, or a retry-safe setup operation. The
  narrow default repairs the source policy while preserving confinement and visible failure; the
  remaining provider path stays unresolved instead of being hidden by another failure mode.

## Reproduction and artifact identity

Use a fresh `.agents/state/<run>/` directory and the `rika-acceptance` skill. Run package builds
serially because release staging paths are intentionally shared.

```bash
.agents/skills/rika-acceptance/scripts/with-packaged-rika.sh
bun run check
GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=commit.gpgsign \
  GIT_CONFIG_VALUE_0=false \
  bun --bun vitest run --project unit
```

The historical full-pass archive is `artifacts/rika-0.11.5-darwin-arm64.tar.gz`:

- size: 53,575,866 bytes;
- SHA-256: `554d644a7608969db593898b0389471805f1b0c830fd3f420dcc08e361fba726`;
- native launcher SHA-256: `a842b77e4bfdb0c60de3ca6a4121ad3d6be1eec7b491d08cdbca33bcae56e7cd`;
- client runtime SHA-256: `6a0e6394dcba837d02154c4db9c927c7c862472ba0a01da814b7ab81ef977b77`.

The serial packaged acceptance passed exact inventory, version, help, and packaged kernel smoke.
The final unit run passed 310 files and 2,271 tests, with 15 files and 83 tests skipped only at
their declared external-environment gates. The final E2B image contract built and passed its
complete doctor.

The full deterministic TUI suite passed 32 files and all 65 declared outcomes (64 ordinary
passes and one intentional expected failure). The process suite passed 17 files and 42 tests,
with one environment-specific process-table file skipped; it rebuilt the complete E2B image and
ran its doctor contract. Text frames and style maps for queue, tools, cancellation, Markdown,
diff, context, and welcome states are under `.amp/in/artifacts/tui-visual-rc112/`.
No production deployment, package publication, template promotion, push, merge, or tag is part of
this evidence.
