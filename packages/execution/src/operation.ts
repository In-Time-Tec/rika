/* oxlint-disable effecttsgo/missing-pipeable-signature -- coordinator methods are explicit protocol boundaries. */
import { Context, Effect, Layer, Schema } from "effect"

import { WorkspaceBinding, sameBinding } from "./binding"
import {
  Executor,
  ExecutorEvidence,
  ExecutorFenceError,
  ExecutorTransportError,
  HandshakeEvidence,
  HandshakeRequest,
  maxDispatchBytes,
  maxHandshakeBytes,
  maxReceiptBytes,
  validateEvidence,
  validateHandshake,
} from "./executor"
import type { ExecutorBoundary } from "./executor"
import type { CanonicalTerminalSettlement, WorkspaceComponentJournal } from "./component"

const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const InputDigest = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

export const NativeOperationIntent = Schema.Struct({
  operationId: Identity,
  tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  inputDigest: InputDigest,
  binding: WorkspaceBinding,
})
export type NativeOperationIntent = typeof NativeOperationIntent.Type

export const CanonicalResult = Schema.Union([
  Schema.TaggedStruct("Accepted", {
    operationId: Identity,
    binding: WorkspaceBinding,
  }),
  Schema.TaggedStruct("Completed", {
    operationId: Identity,
    binding: WorkspaceBinding,
    result: Schema.Json,
  }),
  Schema.TaggedStruct("DomainFailure", {
    operationId: Identity,
    binding: WorkspaceBinding,
    failure: Schema.Json,
  }),
  Schema.TaggedStruct("Unknown", {
    operationId: Identity,
    binding: WorkspaceBinding,
    reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  }),
])
export type CanonicalResult = typeof CanonicalResult.Type

export const ExecutorCancellation = Schema.Union([
  Schema.TaggedStruct("Cancelled", {}),
  Schema.TaggedStruct("AlreadyTerminal", { result: CanonicalResult }),
])
export type ExecutorCancellation = typeof ExecutorCancellation.Type
export const WorkspaceExecutorCancellation = ExecutorCancellation
export type WorkspaceExecutorCancellation = ExecutorCancellation

export const canonicalFromEvidence = (intent: NativeOperationIntent, evidence: ExecutorEvidence): CanonicalResult => {
  switch (evidence.outcome._tag) {
    case "Accepted":
      return { _tag: "Accepted", operationId: intent.operationId, binding: intent.binding }
    case "Completed":
      return {
        _tag: "Completed",
        operationId: intent.operationId,
        binding: intent.binding,
        result: evidence.outcome.result,
      }
    case "DomainFailure":
      return {
        _tag: "DomainFailure",
        operationId: intent.operationId,
        binding: intent.binding,
        failure: evidence.outcome.failure,
      }
    case "Unknown":
      return {
        _tag: "Unknown",
        operationId: intent.operationId,
        binding: intent.binding,
        reason: evidence.outcome.reason,
      }
  }
}

export class NativeOperationError extends Schema.TaggedError<NativeOperationError>()(
  "RikaExecutionV2NativeOperationError",
  {
    kind: Schema.Literals(["component", "fenced", "transport", "unresolved"]),
    message: Schema.String,
  },
) {}

export interface NativeOperationCoordinator {
  readonly bind: (binding: WorkspaceBinding, commandId: string) => Effect.Effect<WorkspaceBinding, NativeOperationError>
  readonly admit: (
    intent: NativeOperationIntent,
    commandId: string,
  ) => Effect.Effect<NativeOperationIntent, NativeOperationError>
  /** Owner-only release after Generalist has durably retained a terminal Tool result. */
  readonly cleanup: (
    intent: NativeOperationIntent,
    settlement: CanonicalResult,
    commandId: string,
  ) => Effect.Effect<void, NativeOperationError>
  readonly handshake: (
    intent: NativeOperationIntent,
  ) => Effect.Effect<HandshakeEvidence, ExecutorFenceError | ExecutorTransportError>
  /** Call from the native Tool handler and return this result unchanged so Generalist journals the Tool Run result. */
  readonly dispatch: (
    intent: NativeOperationIntent,
  ) => Effect.Effect<CanonicalResult, ExecutorFenceError | ExecutorTransportError | NativeOperationError>
  /** Call during recovery before any retry; a missing receipt remains unresolved and is never redispatched here. */
  readonly reconcile: (
    intent: NativeOperationIntent,
  ) => Effect.Effect<CanonicalResult, ExecutorFenceError | ExecutorTransportError | NativeOperationError>
}

export class NativeOperation extends Context.Service<NativeOperation, NativeOperationCoordinator>()(
  "@rika/execution/operation/NativeOperation",
) {}

type BoundedValue = HandshakeRequest | NativeOperationIntent | ExecutorEvidence | CanonicalResult

const bounded = (value: BoundedValue, limit: number): boolean => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= limit
  } catch {
    return false
  }
}

const unresolved = (message: string): NativeOperationError => NativeOperationError.make({ kind: "unresolved", message })

const unknownResult = (intent: NativeOperationIntent, reason: string): CanonicalResult => ({
  _tag: "Unknown",
  operationId: intent.operationId,
  binding: intent.binding,
  reason,
})

const operationFailure = (
  cause: NativeOperationError | ExecutorFenceError | ExecutorTransportError,
): NativeOperationError => {
  if (Schema.is(NativeOperationError)(cause)) return cause
  if (Schema.is(ExecutorFenceError)(cause)) return NativeOperationError.make({ kind: "fenced", message: cause.message })
  return NativeOperationError.make({ kind: "transport", message: cause.message })
}

const ensureAdmitted = (component: WorkspaceComponentJournal, intent: NativeOperationIntent) =>
  component.read.pipe(
    Effect.flatMap((state) => {
      if (state.binding === null)
        return NativeOperationError.make({
          kind: "component",
          message: "Native operation requires an admitted workspace binding",
        })
      if (!sameBinding(state.binding, intent.binding))
        return NativeOperationError.make({ kind: "fenced", message: "Native operation uses a stale workspace binding" })
      const admitted = state.admitted.find((entry) => entry.operationId === intent.operationId)
      if (admitted === undefined)
        return NativeOperationError.make({ kind: "component", message: "Native operation intent was not admitted" })
      if (
        admitted.tool !== intent.tool ||
        admitted.inputDigest !== intent.inputDigest ||
        !sameBinding(admitted.binding, intent.binding)
      )
        return NativeOperationError.make({
          kind: "component",
          message: "Admitted native operation intent does not match",
        })
      return Effect.succeed(intent)
    }),
    Effect.mapError((error) =>
      Schema.is(NativeOperationError)(error)
        ? error
        : NativeOperationError.make({ kind: "component", message: error.message }),
    ),
  )

const makeCoordinator = (
  component: WorkspaceComponentJournal,
  executor: ExecutorBoundary,
): NativeOperationCoordinator => {
  const bind = (binding: WorkspaceBinding, commandId: string) =>
    component.bind(binding, commandId).pipe(
      Effect.as(binding),
      Effect.mapError((error) => NativeOperationError.make({ kind: "component", message: error.message })),
    )

  const admit = (intent: NativeOperationIntent, commandId: string) => {
    if (!bounded(intent, maxDispatchBytes))
      return NativeOperationError.make({
        kind: "component",
        message: "Native operation intent exceeds the dispatch byte bound",
      })
    return component.admit(intent, commandId).pipe(
      Effect.as(intent),
      Effect.mapError((error) => NativeOperationError.make({ kind: "component", message: error.message })),
    )
  }

  const cleanup = (intent: NativeOperationIntent, settlement: CanonicalResult, commandId: string) => {
    if (settlement._tag !== "Completed" && settlement._tag !== "DomainFailure")
      return NativeOperationError.make({
        kind: "component",
        message: "Only a canonical Completed or DomainFailure result can release a native operation intent",
      })
    const terminal: CanonicalTerminalSettlement = settlement
    return component.cleanup(intent, terminal, commandId).pipe(
      Effect.asVoid,
      Effect.mapError((error) => NativeOperationError.make({ kind: "component", message: error.message })),
    )
  }

  const handshake = (intent: NativeOperationIntent) => {
    const request = HandshakeRequest.make({ binding: intent.binding })
    if (!bounded(request, maxHandshakeBytes))
      return Effect.fail(
        ExecutorTransportError.make({ phase: "before-dispatch", message: "Executor handshake exceeds the byte bound" }),
      )
    return executor.handshake(request).pipe(Effect.flatMap((evidence) => validateHandshake(intent.binding, evidence)))
  }

  const dispatch = Effect.fn("RikaExecutionV2.NativeOperation.dispatch")(function* (intent: NativeOperationIntent) {
    if (!bounded(intent, maxDispatchBytes))
      return yield* NativeOperationError.make({
        kind: "transport",
        message: "Native operation intent exceeds the dispatch byte bound",
      })
    yield* ensureAdmitted(component, intent)
    const cached = yield* executor.receipt(intent.operationId).pipe(Effect.mapError(operationFailure))
    if (cached !== undefined) {
      if (!bounded(cached, maxReceiptBytes))
        return yield* NativeOperationError.make({
          kind: "transport",
          message: "Executor evidence exceeds the receipt byte bound",
        })
      const verified = yield* validateEvidence(intent, cached).pipe(Effect.mapError(operationFailure))
      return canonicalFromEvidence(intent, verified)
    }
    const evidence = yield* handshake(intent).pipe(Effect.mapError(operationFailure))
    const dispatched = yield* Effect.result(executor.dispatch(intent, evidence))
    if (dispatched._tag === "Failure") {
      if (Schema.is(ExecutorFenceError)(dispatched.failure)) return yield* operationFailure(dispatched.failure)
      if (dispatched.failure.phase === "before-dispatch") return yield* operationFailure(dispatched.failure)
      return unknownResult(intent, "Executor acknowledgement was lost after dispatch; reconcile before retrying")
    }
    const receipt = dispatched.success
    if (!bounded(receipt, maxReceiptBytes))
      return yield* NativeOperationError.make({
        kind: "transport",
        message: "Executor evidence exceeds the receipt byte bound",
      })
    const verified = yield* validateEvidence(intent, receipt).pipe(Effect.mapError(operationFailure))
    return canonicalFromEvidence(intent, verified)
  })

  const reconcile = Effect.fn("RikaExecutionV2.NativeOperation.reconcile")(function* (intent: NativeOperationIntent) {
    yield* ensureAdmitted(component, intent)
    const receipt = yield* executor.receipt(intent.operationId).pipe(Effect.mapError(operationFailure))
    if (receipt === undefined)
      return yield* unresolved(
        "Executor has no evidence for the admitted operation; retain the pending intent without redispatch",
      )
    if (!bounded(receipt, maxReceiptBytes))
      return yield* NativeOperationError.make({
        kind: "transport",
        message: "Executor evidence exceeds the receipt byte bound",
      })
    const verified = yield* validateEvidence(intent, receipt).pipe(Effect.mapError(operationFailure))
    return canonicalFromEvidence(intent, verified)
  })

  return { admit, bind, cleanup, dispatch, handshake, reconcile }
}

/** Construct the coordinator inside a Generalist Tool handler; canonical settlement is the handler return value. */
export const makeNativeOperationCoordinator = (
  component: WorkspaceComponentJournal,
  executor: ExecutorBoundary,
): NativeOperationCoordinator => makeCoordinator(component, executor)

export const nativeOperationLayer = (
  component: WorkspaceComponentJournal,
): Layer.Layer<NativeOperation, never, Executor> =>
  Layer.effect(
    NativeOperation,
    Effect.gen(function* () {
      const executor = yield* Executor
      return makeCoordinator(component, executor)
    }),
  )

export const NativeOperationContract = {
  CanonicalResult,
  ExecutorCancellation,
  NativeOperationError,
  NativeOperationIntent,
  canonicalFromEvidence,
  maxDispatchBytes,
  maxHandshakeBytes,
  maxReceiptBytes,
}

export type VerifiedCanonicalResult = CanonicalResult
