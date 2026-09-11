# E2B remote execution — superseded by Box

**Status: superseded.** Rika's remote Orb workspaces no longer run on E2B. This note survives only to mark the
removal; it is not current behavior.

## What replaced it

- Orb workspaces run on **Box**: `packages/box-executor` owns the provider control plane, enrollment, pinned
  template policy, and workspace-input contracts. `infra/box` is the Box image source, and
  `scripts/packaging/box-executor.ts` builds the compiled executor artifact into `artifacts/box-executor`.
- The production Box template is provisioned out-of-band and pinned by `RIKA_BOX_TEMPLATE_BOX_ID` and
  `RIKA_BOX_TEMPLATE_SNAPSHOT_ID`; there is no in-repo image promotion workflow.
- The shared WorkspaceExecutor boundary lives in `packages/execution`; the local Runner lives in
  `packages/runner`. Executor enrollment is per-Thread under `/api/v2/threads/*/executor` and
  `/api/v2/boxes/*/executor` on the deployed API — the old `/api/v1/executors` route and its dedicated proxy port
  are gone.
- Durable execution authority remains with released Generalist: object state lives in `generalist/durability/s3`
  and `generalist/unstable/rivet` is the scoped Runtime host. PostgreSQL holds product and identity state only.

The E2B packages (`packages/e2b-executor`, `packages/remote-execution`), `infra/e2b`, the executor-image workflow,
and the `E2B_*`/checkpoint environment contract were deleted at cutover. See
[Runner and Orb execution](../features/execution-placement.md) for the current placement behavior.
