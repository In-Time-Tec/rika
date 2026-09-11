import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { ExecutorTransportError, WorkspaceBinding, toEvidence, type WorkspaceExecutorService } from "@rika/execution"
import { makeRuntimeWorkspace } from "../../src/runtime/workspace"

const initial = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace", assignmentId: "assignment-1", generation: 1,
  placement: { _tag: "Orb", workspaceId: "workspace", lineageId: "lineage" },
  buildId: "build", protocolVersion: 1,
})
const recovered = Schema.decodeSync(WorkspaceBinding)({ ...initial, assignmentId: "assignment-2", generation: 2 })
const executor = (binding: WorkspaceBinding, calls: string[]): WorkspaceExecutorService => ({
  binding,
  handshake: () => Effect.sync(() => { calls.push(binding.assignmentId); return toEvidence(binding) }),
  dispatch: () => Effect.die("Unexpected dispatch"),
  receipt: () => Effect.void.pipe(Effect.as(undefined)),
  cancel: () => Effect.succeed({ _tag: "Cancelled" }),
})

it.effect("updates one shared executor handle only after resolving the exact recovered fence", () =>
  Effect.scoped(Effect.gen(function* () {
    const calls: string[] = []
    const resolutions: WorkspaceBinding[] = []
    const handle = yield* makeRuntimeWorkspace({
      initial: executor(initial, calls),
      resolve: (binding) => Effect.sync(() => {
        resolutions.push(binding)
        return executor(binding, calls)
      }),
    })
    const shared = handle.executor
    yield* shared.handshake({ binding: initial })
    yield* handle.rebind(recovered)
    yield* shared.handshake({ binding: recovered })
    yield* handle.rebind(recovered)
    expect(shared).toBe(handle.executor)
    expect(shared.binding).toEqual(recovered)
    expect(calls).toEqual(["assignment-1", "assignment-2"])
    expect(resolutions).toEqual([recovered])
    expect(yield* Effect.result(handle.rebind(initial))).toMatchObject({ _tag: "Failure" })
    expect(shared.binding).toEqual(recovered)
  })),
)

it.effect("retains the current executor when policy or resolved evidence changes or resolution fails", () =>
  Effect.scoped(Effect.gen(function* () {
    let resolves = 0
    const handle = yield* makeRuntimeWorkspace({
      initial: executor(initial, []),
      resolve: () => Effect.sync(() => { resolves += 1; return executor(initial, []) }),
    })
    for (const binding of [
      { ...recovered, buildId: "other-build" },
      { ...recovered, protocolVersion: 2 },
      { ...recovered, workspaceId: "other-workspace" },
      { ...recovered, placement: { ...recovered.placement, lineageId: "other-lineage" } },
    ]) {
      const changed = yield* Schema.decodeEffect(WorkspaceBinding)(binding)
      expect(yield* Effect.result(handle.rebind(changed))).toMatchObject({ _tag: "Failure" })
    }
    expect(resolves).toBe(0)
    expect(yield* Effect.result(handle.rebind(recovered))).toMatchObject({ _tag: "Failure" })
    expect(resolves).toBe(1)
    expect(handle.executor.binding).toEqual(initial)
    const unavailable = yield* makeRuntimeWorkspace({
      initial: executor(initial, []),
      resolve: () => ExecutorTransportError.make({ phase: "connection", message: "Unavailable" }),
    })
    expect(yield* Effect.result(unavailable.rebind(recovered))).toMatchObject({ _tag: "Failure" })
    expect(unavailable.executor.binding).toEqual(initial)
  })),
)
