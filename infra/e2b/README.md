# Rika E2B executor template

Build version 1 from the repository root with the pinned E2B CLI:

```sh
bunx @e2b/cli@2.16.2 template create rika-executor-v1 \
  --path . \
  --dockerfile infra/e2b/executor-v1/e2b.Dockerfile \
  --cmd "/opt/rika/start.sh" \
  --ready-cmd "curl --fail --silent http://127.0.0.1:7070/health"
```

Record the returned build ID as the controller's immutable `templateBuildId`. Do not provision from the mutable template alias.

## Supply-chain promotion

`.github/workflows/executor-image.yml` is the release contract. A review run builds one Linux AMD64 OCI archive without registry credentials, derives its identity from the source commit and `tool-manifest.json` SHA-256, generates an SPDX 2.3 SBOM with pinned Syft, and scans all OS and library vulnerabilities with pinned Trivy. Syft's variable creation timestamp and document namespace are replaced with the source commit timestamp and image digest, then the JSON is key-sorted and compacted so the same candidate produces the same SBOM bytes.

The blocking policy is: no `HIGH` or `CRITICAL` vulnerability with a nonempty fixed version may be promoted. Unfixed findings and lower severities remain in the retained report but do not block. `executor-build.json`, the canonical SBOM, and the complete vulnerability report are retained for 90 days. The private OCI handoff is retained for one day and contains only the already-built image; `.dockerignore` excludes repository metadata, local agent state, environment files, credential stores, private keys, and dependency caches from its build context.

Promotion requires a `main` branch source and the `executor-production` GitHub environment. Generation `N` creates a fresh `rika-executor-gN` GHCR package and `rika-executor-v1-gN` E2B template; an existing package blocks reuse. The image is uploaded only by digest, never by tag. It remains private until GitHub has created and re-verified both SLSA provenance for the exact OCI manifest and Rika's build-identity attestation binding the source commit, tool-manifest digest, SBOM digest, and scan digest. E2B then builds from that digest in an isolated empty context. The workflow captures the template and build IDs from the create operation itself and runs the doctor against that exact build and expected manifest digest before retaining and attesting the promotion receipt.

After creating the template, run the release smoke inside a sandbox made from that exact build:

```sh
rika executor doctor --json
```

The command exits nonzero when a manifest tool or an image capability is unavailable. It runs tools and package version checks plus workspace-user, browser, media, outbound-network, and credential-broker readiness probes. The broker probe passes no credential: it proves that `rika-executor` can create the ephemeral Unix socket and `rika-workspace` can reach it. Its JSON includes the manifest SHA-256, manifest tool and package counts, and `RIKA_EXECUTOR_TEMPLATE_BUILD_ID`, allowing release automation to bind the complete result to one immutable build. Outbound network validation defaults to `https://example.com/`; set `RIKA_DOCTOR_NETWORK_URL` to an endpoint in the release egress allowlist.

The image contains no controller, object-store, GitHub App, or bootstrap secret. Provisioning injects only a one-time assignment/generation bootstrap identity. The bootstrap listener binds inside the sandbox so E2B's secure port tunnel can reach it; `secure: true`, `allowPublicTraffic: false`, and the per-sandbox traffic token prevent unauthenticated ingress. The controller bootstrap request also has a bounded timeout. The host opens an outbound WebSocket, persists its scoped session under `/var/lib/rika-executor`, renews its lease, and exposes only a loopback health endpoint. E2B creation disables unauthenticated public traffic and denies all egress except the controller-provided allowlist.

The `rika-executor` user owns the host and its session state. Workspace files belong to the separate `rika-workspace` user; the host may launch native tools, processes, and PTYs as that user. Neither user receives E2B controller credentials, GitHub App credentials, Postgres credentials, or Generalist RunStore authority.

Provider timeout pause is filesystem-only and cold-boots on explicit controller `connect()`. The E2B SDK does not support transparent inbound auto-resume with `keepMemory: false`. Heartbeats extend the provider timeout, so it is not a user-idle pause policy. Demand provisioning connects an Active assignment only while its authoritative lease is valid; an expired lease currently triggers replacement, not a same-sandbox wake. A direct provider pause does not commit a Rika checkpoint or mark the assignment Paused, so that replacement can lose uncheckpointed Workspace changes.

The internal coordinated controller pause quiesces the Executor and commits a verified checkpoint before clearing server-side session authority and pausing the sandbox. Demand resume of that Paused assignment issues a fresh one-time bootstrap. During startup, the host races authenticated bootstrap delivery with persisted-session reconnect. This does not override the API's assignment lifecycle or fencing decisions. No client pause command or automatic idle checkpoint/pause scheduler currently invokes the coordinated path. Full-memory snapshots are not a version 1 recovery mechanism.
