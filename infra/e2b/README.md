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

The image contains no controller, object-store, GitHub App, or bootstrap secret. Provisioning injects only a one-time assignment/generation bootstrap identity. The host opens an outbound WebSocket, persists its scoped session under `/var/lib/rika-executor`, renews its lease, and exposes only a loopback health endpoint. E2B creation disables unauthenticated public traffic and denies all egress except the controller-provided allowlist.

The `rika-executor` user owns the host and its session state. Workspace files belong to the separate `rika-workspace` user; the host may launch workspace cells, tools, processes, and PTYs as that user. Neither user receives E2B controller credentials, GitHub App credentials, Postgres credentials, or TenetKit RunStore authority.

Idle pause is filesystem-only and cold-boots on explicit controller `connect()`. The E2B SDK does not support transparent inbound auto-resume with `keepMemory: false`. Demand provisioning reconnects a platform-idled active assignment with its persisted scoped session. An explicit controller pause first clears server-side session authority, then demand resume issues a fresh one-time bootstrap. During startup, the host races authenticated bootstrap delivery with persisted-session reconnect, so neither path depends on a timing window. Full-memory snapshots are not a version 1 recovery mechanism.
