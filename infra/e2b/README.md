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

After creating the template, run the release smoke inside a sandbox made from that exact build:

```sh
rika executor doctor --json
```

The command exits nonzero when a manifest tool or an image capability is unavailable. Its JSON includes the manifest SHA-256 and `RIKA_EXECUTOR_TEMPLATE_BUILD_ID`, allowing release automation to bind the result to one immutable build. Outbound network validation defaults to `https://example.com/`; set `RIKA_DOCTOR_NETWORK_URL` to an endpoint in the release egress allowlist.

The image contains no controller, object-store, GitHub App, or bootstrap secret. Provisioning injects only a one-time assignment/generation bootstrap identity. The bootstrap listener binds inside the sandbox so E2B's secure port tunnel can reach it; `secure: true`, `allowPublicTraffic: false`, and the per-sandbox traffic token prevent unauthenticated ingress. The controller bootstrap request also has a bounded timeout. The host opens an outbound WebSocket, persists its scoped session under `/var/lib/rika-executor`, renews its lease, and exposes only a loopback health endpoint. E2B creation disables unauthenticated public traffic and denies all egress except the controller-provided allowlist.

The `rika-executor` user owns the host and its session state. Workspace files belong to the separate `rika-workspace` user; the host may launch workspace cells, tools, processes, and PTYs as that user. Neither user receives E2B controller credentials, GitHub App credentials, Postgres credentials, or TenetKit RunStore authority.

Idle pause is filesystem-only and cold-boots on explicit controller `connect()`. The E2B SDK does not support transparent inbound auto-resume with `keepMemory: false`. Demand provisioning reconnects a platform-idled active assignment with its persisted scoped session. An explicit controller pause first clears server-side session authority, then demand resume issues a fresh one-time bootstrap. During startup, the host races authenticated bootstrap delivery with persisted-session reconnect, so neither path depends on a timing window. Full-memory snapshots are not a version 1 recovery mechanism.
