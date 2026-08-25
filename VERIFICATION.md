# Hosted agent-loop verification requirements

Completion requires executable evidence through the same interfaces a developer uses. Unit tests prove state transitions; process tests prove connection and restart behavior; inspected recordings prove that the composed TUI, API, model service, Runner, and E2B Executor work together. A screenshot alone is not completion evidence.

## Required environment

- Docker is available.
- `bun run dev` brings up the Alchemy stack from a clean clone without manual database, migration, seed, proxy, API, or web steps.
- In an Amp orb, `.agents/setup` installs pinned tools once, `.agents/resume` starts the Docker daemon as an Amp-managed service, and bounded observable `amp orb services ensure` retries wait for the same supervised `bun run dev` stack and portal after every wake. A changed E2B template may outlive one ensure wait; resume must continue observing that process, require the real readiness check, and fail with service status and log guidance after its bound rather than launching another stack or ignoring failure.
- The Amp project supplies `OPENROUTER_API_KEY` and the three E2B controller values (`E2B_API_KEY`, `E2B_APP_ID`, and `E2B_DEPLOYMENT_ID`) without writing or printing secret values. Alchemy must generate or reuse an attested immutable template/build for the exact local Executor image; local Amp configuration must not carry duplicated template/build IDs.
- Tests use isolated databases, workspaces, command identities, and E2B Threads so concurrent runs cannot share mutable state.
- Recordings and reviewer-facing snapshots are saved under `.amp/in/artifacts/`; transient debug captures remain outside that directory.

## Automated verification

Focused tests must prove:

- HTTP URLs become WS URLs and HTTPS URLs become WSS URLs.
- Development starts with Runner-only capabilities, rejects a partial three-value E2B controller tuple, and starts Orb support only after the generated template/build matches the current image digest and E2B reports that exact build ready.
- Production rejects missing production capabilities.
- Seed execution is development-only, idempotent, uses a real Better Auth password account, materializes Personal and Organization Owners through the real HostedProduct service, and stores encrypted OpenRouter credentials. Concurrent first runs serialize into one account, organization, membership, owner pair, and credential pair. A second run preserves every active credential persistence field; a revoked credential is replaced under the same identity with an advanced revision.
- The fixed development seed is inert unless nonproduction also sets `RIKA_DEV_SEED=1`; Alchemy sets the gate explicitly and production cannot enable it accidentally through `NODE_ENV` alone.
- All development model roles resolve to the configured OpenRouter model and retain only an opaque credential identity.
- A custom MinIO checkpoint endpoint uses path-style S3 requests and generated credentials never appear in logs or Executor payloads. Bucket initialization creates only after explicit 404 or an unambiguous missing-bucket error; 403, 5xx, contradictory metadata, malformed status, and connectivity failures stop startup without a create attempt.
- Local Runner state cannot produce workspace preparation.
- A blank Orb Thread remains unassigned and creates no preparation attempt. Its first durable prompt lets the Turn worker start generation-fenced provisioning; the UI projects that bounded assignment lifecycle as preparation before the Executor connects. Executor preparation then persists before setup dispatch, expires at its deadline, rejects stale completion, and permits only a fenced retry or replacement.
- A hosted command session starts its event feed, selects its initial Thread, and observes that Thread's first `ThreadViewSnapshot` before accepting commands. Initial selection or feed failure fails readiness. A targeted cancellation therefore always reaches the selected Turn's execution link; a cancellation backend failure emits `ExecutionControlFailed(action = cancel)` and leaves the durable Cancel command rejected rather than applied.
- `CommandAdmitted` transfers ownership to a fenced server worker, and admitted CreateThread, SubmitPrompt, Cancel, and control commands complete after the client socket and admitting API replica disappear.
- PostgreSQL owns command lease time. Concurrent workers claim at most one ordinary command per Thread in reserved version order, continue claiming unrelated Threads, and fence stale renewal, release, and completion after lease recovery.
- PostgreSQL owns Turn-worker lease time. A live worker renews during slow workspace preparation; failed renewal interrupts its external call, and stale workers cannot persist preparation, admission, activation, or completion after reclaim.
- A command-targeted cancellation may overtake only the exact earlier admitted SubmitPrompt it targets; it cannot overtake workspace, service, approval, or other control commands.
- Thread creation uses a deterministic command-derived identity. Exact sequential and concurrent retries create one Thread, workspace, assignment, and completion, while incompatible identity reuse conflicts.
- A TUI process restart may reuse UI `submissionId = submission-1`, but each attempt receives a distinct random durable `submit:<UUID>` command identity and cancellation targets that durable identity before a Turn exists.
- Ctrl+C before Turn allocation waits only for an already-started exact submission's durable command identity, is interrupted by session close, rejects a missing or wrong-Thread target without creating a waiter, and remains latched if a concurrent `TurnStarted` frame arrives. Registration and durable command publication are atomic, the sending-state transition and WebSocket send attempt cannot be interrupted between those two actions, interruption before sending releases the unsent identity, a duplicate in-flight UI submission identity sends no second command, and definitive command rejection retires correlation before the waiting submit fiber observes it. `SubmissionAdmitted` and `SubmissionRejected` both remove the rendezvous. Reattachment uses a remembered per-Thread cursor and only an explicit matching replayed event retires correlation; an unrelated newer snapshot cannot disable cancellation for a still-pending admitted command. The first Ctrl+C durably cancels; the second remains the explicit quit gesture.
- Every mutation response must match its transport request, Thread, and durable command identities. A stale or mismatched frame fails as a protocol error instead of completing or indefinitely blocking another mutation.
- Submission replay with one command identity creates one Turn and one immutable start input.
- Distinct submit, cancel, and target identities settle both possible database orderings deterministically.
- Out-of-order command completion cannot regress durable event versions, snapshot cursors, client authority versions, or attachment cursors.
- The worker persists the exact nonsecret prepared TenetKit envelope before admission and retries it with the same session, Run, and idempotency identities.
- Exact staged admission is idempotent while divergent idempotency or Run identity collisions remain typed and block activation.
- TenetKit is the only durable operation-resolution authority. Rika has no duplicate resolution columns, and retry after TenetKit committed but before an HTTP response converges to the same `retrying`, `accepted`, or `aborted` projection while divergent identity conflicts.
- Cancellation before `activation_requested_at` prevents activation and terminally cancels any staged Run without model or tool execution.
- Activation and cancellation racing after `activation_requested_at` are ordered by TenetKit and never produce execution after cancel won. Cancellation of a `needs-resolution` Run tree uses `Runtime.cancel` plus `RunTree.awaitTerminal`; it does not scan bounded history or fabricate operation resolutions, and all unknown operation evidence remains unknown.
- Lost staged-admission and activation receipts produce at most one Run and one `RunAttemptStarted` event.
- If the staged-admission receipt is lost and cancellation wins before recovery, replaying the exact admission persists the Run link, cancels that staged Run, and clears the outbox without requiring current Orb readiness or executing model/tool work.
- Migration 0032 marks a legacy nonqueued Agent Turn failed only when both its execution link and prepared staged-admission record are absent. It preserves every Turn with a recoverable prepared outbox row, and the reconciler no longer logs `execution.authority.link_missing` forever for the already-stuck legacy Threads.
- Only a matching TenetKit terminal snapshot clears the Thread's active Turn and promotes queued work.
- Projection failure cannot cancel or terminalize a nonterminal Run.
- A second submission is admitted or visibly queued while an earlier network result is unknown.
- Atomic attachment during concurrent publication yields a contiguous event cursor without missing or double-applied events.
- If compaction removed the next required event for a client with no acknowledgement row, replay sends a newer durable full snapshot as the reset baseline and only contiguous events after it; it never skips a cursor gap.
- The snapshot/live handoff represents snapshot cursor H followed by exactly the contiguous `(H,T]` event range while publication races with attachment. A current materialized snapshot may replace an older full snapshot at the same nondecreasing cursor, but only after the server durably saves it behind the exact current Thread-version/cursor fence; it cannot regress Thread version or overtake a newer frame on one socket.
- Transactional PostgreSQL triggers notify protocol events, transcript projection checkpoints, snapshots, Turn status, and workspace placement with the exact Thread ID. Thread A does not wake Thread B. A notification committed while one replica is disconnected converges when its supervised `LISTEN` connection re-establishes and issues one cursor-derived recovery wake; no periodic replica sweep runs.
- A transcript checkpoint wake rematerializes and durably saves one changed same-cursor Thread snapshot before delivery. Repeating the wake without another state change performs no write and emits no frame, so the snapshot notification cannot form a loop. An attached TUI receives intermediate and terminal model/tool projection without detaching, reconnecting, or polling.
- Unattached Thread sockets block on inbound work rather than polling, and attached Thread sockets are absent from Runner/Executor authority-session polling. Push delivery therefore has no per-Thread-socket timer.
- After `CommandAdmitted`, the server pushes the terminal `CommandAccepted` or `CommandRejected` without client completion polling. A command admitted for Thread A still completes if that socket subsequently attaches Thread B.
- A replay/store failure closes the Thread socket and reconnects from the last durable cursor instead of spinning inside the connection.
- Slow consumers are disconnected and resume from the durable cursor without unbounded process memory.
- Every user-visible failure renders as a persistent Effect CLI-style Error block with a bold red `ERROR` heading and a red two-space-indented message. Submission, steering, cancellation, approval, denial, workspace, execution, and transport failures do not use green-check toast grammar, transient red toasts, or falsely expandable rows.
- Unknown Executor operation receipt remains `unknown` and is not blindly replayed.
- A hosted remote cell is journaled as `provider-idempotent` only when its gateway durably deduplicates the exact `ToolContext.operationKey`; direct/local tools remain `never`.
- API loss while a Runner or Orb cell is active does not interrupt the cell, cancel the Run, fail a pending binding, or append `OperationUnknown`.
- TenetKit re-enters the retry-safe tool with the same operation key, Rika attaches fresh binding authority to the existing dispatch, and the executor replays the pending binding and terminal receipt without executing the cell twice.
- Re-entry with newly generated admission timestamps adopts the first durable `admittedAt` and `deadlineAt`; it neither conflicts nor extends the execution window.
- Executor process loss never reruns a persisted running cell and produces an executor-authored unknown result that remains operator-visible.
- If an E2B create result is lost, recovery inventories the exact assignment generation, app, deployment, template, and build, reconnects and durably binds one usable match without issuing another create. It does not kill duplicates from inventory observation.
- E2B orphan cleanup asks the authoritative assignment store whether an observed sandbox is a cleanup candidate before starting grace, then atomically rechecks authority before kill. PostgreSQL uses its own `clock_timestamp()` rather than an API-host timestamp; an expired exact preparation is generation-fenced before kill, duplicate and old-generation sandboxes are reaped only after grace, Active and Paused exact bindings remain preserved, and missing or malformed ownership without an exact durable provider binding leaks conservatively. Provisioning that races after an expired preparation is fenced cannot adopt that old immutable sandbox and binds a new generation/provider instead. Concurrent cleaners may repeat idempotent kill for the same immutable provider ID but cannot target the replacement.

The required repository checks are:

```bash
bun run check
bun run test
bun run test-proc
bun run test-tui
```

Every new test must be discovered exactly once by the appropriate Vitest project. A failing unrelated check is reported and resolved or explicitly identified as an external blocker; checks are never weakened or skipped to manufacture a pass.

The development restart proof uses the Amp-managed service rather than two concurrent Alchemy processes:

```bash
amp orb services ensure
before="$(sudo docker exec rika-development-postgres psql -U rika -d rika -AtF '|' -c \
  "SELECT credential_reference_id,
          md5(ROW(owner_id, provider, status, revision, key_version, nonce, ciphertext,
                  authentication_tag, created_at, updated_at, rotated_at, revoked_at)::text)
     FROM rika_hosted_provider_credentials ORDER BY owner_id")"
sudo docker exec rika-development-postgres psql -U rika -d rika -Atc \
  "SELECT count(*) FROM rika_api_migration"
amp orb service stop rika
amp orb services ensure
after="$(sudo docker exec rika-development-postgres psql -U rika -d rika -AtF '|' -c \
  "SELECT credential_reference_id,
          md5(ROW(owner_id, provider, status, revision, key_version, nonce, ciphertext,
                  authentication_tag, created_at, updated_at, rotated_at, revoked_at)::text)
     FROM rika_hosted_provider_credentials ORDER BY owner_id")"
test "$before" = "$after"
sudo docker exec rika-development-postgres psql -U rika -d rika -Atc \
  "SELECT (SELECT count(*) FROM \"user\" WHERE email = 'rika@local.test'),
          (SELECT count(*) FROM \"organization\" WHERE slug = 'rika-development'),
          (SELECT count(*) FROM \"member\" member_record
             JOIN \"organization\" organization_record ON organization_record.id = member_record.organization_id
             JOIN \"user\" user_record ON user_record.id = member_record.user_id
            WHERE organization_record.slug = 'rika-development' AND user_record.email = 'rika@local.test'),
          (SELECT count(*) FROM rika_hosted_provider_credentials WHERE status = 'active')"
```

The two credential-row fingerprints must be the same before and after restart, the migration query must succeed, and the final counts must be `1|1|1|2`. PostgreSQL computes each fingerprint over every durable credential field; the shell sees only the opaque identity and digest, never ciphertext, provider keys, generated container passwords, or Alchemy state.

## Local Runner recording

Create and inspect `.amp/in/artifacts/rika-local-runner.webm` using agent-tty at fixed terminal dimensions. The recording must visibly show one uninterrupted user flow:

- Start the TUI against the locally running Alchemy stack and authenticate as the seeded development account.
- Create a Thread targeting the current Runner checkout.
- Show that input becomes available only after the Runner connection is ready.
- Submit the first prompt and keep the activity/status area visible from admission through terminal output.
- Demonstrate that the words `Preparing workspace` never appear for this local Thread.
- Ask the model to use a workspace tool to create a uniquely named file in the exact checkout, read it back, and report a unique completion marker.
- Show the tool call, streamed assistant response, and terminal completion without a manual refresh.
- Submit a second message immediately after or while the first is active and show that it is accepted or visibly queued rather than remaining silently at `Sending`.
- Cancel one active test Turn and show durable cancellation acknowledgement. Any assistant or terminal output already committed for that Turn must remain visible and contiguous after reconnect rather than being hidden by cancellation.
- Cause one harmless control failure and show the persistent structured `ERROR` block with its indented typed message.
- Quit and reopen the TUI, attach to the same Thread, and show the contiguous transcript and terminal state.

After recording, verify from outside the TUI that the uniquely named file exists in the launched checkout with the expected contents. Delete that test file after the assertion. The recording is rejected if it uses a mocked hosted transport, scripted executor, direct database mutation, hidden refresh, edited video, or a different checkout.

## E2B Orb recording

Create and inspect `.amp/in/artifacts/rika-e2b-orb.webm` using agent-tty at the same terminal dimensions. The recording must visibly show one uninterrupted user flow using a real projectless E2B Orb:

- Start the TUI against the same local Alchemy-hosted API and authenticate as the seeded development account.
- Create a Thread explicitly targeting Orb.
- Show `Preparing workspace` only after submission causes a durable E2B preparation attempt.
- Keep the preparation phase visible until it becomes ready or fails explicitly. For the acceptance recording it must become ready before its configured deadline.
- Submit a prompt through the server-side OpenRouter route.
- Ask the model to use an Orb workspace tool to create and read a uniquely named file, then report a unique completion marker.
- Show preparation, tool execution, streamed assistant output, and terminal completion without manual refresh.
- Show enough workspace or tool output to prove the file operation occurred inside the E2B environment rather than the local checkout.
- Quit and reopen the TUI, attach to the same Orb Thread, and show the durable transcript and terminal state without preparing a replacement Orb unnecessarily.

The recording is rejected if the Executor route is simulated, the E2B sandbox was prepared outside the recorded flow, a local Runner handles the tool call, or the full development application is exposed through the Executor tunnel.

## Failure and recovery evidence

Process or integration tests, supported by concise logs where needed, must exercise interruption at these boundaries:

- before submission admission;
- after admission but before preparation claim;
- after the prepared Runtime envelope is persisted but before staged admission;
- after TenetKit stages the Run but before Rika receives the admission result;
- after `activation_requested_at` but before calling TenetKit;
- after TenetKit activates the Run but before Rika receives the result;
- during cancellation delivery;
- after terminal persistence but before client delivery;
- after Orb creation but before preparation start;
- after preparation start but before ready completion;
- while attaching concurrently with event publication;
- while the API, Runner, Executor relay, or client connection restarts.
- after a local or Orb binding call is created but before the API receives it, and after the API computes a binding result but before the executor receives it.

Each case must converge after recovery with one durable command effect, at most one top-level Run, the correct active/queued Turn, a contiguous event cursor, and a visible failure when an outcome remains ambiguous.

Recordings prove user-visible composition, not hidden distributed invariants. Process evidence for recovery must include correlated Thread, Turn, Run, assignment generation, preparation attempt, and cursor identifiers. Transport tests must run two API replicas, report the exact cursor ranges applied by each client, and prove bounded queue/byte accounting. Orb tests must record the E2B sandbox identity, assignment generation, preparation nonce, and tool-operation receipt without exposing credentials.

## Security evidence

Inspect the API-to-Runner and API-to-Orb registration and operation payloads, Executor process environments, structured logs, and recorded output. None may contain database credentials, Better Auth secrets, E2B controller credentials, GitHub App credentials, provider API keys or OAuth tokens, provider encryption keys, or unredacted environment values.

The restricted Caddy listener must bind only to loopback while applying its routes to an arbitrary HTTP `Host`; startup readiness must prove both with a private token and a non-loopback Host value. The Cloudflare tunnel must return 404 for a representative auth route, API route, web route, and unknown route, while accepting only the authenticated Executor WebSocket route. Local and Amp portal ingress may expose the complete development application; the E2B ingress may not.

## Final evidence delivered to the reviewer

The completion report must include:

- the commands and decisive pass counts for all automated checks;
- links to both inspected WebM recordings;
- the local filesystem assertion and the Orb-side tool evidence;
- the start-twice migration and seed result;
- the preparation deadline/fencing result;
- the cancellation and lost-start-receipt result;
- the event cursor continuity result;
- the secret audit result;
- any external service instability observed during the OpenRouter or E2B smoke runs.

No completion claim is allowed until both required recordings exist, have been inspected, and show the stated real flows.
