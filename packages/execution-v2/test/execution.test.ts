/* oxlint-disable effecttsgo/effect-succeed-with-void, effecttsgo/sync-to-succeed -- deterministic boundary fixtures model a missing receipt as undefined. */
import { Cause, Effect, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import { it } from "@effect/vitest"

import {
  ExecutorEvidence,
  ExecutorTransportError,
  NativeOperationError,
  WorkspaceBinding,
  WorkspaceComponentState,
  makeNativeOperationCoordinator,
  type ExecutorBoundary,
  type NativeOperationIntent,
  type WorkspaceComponentJournal,
} from "../src"

const decodeBinding = Schema.decodeSync(WorkspaceBinding)
const decodeState = Schema.decodeSync(WorkspaceComponentState)
const decodeEvidence = Schema.decodeSync(ExecutorEvidence)

const binding = decodeBinding({
  workspaceId: "workspace-1",
  assignmentId: "assignment-1",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "workspace-1", checkoutFingerprint: "checkout-1" },
  buildId: "build-1",
  protocolVersion: 1,
})

const intent: NativeOperationIntent = {
  operationId: "operation-1",
  tool: "bash",
  inputDigest: "input-1",
  binding,
}

const makeSessionJournal = (): WorkspaceComponentJournal => {
  let state = decodeState({ binding: null, admitted: [] })
  return {
    read: Effect.sync(() => state),
    bind: (next, _commandId) =>
      Effect.sync(() => {
        if (state.binding !== null && state.binding.generation >= next.generation) return state
        state = { binding: next, admitted: state.admitted }
        return state
      }),
    admit: (operation, _commandId) =>
      Effect.sync(() => {
        if (state.binding === null) throw new Error("binding required")
        const existing = state.admitted.find((entry) => entry.operationId === operation.operationId)
        if (existing !== undefined) return state
        state = {
          binding: state.binding,
          admitted: [
            ...state.admitted,
            {
              operationId: operation.operationId,
              tool: operation.tool,
              inputDigest: operation.inputDigest,
              binding: operation.binding,
            },
          ],
        }
        return state
      }),
  }
}

const evidence = (outcome: ExecutorEvidence["outcome"], source: ExecutorEvidence["source"] = "dispatch") =>
  decodeEvidence({
    operationId: intent.operationId,
    inputDigest: intent.inputDigest,
    binding: {
      workspaceId: binding.workspaceId,
      assignmentId: binding.assignmentId,
      generation: binding.generation,
      placement: binding.placement,
      buildId: binding.buildId,
      protocolVersion: binding.protocolVersion,
    },
    source,
    outcome,
  })

const boundaryFor = (
  dispatch: ExecutorBoundary["dispatch"],
  receipt: ExecutorBoundary["receipt"],
): ExecutorBoundary => ({
  handshake: () =>
    Effect.succeed({
      workspaceId: binding.workspaceId,
      assignmentId: binding.assignmentId,
      generation: binding.generation,
      placement: binding.placement,
      buildId: binding.buildId,
      protocolVersion: binding.protocolVersion,
    }),
  dispatch,
  receipt,
})

const admit = (component: WorkspaceComponentJournal, coordinator: ReturnType<typeof makeNativeOperationCoordinator>) =>
  Effect.gen(function* () {
    yield* coordinator.bind(binding, "bind")
    yield* coordinator.admit(intent, "admit")
    expect(yield* component.read).toMatchObject({
      binding,
      admitted: [{ operationId: intent.operationId, inputDigest: intent.inputDigest }],
    })
  })

describe("execution-v2 native operation authority", () => {
  it.effect("does not reach an Executor before Generalist admission", () =>
    Effect.gen(function* () {
      const component = makeSessionJournal()
      const coordinator = makeNativeOperationCoordinator(
        component,
        boundaryFor(
          () => Effect.die("dispatch must not run"),
          () => Effect.sync(() => undefined),
        ),
      )
      yield* coordinator.bind(binding, "bind-unadmitted")
      const failure = yield* Effect.exit(coordinator.dispatch(intent))
      expect(failure._tag).toBe("Failure")
      if (failure._tag === "Failure") {
        const cause = Cause.findErrorOption(failure.cause)
        expect(Option.isSome(cause)).toBe(true)
        if (Option.isSome(cause)) expect(cause.value).toMatchObject({ kind: "component" })
      }
    }),
  )

  it.effect("admits binding and intent through the Session component before dispatch", () =>
    Effect.gen(function* () {
      const component = makeSessionJournal()
      const coordinator = makeNativeOperationCoordinator(
        component,
        boundaryFor(
          () => Effect.die("dispatch must not run"),
          () => Effect.sync(() => undefined),
        ),
      )
      yield* admit(component, coordinator)
    }),
  )

  it.effect("rejects an admitted intent whose binding is stale even when the workspace binding matches", () =>
    Effect.gen(function* () {
      const admittedBinding = decodeBinding({
        ...binding,
        generation: 2,
      })
      const component: WorkspaceComponentJournal = {
        read: Effect.succeed({
          binding,
          admitted: [
            {
              operationId: intent.operationId,
              tool: intent.tool,
              inputDigest: intent.inputDigest,
              binding: admittedBinding,
            },
          ],
        }),
        bind: () => Effect.die("bind must not run during dispatch"),
        admit: () => Effect.die("admit must not run during dispatch"),
      }
      const coordinator = makeNativeOperationCoordinator(
        component,
        boundaryFor(
          () => Effect.die("dispatch must not run for a stale admitted binding"),
          () => Effect.sync(() => undefined),
        ),
      )
      const failure = yield* Effect.exit(coordinator.dispatch(intent))
      expect(failure._tag).toBe("Failure")
      if (failure._tag === "Failure") {
        const cause = Cause.findErrorOption(failure.cause)
        expect(Option.isSome(cause)).toBe(true)
        if (Option.isSome(cause)) expect(cause.value).toMatchObject({ kind: "component" })
      }
    }),
  )

  it.effect("returns a verified canonical result for natural Tool Run settlement", () =>
    Effect.gen(function* () {
      const component = makeSessionJournal()
      const coordinator = makeNativeOperationCoordinator(
        component,
        boundaryFor(
          () => Effect.succeed(evidence({ _tag: "Completed", result: { exitCode: 0 } })),
          () => Effect.sync(() => undefined),
        ),
      )
      yield* admit(component, coordinator)

      const result = yield* coordinator.dispatch(intent)
      expect(result).toMatchObject({ _tag: "Completed", operationId: intent.operationId, result: { exitCode: 0 } })
    }),
  )

  it.effect("reuses accepted executor evidence after reconnect without redispatching", () =>
    Effect.gen(function* () {
      const component = makeSessionJournal()
      let dispatches = 0
      let receipts = 0
      const coordinator = makeNativeOperationCoordinator(
        component,
        boundaryFor(
          () => {
            dispatches += 1
            return Effect.succeed(evidence({ _tag: "Accepted" }))
          },
          () => {
            receipts += 1
            return receipts === 1
              ? Effect.succeed(undefined)
              : Effect.succeed(evidence({ _tag: "Accepted" }, "reconnect-cache"))
          },
        ),
      )
      yield* admit(component, coordinator)
      expect(yield* coordinator.dispatch(intent)).toMatchObject({ _tag: "Accepted", operationId: intent.operationId })
      expect(yield* coordinator.dispatch(intent)).toMatchObject({ _tag: "Accepted", operationId: intent.operationId })
      expect(dispatches).toBe(1)
    }),
  )

  it.effect("reopens after an effect and lost acknowledgement without redispatching", () =>
    Effect.gen(function* () {
      const component = makeSessionJournal()
      let dispatches = 0
      let receipts = 0
      const coordinator = makeNativeOperationCoordinator(
        component,
        boundaryFor(
          () => {
            dispatches += 1
            return Effect.fail(ExecutorTransportError.make({ phase: "after-dispatch", message: "ack lost" }))
          },
          () => {
            receipts += 1
            return receipts === 1
              ? Effect.succeed(undefined)
              : Effect.succeed(evidence({ _tag: "Completed", result: { exitCode: 0 } }, "reconnect-cache"))
          },
        ),
      )
      yield* admit(component, coordinator)
      expect(yield* coordinator.dispatch(intent)).toMatchObject({ _tag: "Unknown", operationId: intent.operationId })

      const result = yield* coordinator.dispatch(intent)
      expect(result).toMatchObject({ _tag: "Completed", result: { exitCode: 0 } })
      expect(dispatches).toBe(1)
    }),
  )

  it.effect("retains an unresolved effect when executor caches are discarded", () =>
    Effect.gen(function* () {
      const component = makeSessionJournal()
      const coordinator = makeNativeOperationCoordinator(
        component,
        boundaryFor(
          () => Effect.fail(ExecutorTransportError.make({ phase: "after-dispatch", message: "connection lost" })),
          () => Effect.sync(() => undefined),
        ),
      )
      yield* admit(component, coordinator)
      expect(yield* coordinator.dispatch(intent)).toMatchObject({ _tag: "Unknown", operationId: intent.operationId })

      const failure = yield* Effect.exit(coordinator.reconcile(intent))
      expect(failure._tag).toBe("Failure")
      if (failure._tag === "Failure") {
        const cause = Cause.findErrorOption(failure.cause)
        expect(Option.isSome(cause)).toBe(true)
        if (Option.isSome(cause)) expect(cause.value).toMatchObject({ kind: "unresolved" })
      }
    }),
  )

  it.effect("denies stale generation evidence before natural Tool Run settlement", () =>
    Effect.gen(function* () {
      const component = makeSessionJournal()
      const staleBoundary = boundaryFor(
        () =>
          Effect.succeed(
            decodeEvidence({
              ...evidence({ _tag: "Completed", result: { exitCode: 0 } }),
              binding: { ...evidence({ _tag: "Accepted" }).binding, generation: 2 },
            }),
          ),
        () => Effect.sync(() => undefined),
      )
      const coordinator = makeNativeOperationCoordinator(component, staleBoundary)
      yield* admit(component, coordinator)
      const failure = yield* Effect.exit(coordinator.dispatch(intent))
      expect(failure._tag).toBe("Failure")
      if (failure._tag === "Failure") {
        const cause = Cause.findErrorOption(failure.cause)
        expect(Option.isSome(cause)).toBe(true)
        if (Option.isSome(cause)) expect(cause.value).toBeInstanceOf(NativeOperationError)
      }
    }),
  )
})
