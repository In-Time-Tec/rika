# E2B executor control plane

This package is the E2B-only control-plane adapter. It owns explicit assignment, immutable template build selection, short-lived bootstrap and lease credentials, E2B lifecycle calls, verified filesystem checkpoint metadata, GitHub App installation-token brokering, and managed-orphan cleanup. `E2B_TEMPLATE_ID` identifies the E2B template; `E2B_TEMPLATE_BUILD_ID` is the successful build receipt. Sandbox creation uses E2B's exact-build selector `<template-id>:<build-id>`, and the receipt is also stored in assignment placement, executor identity, fencing, and inventory metadata. Before and after creation, the provider requires E2B's `default` template tag to resolve to that receipt and requires the receipt status to be `ready`; it also verifies the new sandbox's provider-reported template ID. Any mismatch is rejected before bootstrap, and a sandbox created during a retarget race is killed.

It does not implement the product `ExecutionGateway`, TenetKit RunStore, an agent loop, workspace tools, processes, or PTYs. Application composition must keep `ExecutionGateway` as the product boundary and TenetKit as the sole durable Run authority. Executors receive neither Postgres credentials nor E2B/GitHub App controller credentials.

E2B idle pause uses `keepMemory: false`. Because the E2B SDK cannot combine filesystem-only pause with transparent inbound auto-resume, assignment demand resumes explicitly through `connect()`. The executor session is restored from its persisted filesystem state and reconnects from the acknowledged protocol cursor.

The application must provide durable optimistic `AssignmentStore`, `CheckpointObjectInspector`, and `GitHubAppTokenSource` implementations. The object inspector must read authoritative object metadata or content and return its SHA-256 digest and byte length; the controller accepts a checkpoint only when both equal the staged descriptor.

Run the credentialed lifecycle validation only after building the immutable template:

```sh
E2B_API_KEY=... E2B_TEMPLATE_ID=... E2B_TEMPLATE_BUILD_ID=... \
  bun run packages/e2b-executor/test/provider.live.ts
```

Root integration must install `e2b@2.41.0`, link `@rika/remote-execution`, and regenerate `bun.lock` in a separate integration change.
