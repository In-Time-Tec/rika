# Hosted Railway MVP

## RLM harness prompt

You are the autonomous senior engineer responsible for carrying Rika's hosted architecture from the committed integration branch through a verified Railway deployment and, after all gates pass, the repository's normal merge path to `main`. Do the engineering work; do not stop after auditing or restating this plan.

Repository and starting ref:

```text
https://github.com/In-Time-Tec/rika
feat/railway-hosted-mvp
```

Begin by fetching the remote branch, confirming its exact commit and worktree state, and reading `AGENTS.md`, `PRODUCT.md`, `CONTEXT.md`, this entire `PLAN.md`, the affected feature/decision documents, package manifests, migrations, API composition, and focused tests. Inspect current `origin/main` and CI before integrating it. Preserve unrelated concurrent work and never force-push shared history.

The execution machine has authenticated Railway CLI access and may have GitHub, npm, E2B, and Amp access. Verify each identity and selected project before using it. Treat credentials and environment variables as secrets: inspect names and presence, never print values. Use the repository's normal protected-branch, review, package-release, and deployment workflows; do not bypass required checks.

Work in this order:

- Audit the committed branch against the locked architecture and acceptance criteria below.
- Fix concrete correctness gaps rather than producing another review document.
- Keep hosted HTTP APIs on released Effect `HttpApi`/`HttpApiBuilder` contracts and keep raw runtime APIs in named outer adapters only.
- Complete focused tests as each boundary changes, then run repository-wide deterministic gates.
- Resolve the clean TenetKit PostgreSQL release gate and pin the released packages; never deploy the old `baton_*` schema.
- Use live PostgreSQL to prove migrations, transactionality, race behavior, fencing, and TenetKit parity.
- Build and publish an immutable E2B template build, then save only its build ID in Railway configuration.
- Configure Railway from the documented variable contract, run pre-deploy migrations, deploy the exact reviewed commit, and inspect readiness/logs.
- Run the real CLI device-auth, Organization-selection, remote-Thread, and E2B black-box smoke flow.
- Open or update a pull request, wait for required CI/review, merge through the normal workflow when authorized, deploy the exact merged revision, and repeat acceptance.
- Continue through failures by diagnosing and fixing their causes. Stop only for a missing external credential/approval, an unsafe irreversible action, or a demonstrated architectural blocker.

At completion, report exact Rika and TenetKit commits/releases, pull request and merge commit, Railway project/environment/service/deployment IDs, public domain, E2B template/build ID, migrations and test counts, sanitized black-box output, SQL authority evidence, and any remaining blocker. Clearly distinguish unit-tested, live-tested, deployed, and merely planned facts.

## Outcome

Ship the smallest honest hosted Rika execution path to `main` and Railway:

```text
authenticated CLI
  -> Railway HTTPS API
  -> PostgreSQL command and assignment authority
  -> E2B sandbox over outbound authenticated WSS
  -> one fenced workspace operation
  -> PostgreSQL event/result
  -> CLI output
```

The acceptance command is:

```sh
RIKA_INTERNAL_SERVER_HOST=invalid \
rika --thread <e2b-thread-id> --execute 'echo hosted-mvp'
```

It must print `hosted-mvp`, must not start the local Rika server, and must not create a local SQLite or TenetKit authority for the hosted Thread.

This first deployed slice proves identity, PostgreSQL authority, immutable remote placement, E2B provisioning, executor authentication/fencing, operation dispatch, durable result publication, and CLI routing. It does not claim that the full hosted coding-agent loop, multiplayer, PTY, checkout, checkpoint restore, or BYOK credential UX is complete.

## Locked architecture

- Railway runs separate Caddy proxy, Bun web, and Bun/Effect API services. Caddy is the only public HTTPS/WSS ingress; web and API use private Railway DNS.
- PostgreSQL is authoritative for identity-linked product state, Threads, commands, events, assignments, leases, fencing, and TenetKit Runs.
- Better Auth owns users, sessions, OAuth grants, organizations, memberships, invitations, and CLI device authorization.
- E2B is the only remote execution provider.
- A Thread's executor kind is immutable: `local_device` or `e2b`.
- `rika thread new` stays local. `rika thread new --remote` explicitly creates E2B placement.
- Executors connect outbound, receive only assignment-scoped credentials, and never receive PostgreSQL credentials.
- The API owns Run and command authority. Executors own workspace effects only.
- No Rivet Actors are introduced.
- Cloudflare remains deferred.
- No automatic local/E2B migration or fallback is allowed.
- No Baton names, tables, compatibility aliases, or migration shims are allowed.
- Hosted HTTP contracts use released Effect `HttpApi`, `HttpApiBuilder`, schemas, middleware, layers, and generated clients where practical. Raw Bun request handling is limited to WebSocket upgrade and Better Auth/native browser delegation boundaries.
- Effects run only at app, framework, process, and test-host boundaries. Use Effect services, scopes, structured concurrency, SQL, sockets, and typed errors throughout the core path.

## Starting point

The integration branch is `feat/railway-hosted-mvp`, based on the hosted foundation commit `1252d58b`.

The branch contains these implemented seams:

- Railway image and deployment contract with frozen production install, migration pre-deploy, `/readyz`, and 30-second overlap/drain.
- Better Auth identity, organization context, DPoP-bound CLI device OAuth, organization selection, and remote Thread creation CLI surfaces.
- Hosted product PostgreSQL stores and migrations.
- Immutable `e2b_...` hosted Thread IDs and executor assignments created together, with no required repository checkout.
- E2B controller/provider composition in the Railway process.
- `GET /api/v1/executors` WebSocket upgrade and schema-validated executor lifecycle protocol.
- `CellExecute`/`CellResult` transport with stable operation keys, fence validation, executor-local deduplication, and filesystem-persisted operation outcomes.
- Workspace commands run as the unprivileged `rika-workspace` user under `/workspace`.
- `POST /api/v1/threads/:threadId/operations` admits a product command, provisions E2B on demand, dispatches one operation, persists the executor result, and returns output.
- Hosted JSON routes for liveness, readiness, identity context, connection creation, and operation execution are declared with Effect `HttpApi` and implemented with `HttpApiBuilder` handlers and authorization middleware.
- `--execute --thread e2b_<id>` routes directly to hosted HTTP before the local product/server dispatcher. Hosted stream mode is rejected.
- Focused routing tests prove that this CLI path does not invoke the local Run dispatcher.

The current direct operation endpoint is an infrastructure vertical slice. It does not yet admit and execute a full TenetKit coding-agent Run. Do not represent the shell-operation smoke test as the completed hosted coding-agent product.

## Original hosted product plan

The Railway smoke slice above is the shortest route to proving the infrastructure. The complete product target agreed at the start of this work remains the following. Preserve these requirements while implementing the slice; continue with them after the first black-box deployment rather than treating the slice as the final product.

### Target user experience

An authenticated person can:

- Sign up with email/password, verify email, reset a password, or sign in with GitHub.
- Accept an Organization invitation or create an Organization.
- Select one active Organization in the CLI and TUI.
- Connect a GitHub App installation separately from social login.
- Create a local Thread explicitly backed by their registered device and opaque workspace binding.
- Create a remote Thread explicitly backed by one E2B sandbox lineage.
- See the immutable execution kind in every Thread header and status view.
- Invite Organization members and grant Project or Thread access.
- Watch the same ordered transcript, status, presence, terminal output, and agent activity from multiple authenticated clients.
- Submit queued prompts, steer or cancel active work, and answer tool approvals according to resource role.
- Acquire a renewable terminal writer lease for input while every authorized viewer continues receiving output.
- Disconnect or quit a TUI without cancelling the Turn, releasing the assignment, or closing its PTY.
- Reconnect from durable command/event cursors after a client, Railway replica, local executor, or E2B process restart.
- Let a remote workspace pause after fifteen idle minutes and resume on authorized demand.

The primary CLI remains:

```text
rika auth login [--server URL] [--no-open]
rika auth status [--json]
rika auth logout
rika auth logout --all

rika org list
rika org use <organization>
rika org invite <email>

rika thread new
rika thread new --remote
```

The TUI exposes separate **New local thread** and **New remote thread** actions. It never hides placement behind one ambiguous action.

### End-state topology

```text
CLI / TUI / browser ── HTTPS + WSS ──► Railway Caddy proxy
                                          │
                         browser routes ──┼── API routes, OAuth, executor WSS
                                          │
                                          ▼
                               ┌──────────────────────┐
                               │ Railway web         │
                               │ browser pages only  │
                               └──────────────────────┘
                                          │ private account lookup
                                          ▼
                               ┌──────────────────────────────────┐
                               │ Railway Rika API                 │
                               │ Better Auth + Organizations      │
                               │ Projects + sharing + presence    │
                               │ Thread commands + public events  │
                               │ TenetKit PostgreSQL runtime      │
                               │ assignment leases + fencing      │
                               │ E2B lifecycle reconciliation     │
                               └───────────────┬──────────────────┘
                                               ▼
                                      ┌──────────────────┐
                                      │ PostgreSQL       │
                                      │ only durable     │
                                      │ authority        │
                                      └──────────────────┘

                       authenticated outbound executor WSS
             ┌─────────────────────────┴─────────────────────────┐
             ▼                                                   ▼
┌──────────────────────────┐                       ┌──────────────────────────┐
│ local-device executor    │                       │ E2B executor             │
│ registered user machine  │                       │ one sandbox per Thread   │
│ local workspace          │                       │ isolated workspace       │
└──────────────────────────┘                       └──────────────────────────┘
```

Every CLI and TUI connects to the hosted API through the public proxy. A local background process is a Local Executor, not another authoritative Rika Server. Railway replicas are disposable; process-local connection maps are delivery optimizations only. PostgreSQL remains authoritative when no client, executor, or API replica is connected.

### Authority boundaries

Better Auth owns:

- Users and linked identities.
- Email/password sessions and verification/reset tokens.
- GitHub social login and account linking.
- OAuth grants and CLI device authorization.
- Organizations.
- Organization memberships.
- Organization invitations.
- Coarse Organization roles.

Rika API owns:

- Projects and Project grants.
- Workspaces and opaque local workspace bindings.
- Threads and Thread grants.
- Turns and actor-attributed product commands.
- Immutable execution placement.
- Shared command order, public event order, and projections.
- Authenticated clients and devices.
- Presence and acknowledged cursors.
- Executor desired state, assignments, generations, lease epochs, and lifecycle.
- Terminal writer leases.
- Approval arbitration.
- Audit records.
- GitHub installation metadata and credential references.
- Encrypted hosted model credential use.

TenetKit owns:

- Durable Runs and child Runs.
- The model/tool loop.
- Cancellation, replay, steering, compaction, and harness state.
- Model turns and tool-call protocol.
- Durable operation state and Run events.
- The cell tool contract and remote workspace-operation keys.

Executors own only:

- Workspace filesystem access.
- Kernels, coding tools, processes, and PTYs.
- Executor-private operation receipts used to deduplicate stable operation keys.
- Staged, secret-free workspace checkpoint content.

E2B owns sandbox lifecycle and isolation only. An E2B sandbox ID, filesystem, volume, process, or snapshot is never identity, Thread, Run, or authorization authority.

OpenTUI remains a rendering adapter. It does not own product or execution state.

### Immutable execution placement

Every Thread stores exactly one immutable execution kind:

- `local-device`
- `e2b`

Local placement binds to an authenticated device ID plus an opaque local-workspace binding. An absolute machine path is executor-private and must not become durable hosted identity.

Remote placement binds to an E2B assignment and immutable template build identity. One remote Thread has one current sandbox lineage and monotonically increasing assignment generation.

There is no:

- Automatic local-to-E2B migration.
- Automatic E2B-to-local migration.
- Remote fallback when a local device disconnects.
- Local fallback when E2B is unavailable.
- Silent change of workspace or execution authority.

An unavailable executor produces an explicit unavailable, paused, reconnecting, fenced, or failed state. It never changes placement.

### Better Auth and browser flow

Use Better Auth with:

- Email/password.
- Email verification.
- Password reset.
- GitHub social login and account linking.
- OAuth Provider plus Device Authorization for the CLI.
- Organization plugin for memberships, roles, and email invitations.

Do not duplicate Better Auth Organization, membership, or invitation tables in Rika migrations.

The initial browser surface is:

```text
/login
/signup
/verify-email
/forgot-password
/reset-password
/device
/device/approve
/invitations/:id
/organizations/new
/settings/github
```

After email/password signup:

- Verify the email address.
- Accept a pending invitation or create an Organization.
- Select the active Organization.
- Optionally connect a GitHub App installation.
- Return to device approval when browser login originated from a CLI flow.

GitHub social login and GitHub repository authorization are separate integrations. Never reuse a social-login access token for repository checkout.

### CLI device OAuth

Each CLI installation is a constrained native public OAuth client with no client secret. It has its own device identity and proof-of-possession key.

Login flow:

- Discover and validate the exact configured issuer and resource server.
- Register or recover the installation-specific public client.
- Request device and user codes.
- Print the verification URI and user code; open the browser unless `--no-open` is present.
- Let the user sign in or sign up in the browser.
- Display the client, user code, exact requested resource, requested scopes, active Organization, and approving account before consent.
- Poll according to the device interval and handle authorization-pending, slow-down, denial, and expiration as typed outcomes.
- Bind device-code, access-token, and refresh-token use to the installation proof key using DPoP.
- Bind access tokens to the exact API resource/origin.
- Rotate refresh tokens and reject replay.
- Store refresh credentials only in macOS Keychain, Windows Credential Manager, or Linux Secret Service.
- Store server origin, device ID, and selected Organization/Project only as non-secret profile configuration.
- `logout` revokes the current installation session and clears local secret material.
- `logout --all` revokes all of the user's CLI device grants after explicit confirmation.

Do not accept arbitrary issuer discovery, redirect, or resource values without validation. Device authorization is phishing-sensitive; approval must show enough context for a person to identify the requesting CLI.

### Organizations and resource authorization

Every Project, Workspace, and Thread belongs to one Organization. Every product query includes and verifies Organization ancestry rather than trusting an ID that happened to exist.

Rika resource roles are:

- `viewer`: read transcript, status, presence, and terminal output.
- `controller`: viewer permissions plus submit, steer, cancel, and answer approvals.
- `operator`: controller permissions plus terminal input and executor lifecycle control.
- `owner`: operator permissions plus sharing and destructive metadata changes.

Organization membership is necessary but not sufficient for Project or Thread access. Resource grants are explicit and never cross Organization boundaries.

Default sharing:

- A local Thread is creator-only because its executor acts with that device user's filesystem authority.
- Sharing local Thread control must warn that collaborators can cause actions under that filesystem authority.
- An E2B Thread may inherit its Project grants.
- A Thread can grant access only to a current member of its Organization.
- Removing and later re-adding a member must not silently resurrect revoked historical resource access.

Every authenticated HTTP request, client reconnect, command admission, executor lifecycle action, approval response, and terminal input checks active membership plus current resource role. Revocation closes or downgrades live client capabilities immediately, releases terminal writer authority, prevents new commands, and fences unauthorized lifecycle actions.

Sharing never reveals model provider credentials, GitHub App credentials, E2B API keys, executor bootstrap secrets, or PostgreSQL access.

### Multiplayer command and event model

All authorized clients observe one durable Thread command order and one durable public event order.

Every admitted command carries:

- Organization ID.
- Thread ID.
- Member, client, and device identity.
- Globally unique command ID.
- Idempotency key.
- Actor attribution.
- Assigned per-Thread sequence.
- Durable commit cursor.
- Schema-versioned command payload.

The API locks or atomically advances the Thread command sequence, validates current authority, persists the command, and only then makes it deliverable. Replaying the same ID and body returns the original admission. Reusing an ID or idempotency key with different content is a conflict.

Every executor or TenetKit-derived public event carries:

- Stable event ID and idempotency key.
- Assignment ID, generation, instance identity, and lease epoch when executor-originated.
- Per-Thread event sequence.
- Organization-wide durable commit cursor.
- Optional originating command sequence.
- Schema-versioned payload.

Stale generations and expired lease epochs cannot append public events even if an old process remains alive.

Clients reconnect with their last acknowledged commit cursor. The server replays durable commands/events after that cursor and then switches to live delivery without gaps. Presence is ephemeral in meaning but stored with expiration so reconnect and revocation behavior remains coherent.

Client input from separate writers is never byte-merged. Prompts are separate commands. Steering and cancellation are explicit commands. Quitting a client removes only that viewer; cancellation is a separate durable action.

### Approval arbitration

Tool approval requests are durable and identify the Organization, Thread, Turn/Run, approval identity, policy payload, state, version, opening time, and expiration.

Approval resolution:

- Require current `controller` or stronger access.
- Persist the actor-attributed approve/deny command.
- Lock the open request, recheck membership and resource authority, and compare-and-set `open` to one terminal resolution.
- First valid committed resolution wins.
- An exact idempotent replay returns the stored resolution.
- A different late response reports the existing winner rather than overwriting it.
- Delivery to TenetKit is durable and retryable, so a Railway crash after resolution cannot reopen or lose the decision.

### Shared terminal semantics

Every authorized viewer can receive terminal output and replay it from a durable terminal cursor.

Terminal input requires one renewable writer lease containing Thread, PTY, member/client, generation, acquisition time, renewal time, and expiration. Input and resize commands include the writer lease generation. The server rejects expired or replaced writers.

Takeover behavior:

- An eligible client requests control.
- The current writer may release it voluntarily.
- An `operator` or `owner` may force takeover with an actor-attributed audit event.
- A monotonically increasing writer generation fences delayed bytes from the previous writer.
- Input from separate clients is never merged.

Persist terminal session metadata, ordered input receipts, output chunks, exit state, and detected cursor gaps. A PTY reconnect resumes from the last output cursor. Client disconnect does not close the PTY unless an explicit terminal command or retention policy does so.

### Executor assignment and fencing

The API owns desired lifecycle and grants an executor only a renewable, fenced capability.

An assignment includes:

- Organization and Thread identity.
- Immutable executor kind and placement.
- Generation and assignment revision.
- Provider instance identity when provisioned.
- One-time bootstrap digest, never the plaintext secret.
- Session-token digest, never the plaintext token.
- Monotonic lease epoch and expiration.
- Acknowledged command/event/PTY cursor.
- Lifecycle state and timestamps.
- Current verified checkpoint reference.

Protocol behavior:

- The controller issues one-time bootstrap authority for one assignment generation.
- Executor Hello exchanges bootstrap authority for an assignment-scoped session token.
- Reconnect proves the persisted session token and exact fence.
- Heartbeats renew lease epoch, report acknowledged cursors, and update liveness.
- Every work request repeats current access/fence data.
- Every result is accepted only from the authenticated socket bound to that assignment, generation, instance, process incarnation, session, and live lease.
- Replacement increments generation before new work is accepted.
- Old generations are fenced even if the old sandbox or process is still reachable.

Executor operation keys are stable across API retry. The executor durably records accepted/running/completed or accepted/unknown outcomes and never blindly repeats a non-replayable side effect after an ambiguous crash.

### E2B lifecycle

Use one immutable, versioned E2B template build for one remote Thread sandbox lineage. Store the build ID, not only a mutable template alias.

Provisioning:

- Persist the desired assignment and generation before calling E2B.
- Tag provider resources with stable application, deployment, assignment, and generation metadata.
- Reconcile unknown create outcomes through provider inventory.
- Adopt exactly one matching sandbox and terminate duplicates.
- Kill a late successful sandbox created for an already replaced generation.
- Bootstrap through a one-time scoped credential.
- Allow no unauthenticated public traffic.
- Allow only required outbound destinations and document that E2B domain filtering applies to HTTP/TLS ports.

Idle behavior:

- Pause after fifteen minutes without execution, terminal, or connected-controller activity.
- Use filesystem-only pause with memory discarded.
- Resume only on authorized demand.
- Cold-start the executor supervisor and reconnect from persisted session/cursors.
- Do not depend on transparent inbound auto-resume.

Recovery:

- PostgreSQL assignment, TenetKit state, checkout identity, and verified checkpoint manifest are authoritative.
- Provider filesystem is a useful current workspace, not the sole durable record.
- Full-memory snapshots are not a version-one recovery mechanism.
- Checkpoints are content-addressed, size-limited, secret-scanned, digest-verified artifacts with a manifest, object keys, workspace identity, TenetKit cursor, assignment generation, and verification state.
- Replacement restores a clean checkout plus the latest verified workspace checkpoint, then resumes from authoritative cursors.
- Scheduled reconciliation inventories running and paused sandboxes, repairs known assignments, and deletes orphan resources according to retention policy.

No secret-bearing value may enter the E2B template, global environment, provider metadata, checkpoint, full-memory snapshot, log, URL, or argv.

### GitHub App repository access

GitHub social identity does not authorize repository access. Use a GitHub App installation owned by or approved for the Organization.

The API stores installation and repository metadata, not long-lived installation access tokens. For checkout or fetch:

- Verify current Organization, Project, Thread, repository, and assignment authority.
- Mint a short-lived installation token restricted to the required repository and operation.
- Deliver it only to the credential-bearing checkout adapter for the minimum time needed.
- Never expose it to model-generated shell/cell code, PTY sessions, workspace files, checkpoints, logs, or executor metadata.
- Scrub it after checkout and record only non-secret audit metadata.
- Fence delayed checkout results from replaced assignments.

Repository setup scripts execute as the workspace user after credential-bearing checkout completes.

### Model credentials and BYOK

Model credentials are not Rika login credentials and have one explicit scope: `local`, `user`, or `organization`.

- Local credentials remain in the operating-system credential store and are available only to local execution policy.
- Hosted user/Organization credentials use envelope encryption.
- Generate a fresh AWS KMS AES-256 data key per credential revision.
- Encrypt with AES-256-GCM and authenticated data binding credential ID, owner, provider, and revision.
- Store only ciphertext, nonce/tag, wrapped data-encryption key, non-secret identity metadata, and rotation metadata.
- Keep plaintext only in memory for the minimum model-call boundary.
- Never persist plaintext in PostgreSQL, logs, errors, events, executor environment, workspace, checkpoints, or telemetry.
- Bind one immutable credential profile reference and authentication kind when admitting a Run so later configuration changes do not silently change replay identity.
- Rotation creates a new revision; revocation prevents new Runs and follows an explicit policy for already-admitted Runs.

Model-generated code executes as the separate workspace user. It must not share a process or inherited environment with the credential-bearing API model adapter or checkout helper.

### PostgreSQL model

Better Auth migrations own identity and Organization relations. Rika hosted migrations own product relations. TenetKit migrations own only clean `tenetkit_*` runtime relations.

Rika's product model includes:

- Organization counters used for globally resumable commit cursors.
- Projects and Project grants.
- Workspaces with immutable executor kind.
- Threads with immutable executor kind and per-Thread command/event sequence counters.
- Thread grants.
- Registered devices and authenticated CLI clients.
- Executor assignments, provider resource metadata, lease epochs, generation, lifecycle, and cursors.
- Durable terminal writer leases.
- Actor-attributed Thread commands.
- Fenced Thread events.
- Client cursor acknowledgements.
- Expiring presence.
- Opaque local workspace bindings.
- Verified workspace checkpoint manifests.
- Audit events.
- Credential references and integration metadata, never plaintext credentials.
- Durable approval request, resolution, and delivery records.
- Terminal session, input receipt, output chunk, cursor-gap, and exit records.
- Provider-operation outbox/reconciliation records where a provider call has an ambiguous outcome.

Every tenant-owned key is constrained by Organization ancestry. Add composite foreign keys or equivalent transaction checks so a valid ID from another Organization can never be attached. Add uniqueness for command/event IDs, idempotency keys, assignment generations, operation keys, and cursor sequences.

Schema application is transactional and idempotent. Readiness checks exact supported schema versions/checksums for identity, Rika product, and TenetKit runtime.

### Hosted APIs and transports

Build HTTPS product APIs with Effect `HttpApi` contracts and `HttpApiBuilder` implementations. Shared payloads and errors are Effect Schemas. Use generated or contract-derived clients where doing so preserves DPoP and keeps server implementation private.

HTTP owns:

- Better Auth browser/session/OAuth endpoints.
- Device registration, status, revocation, and consent resources.
- Organization context, invitation, and active-Organization selection.
- Project, Thread, sharing, and placement creation commands.
- Idempotent product command admission.
- Read models and bounded catch-up requests.
- GitHub App installation initiation/callback/status.
- Credential profile management without secret reflection.

Client WSS owns:

- Authenticated resumable event fan-out.
- Cursor acknowledgement.
- Presence.
- Live command/result delivery after durable catch-up.
- Terminal output and writer-lease state.

Executor WSS owns:

- Hello, reconnect, heartbeat, and lease receipts.
- Fencing and replacement notices.
- Durable command delivery and acknowledgement.
- Stable workspace operation requests/results.
- Checkpoint staging/acceptance.
- Checkout requests through the credential broker.
- PTY create, input, output, resize, disconnect, and reconnect frames.

Every protocol is versioned and schema-decoded before use. Never trust assignment, worker, actor, Organization, or fence identity chosen by a client payload when the authenticated server context can bind it.

### Deployment and failure behavior

Railway hosts at least one stateless API service and PostgreSQL. Start with one steady-state application replica while WSS session routing is process-local. Add cross-replica dispatch ownership before scaling replicas horizontally.

Deployments:

- Run migrations before promotion.
- Stop admitting incompatible work before shutdown.
- Drain HTTP and WSS connections.
- Let durable commands survive the old replica.
- Reconnect clients and executors to the replacement from acknowledged cursors.
- Never let two replicas grant conflicting executor or terminal writer authority; PostgreSQL leases and fences decide.

Readiness requires compatible Better Auth, Rika product, and TenetKit schemas plus the services required to authenticate, authorize, admit, and claim work. Liveness does not imply readiness.

Back up PostgreSQL and checkpoint object storage. Exercise restore. Provider inventory reconciliation must run after API outage. Logs and metrics include request/command IDs, Organization and resource IDs where safe, assignment generation, lease epoch, cursor lag, E2B lifecycle, and typed failure categories, but never secret payloads.

### Original staged delivery

The original plan is incremental but Organizations, multiplayer, and local-versus-remote placement are foundational contracts, not optional redesigns.

**Contracts and authority**

- Update product vocabulary and ownership boundaries.
- Settle tenant ancestry, resource roles, immutable placement, secret ownership, repository policy, retention, and recovery policy.
- Define Effect Schemas for client/API and executor/API protocols.
- Delete local-single-owner assumptions such as “TUI quit cancels work.”

**Railway identity foundation**

- Deploy Bun/Effect API and PostgreSQL.
- Add Better Auth email/password, verification, reset, GitHub login/linking, Organizations, memberships, invitations, OAuth Provider, and Device Authorization.
- Add browser pages and CLI login/status/logout/org commands.
- Add DPoP-bound per-installation public clients and secure credential storage.

**PostgreSQL product authority**

- Add tenant-safe Projects, Workspaces, Threads, grants, clients/devices, commands/events, cursors, presence, assignments/fences, audit, credentials metadata, terminals, approvals, and checkpoints.
- Move hosted command ordering and shared projections out of local SQLite.
- Add idempotency, stale-fence rejection, immediate revocation, and cross-Organization confused-ID tests.

**Hosted client and local executor split**

- Make every CLI/TUI connect to the hosted server.
- Turn the local background process into an outbound authenticated executor.
- Keep local Thread creation the default and device/workspace-bound.
- Prove a client disconnect does not cancel execution.
- Remove any second authoritative local Rika server for hosted Threads.

**Multiplayer foundation**

- Add Project/Thread grants and invitation flow.
- Add shared ordered transcript, presence, attribution, concurrent command admission, steering/cancel, approval arbitration, immediate revocation, terminal writer lease, and Organization/sharing UI.
- Treat this foundation as part of the minimum hosted Rika release rather than a later bolt-on.

**Explicit E2B execution**

- Build the immutable executor template.
- Provision one sandbox per explicitly remote Thread.
- Add GitHub App checkout, setup, constrained egress, demand resume, fifteen-minute filesystem-only pause, checkpoint/restore, replacement, and orphan reconciliation.
- Use the same executor protocol and fences as local execution; do not create an E2B-specific product authority.

**Hosted TenetKit coding-agent loop**

- Run TenetKit's PostgreSQL worker in Railway.
- Bind immutable execution placement to every root and descendant Run.
- Dispatch only workspace effects to the fenced executor through stable operation keys.
- Keep model credentials and model calls in the authorized API boundary.
- Project TenetKit Run events into shared Thread views without duplicating Run truth.

**Operational hardening**

- Add multi-replica dispatch ownership when measured demand requires it.
- Add quotas, retention, backups/restore, abuse controls, observability, deployment drain, and disaster recovery.
- Consider Cloudflare or Rivet only after the Railway architecture works and measurements identify a specific need.

### Full-plan acceptance

The hosted product is not complete until tests prove:

- Email verification, reset, GitHub link/unlink, invitation acceptance, Organization selection, device approval/denial/expiry/slow-down, DPoP replay rejection, refresh rotation, and logout/revocation.
- Cross-Organization IDs never authorize or enumerate resources.
- Viewer/controller/operator/owner permissions and immediate revocation on both HTTP and live sockets.
- Local placement remains local and remote placement remains E2B through failure.
- Local Thread sharing starts creator-only and remote grant inheritance is explicit.
- Commands are actor-attributed, strictly sequenced, idempotent across replicas, and reject same-key/different-body reuse.
- Public events reject stale assignment generations and lease epochs.
- Clients reconnect from cursors without loss, duplication, or becoming runtime owner.
- Two clients see the same transcript and presence; concurrent prompts remain separate commands.
- One approval winner is durably selected and delivered after crash/retry.
- Terminal output is shared, input is one-writer, takeover fences old bytes, and PTY reconnect preserves cursor continuity.
- Local executor and E2B executor both reconnect outbound with the same protocol.
- E2B create/resume unknown outcomes reconcile without duplicate live authority.
- Fifteen-minute pause discards memory but preserves filesystem, then authorized demand cold-resumes correctly.
- Executor replacement increments generation and the stale executor cannot commit.
- Checkpoint restore verifies manifest and digests and does not carry secrets.
- GitHub social tokens are never used for checkout; short-lived installation tokens do not reach workspace code.
- Hosted model credentials are envelope-encrypted and absent from executor environments, logs, events, checkpoints, and child processes.
- Railway migration, deployment drain, restart, and PostgreSQL restore preserve command/Run authority.
- Full remote CLI and TUI work continues without a local authoritative server.

### Original exclusions

Do not add billing, a public agent SDK, browser or IDE coding clients, general sandbox-provider abstraction, Rivet Actors, Cloudflare, automatic placement migration, remote-provider fallback, full-memory snapshot recovery, a local semantic code index, or AST outline tooling as part of this plan.

## Hard upstream gate

Published `tenetkit` and `@tenetkit/pg` 0.31.0 still create `baton_*` PostgreSQL tables and cannot be deployed under the clean-break contract.

The completed upstream clean-break work is based on `In-Time-Tec/tenetkit` `origin/main` commit `399cde889990c2e7bfc896d15eaa03d962b5f9eb` and consists of:

- `771b4f4dbe50c1c51ccf40119cc9dfd85c9c9d4e` — `rename runtime schema and add hosted worker authority`
- `f5adb5f42fce6a28aa4eb46b11b2e4ec4c840574` — `feat(runtime): type hosted worker protocol`

The two-commit format patch is available from Amp thread `T-01a01b37-9c67-752b-8855-1227921c7d04` as `rika-postgres-hosted-worker.patch`. Its SHA-256 is `08f55e8abe998c8bb8fcd04fcd61e2c325e638c828de319a96ee99c2c86cceb9`.

That upstream work provides:

- A version-one runtime schema using only `tenetkit_*` names.
- Placement-pinned Runs and exact-placement claims.
- Worker identity and attempt fencing across child admission, fan-out, mailbox delivery, and Session mutation.
- A typed 42-operation remote worker RPC contract with no `Schema.Unknown` or `Schema.Any` envelopes.
- PostgreSQL schema exports, checksum, migration metadata, and hosted worker client/server layers.

Before deploying Rika:

- Apply or obtain those commits in the TenetKit repository.
- Provision PostgreSQL and run all 162 live `@tenetkit/pg` tests, especially migration, placement claims, worker fencing, Session authority, and parity.
- Run TenetKit `bun run check` and `bun run test`.
- Release the reviewed TenetKit packages from the correct `origin/main` ancestry.
- Pin Rika to the released package versions and refresh `bun.lock`.
- Verify a case-insensitive tracked scan finds no `baton` names in production source, migrations, generated SQL, or package exports.
- Apply the clean schema to an empty PostgreSQL database twice and prove the second application is a no-op.

Do not deploy by aliasing to a TenetKit worktree, vendoring package internals, patching `node_modules`, or accepting `baton_*` tables temporarily.

## Complete the Rika API composition

The deployed smoke slice must remain one coherent Effect application composition root in `apps/api/src/main.ts`.

Required services:

- Better Auth identity runtime and PostgreSQL identity directory.
- Hosted product PostgreSQL store and executor assignments.
- E2B provider and controller.
- Shared executor gateway used by both the Bun WebSocket adapter and HTTP operation handlers.
- TenetKit PostgreSQL runtime and hosted worker once the clean release is pinned.
- An Effect service that maps TenetKit remote cell operations to the current fenced executor assignment.

The composition must not create a second SQLite authority, spawn the local Rika server for hosted operations, or expose PostgreSQL to E2B.

Keep one shared gateway instance per Railway process. An executor Hello or Reconnect registers its assignment/fence/socket. `CellResult` must correlate only with an operation sent to that authenticated socket and active assignment. Replaced sockets are fenced and disconnected. Socket closure fails pending operations and removes only the matching current session.

The current gateway uses process memory for live socket and waiter correlation while commands and results are durable in PostgreSQL and executor outcomes are durable in the sandbox filesystem. This is acceptable only for the first single-replica smoke deployment. Before enabling multiple steady-state Railway replicas, add PostgreSQL-backed dispatch ownership or another measured cross-replica routing mechanism. Do not add Redis or Actors speculatively.

## Finish PostgreSQL authority

Remote connection creation must transactionally persist:

- Organization-scoped Project when one is not selected.
- Hosted Workspace.
- Immutable `e2b` Thread whose ID starts with `e2b_`.
- E2B executor assignment whose ID is the Thread ID.
- Null repository checkout for this no-checkout MVP.
- Creator/client/device authority and inherited sharing policy.

The transaction must roll back all records if assignment creation fails.

Operation execution must:

- Authenticate the DPoP-bound CLI principal.
- Resolve the explicitly selected organization and matching Better Auth membership.
- Require controller-level Thread access through the hosted store.
- Validate a UUID idempotency key.
- Persist the actor-attributed command before provisioning or dispatch.
- Provision or resume the exact E2B assignment.
- Dispatch using the current generation, lease epoch, executor identity, and session token.
- Persist one idempotent Thread event using the active assignment fence before returning success.
- Return the previous durable result for an identical retry where possible.
- Reject reused command or idempotency identities with different content.
- Reject stale executor results rather than publishing them.

Run live PostgreSQL race coverage for concurrent command admission, duplicate operation keys, stale generation, stale lease epoch, and executor reconnect while an operation is active.

## Complete the Effect HTTP boundary

Keep the hosted contract schema-first:

- Public group: `GET /healthz`, `GET /readyz`.
- Authenticated product group: `GET /api/v1/me/context`, `POST /api/v1/connections`, `POST /api/v1/threads/:threadId/operations`.
- Typed request payloads, path parameters, headers, successes, and status-specific errors.
- Authorization as `HttpApiMiddleware.Service` providing the authenticated account/device context.
- `HttpApiBuilder` group implementations over Effect services.
- OpenAPI generation may be enabled after the MVP, but the contract must already be reflectable.

Move the shared contract to an appropriate package if the CLI is converted to `HttpApiClient`; do not make the CLI import server implementation files. Preserve DPoP proof generation and resource-bound token behavior in the client transform.

Raw Bun handling may remain for:

- `GET /api/v1/executors` WebSocket upgrade, until the released Effect socket/server adapter can own the upgrade without losing Bun compatibility.
- Better Auth request delegation.
- Server-rendered browser pages and static assets until they are moved to Effect router endpoints.

All responses must retain the security headers currently applied at the outer server adapter.

## Prove the executor boundary

Build `rika-executor-v1` from `infra/e2b/executor-v1` using the pinned E2B CLI command documented in `infra/e2b/README.md`.

The template must:

- Start `/opt/rika/src/host.ts` through `/opt/rika/start.sh`.
- Resolve and export `E2B_SANDBOX_ID` from E2B runtime state when not injected.
- Run the host as `rika-executor`.
- Run workspace operations as `rika-workspace`.
- Persist executor session and operation deduplication state under `/var/lib/rika-executor` with restrictive permissions.
- Use `/workspace` as the only accepted workspace capability.
- Expose only loopback bootstrap health on port 7070.

The controller may inject only:

```text
RIKA_EXECUTOR_TARGET
RIKA_EXECUTOR_ASSIGNMENT_ID
RIKA_EXECUTOR_GENERATION
RIKA_EXECUTOR_ID
RIKA_EXECUTOR_TEMPLATE_BUILD_ID
RIKA_EXECUTOR_API_URL
RIKA_EXECUTOR_WORKSPACE
RIKA_CHECKPOINT_OBJECT_PREFIX
```

The executor environment must not contain `DATABASE_URL`, Better Auth secrets, E2B API keys, GitHub credentials, model credentials, Railway tokens, or TenetKit RunStore access.

For the first no-checkout smoke, a missing checkout must return the typed unavailable-checkout error without calling a credential broker. Do not add GitHub token brokering to make this slice pass.

## Railway deployment

Use the Railway CLI already authenticated on the execution machine. Inspect the selected account, project, environment, and service before changing anything. Do not guess which Railway project is active and do not print secret values.

Create or select:

- One Railway project/environment for the MVP.
- One PostgreSQL service.
- One public Caddy proxy service built from `apps/proxy/Dockerfile` and `apps/proxy/railway.json`.
- One private web service built from `apps/web/Dockerfile` and `apps/web/railway.json`.
- One private API service built from `apps/api/Dockerfile` and `apps/api/railway.json`.
- One steady-state API replica for the initial in-memory WSS routing slice.

Configure these variables through Railway references or secret variables:

```text
NODE_ENV=production
DATABASE_URL=<private PostgreSQL reference>
DATABASE_SSL=disable
BETTER_AUTH_URL=https://<public-proxy-domain>
BETTER_AUTH_SECRET=<high-entropy secret>
BETTER_AUTH_TRUSTED_ORIGINS=https://<public-proxy-domain>
GITHUB_CLIENT_ID=<social-login OAuth app id>
GITHUB_CLIENT_SECRET=<social-login OAuth secret>
RESEND_API_KEY=<mail provider secret>
EMAIL_FROM=<verified sender>
E2B_API_KEY=<E2B secret>
E2B_APP_ID=<stable Rika application id>
E2B_DEPLOYMENT_ID=<stable Railway environment/deployment scope>
E2B_TEMPLATE_ID=<commit-qualified executor template id>
E2B_TEMPLATE_BUILD_ID=<immutable executor template build id>
RIKA_EXECUTOR_API_URL=wss://<public-proxy-domain>/api/v1/executors
RIKA_PROXY_PUBLIC_DOMAIN=<proxy Railway public-domain reference>
```

Set `PORT=3000` on API, web, and proxy. Set web `API_DOMAIN` and proxy `API_DOMAIN`/`WEB_DOMAIN` through private-domain references; their matching upstream ports are `3000`.

Before promotion:

- Run the migration command against the attached PostgreSQL service.
- Verify identity migrations, hosted product migrations, and clean TenetKit migrations are all present.
- Verify no `baton_*` relations exist.
- Verify `/readyz` checks identity tables, hosted product tables, executor assignment authority, and TenetKit worker readiness.
- Verify the Docker image contains production dependencies needed by migration and start commands.

After deployment:

- Read Railway build, migration, deployment, and application logs without exposing secrets.
- Confirm `/healthz` and `/readyz` over the public HTTPS domain.
- Confirm the executor WSS URL upgrades successfully and rejects malformed or unauthenticated frames.
- Confirm the Railway API can provision the immutable E2B template.
- Confirm the E2B host connects, authenticates once, renews its lease, and receives one operation.

## Black-box acceptance

Use a fresh CLI profile and the deployed public domain:

```sh
rika auth login --server https://<railway-domain> --no-open
rika auth status --json
rika org list
rika org use <organization-id-or-slug>
rika thread new --remote
```

Capture the returned `e2b_...` Thread ID, then run:

```sh
RIKA_INTERNAL_SERVER_HOST=invalid \
rika --thread <e2b-thread-id> --execute 'echo hosted-mvp'
```

Acceptance requires all of the following:

- CLI prints `hosted-mvp` once.
- No local Rika server is created or contacted.
- No local SQLite/TenetKit Run database is created for the hosted Thread.
- PostgreSQL contains one `executor_kind = 'e2b'` Thread and matching assignment.
- The assignment reaches an active fenced generation and records the E2B provider instance.
- PostgreSQL contains the actor-attributed command and one corresponding result event.
- The E2B executor received no PostgreSQL credentials.
- Repeating the same idempotency key does not execute the command twice.
- A stale fence cannot publish a result.
- Disconnecting the CLI does not turn the CLI into runtime authority.

Capture sanitized command output, relevant SQL counts, Railway deployment identity, and E2B assignment lifecycle as release evidence. Never include access tokens, refresh tokens, session credentials, bootstrap credentials, private keys, database URLs, or API keys.

## Automated gates

Run focused checks while iterating:

```sh
bun run --cwd apps/api lint
bun run --cwd apps/api typecheck
bun run --cwd apps/api build
bun --bun vitest run --project unit \
  apps/api/test/http.test.ts \
  apps/api/test/executor-gateway.test.ts

bun run --cwd apps/rika lint
bun run --cwd apps/rika typecheck
bun run --cwd apps/rika build
bun --bun vitest run --project unit \
  apps/rika/test/hosted-http.test.ts \
  apps/rika/test/hosted-command-routing.test.ts \
  apps/rika/test/hosted-account.test.ts

bun run --cwd packages/remote-execution lint
bun run --cwd packages/remote-execution typecheck
bun --bun vitest run --project unit packages/remote-execution/test

bun run --cwd packages/e2b-executor lint
bun run --cwd packages/e2b-executor typecheck
bun --bun vitest run --project unit packages/e2b-executor/test

bun run --cwd packages/product-store lint
bun run --cwd packages/product-store typecheck
bun --bun vitest run --project unit \
  packages/product-store/test/hosted/hosted-store.test.ts \
  packages/product-store/test/hosted/assignments.test.ts
```

Before pushing a release candidate:

```sh
bun install --frozen-lockfile
bun run check
bun run test
git diff --check
```

Also run the live PostgreSQL product-store suites and the complete live TenetKit PostgreSQL suite. Existing unrelated terminal visual snapshot failures must be diagnosed and reported honestly; do not rewrite snapshots or suppress tests merely to obtain a green check.

Add one integration test that drives the final CLI-to-fake-E2B path and asserts:

- The persisted Thread uses `executor_kind = 'e2b'`.
- The assignment and Thread share identity.
- A fenced Hello is accepted.
- Exactly one operation is sent and correlated.
- The result event is persisted.
- The executor environment lacks `DATABASE_URL`.
- The local-server spawn stub is never called.

## Merge and release

Keep the work reviewable on `feat/railway-hosted-mvp` until automated and live acceptance gates pass.

- Rebase or merge current `origin/main` without rewriting shared history.
- Resolve package and migration conflicts mechanically, preserving the clean-break TenetKit contract.
- Push the branch and open a pull request targeting `main`.
- Wait for required CI checks and review.
- Merge through the repository's normal protected-branch workflow; do not force-push `main` or bypass required checks.
- Deploy the exact merged commit to Railway.
- Repeat readiness and black-box acceptance against the deployed merged revision.
- Record the exact Rika commit, TenetKit release, E2B template build ID, Railway deployment ID, and sanitized acceptance evidence.

If any external action lacks credentials or explicit authorization, stop at that boundary with the branch, checks, exact command, and required approval clearly reported. Never claim that code is deployed, merged, released, or live-tested without direct evidence.

## After the smoke MVP

Only after the vertical slice is deployed and measured, continue the original hosted product plan:

- Replace direct shell-operation admission with the hosted TenetKit agent loop and released remote worker contract.
- Add user BYOK credential profiles encrypted at rest and bind one immutable profile per Thread.
- Add GitHub App installation checkout and short-lived repository tokens, separate from GitHub social login.
- Add resumable authenticated client event streams and full TUI hosted sessions.
- Add multiplayer controller ordering, revocation, attribution, and terminal single-writer leases.
- Add PTY output/input/resize transport.
- Add verified workspace checkpoints, pause/resume, replacement generation, and restore.
- Add local-device executor registration over the same hosted protocol without making a local authoritative server.
- Add invitation-driven Project/Thread sharing and resource grants.
- Add multi-replica dispatch ownership after measuring the single-replica MVP.

Do not pull these follow-ups into the first Railway acceptance unless they are required to make the stated smoke path correct.
