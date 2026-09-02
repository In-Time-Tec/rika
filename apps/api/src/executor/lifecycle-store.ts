import type { HostedExecutionOperationsService, OperationRecord } from "@rika/product-store/executor-operations"
import { ToolOperationResponse } from "@rika/product/tool-operation-lifecycle"
import { Crypto, Effect, Encoding, Schema } from "effect"
import {
  cancelledResponse,
  GatewayError,
  type ExecutionResult,
  type LifecycleStore,
  type OperationIdentity,
} from "./gateway"

const OperationIdentity = Schema.Struct({
  workspaceId: Schema.String,
  sessionId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  runId: Schema.String,
  rootRunId: Schema.String,
  toolCallId: Schema.String,
  code: Schema.String,
  attempt: Schema.Int,
  replayPolicy: Schema.Literals(["pure", "provider-idempotent", "never"]),
})
const encodeOperationIdentity = Schema.encodeSync(Schema.fromJsonString(OperationIdentity))
const matchesLifecycle = (
  operation: OperationRecord,
  attribution: {
    readonly workspaceId: string
    readonly sessionId: string
    readonly threadId: string
    readonly turnId: string
    readonly runId: string
    readonly rootRunId: string
    readonly toolCallId: string
  },
  access: {
    readonly fence: {
      readonly assignmentGeneration: number
      readonly executorId: string
      readonly processIncarnation: string
    }
  },
) =>
  operation.workspaceId === attribution.workspaceId &&
  operation.sessionId === attribution.sessionId &&
  operation.threadId === attribution.threadId &&
  operation.turnId === attribution.turnId &&
  operation.runId === attribution.runId &&
  operation.rootRunId === attribution.rootRunId &&
  operation.toolCallId === attribution.toolCallId &&
  operation.dispatchedGeneration === access.fence.assignmentGeneration &&
  operation.dispatchedExecutorInstanceId === access.fence.executorId &&
  operation.dispatchedProcessIncarnation === access.fence.processIncarnation

export const LifecycleStores = {
  build: (operations: HostedExecutionOperationsService, crypto: Crypto.Crypto) => {
    const decodeResponse = Schema.decodeUnknownEffect(ToolOperationResponse)
    const identifyOperation = (input: OperationIdentity) =>
      crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            encodeOperationIdentity({
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              threadId: input.threadId,
              turnId: input.turnId,
              runId: input.runId,
              rootRunId: input.rootRunId,
              toolCallId: input.toolCallId,
              code: input.code,
              attempt: input.attempt,
              replayPolicy: input.replayPolicy,
            }),
          ),
        )
        .pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError(() =>
            GatewayError.make({ kind: "transport", message: "Could not identify executor operation" }),
          ),
        )
    const matchesOperation = (input: OperationIdentity, row: OperationRecord, digest: string) =>
      row.requestDigest === digest &&
      row.workspaceId === input.workspaceId &&
      row.sessionId === input.sessionId &&
      row.threadId === input.threadId &&
      row.turnId === input.turnId &&
      row.runId === input.runId &&
      row.rootRunId === input.rootRunId &&
      row.toolCallId === input.toolCallId &&
      row.code === input.code &&
      row.attempt === input.attempt &&
      row.replayPolicy === input.replayPolicy
    const terminalResult = Effect.fn("Executor.terminalResult")(function* (
      row: Pick<OperationRecord, "response" | "terminalOutcome">,
    ): Effect.fn.Return<ExecutionResult, GatewayError> {
      if (row.response === null || row.terminalOutcome === null)
        return yield* GatewayError.make({ kind: "transport", message: "Persisted executor terminal is incomplete" })
      const response = yield* decodeResponse(row.response).pipe(
        Effect.mapError(() =>
          GatewayError.make({ kind: "transport", message: "Persisted executor response is invalid" }),
        ),
      )
      return { response, outcome: row.terminalOutcome }
    })
    const persistenceFailure = (message: string) =>
      Effect.mapError(() => GatewayError.make({ kind: "transport", message }))
    const lifecycle: LifecycleStore = {
      append: (access, frame) =>
        Effect.gen(function* () {
          const key = {
            assignmentId: access.fence.assignmentId,
            operationKey: frame.attribution.operationKey,
            attempt: frame.attribution.attempt,
          }
          const operation = yield* operations
            .findOperation(key)
            .pipe(persistenceFailure("Could not persist executor lifecycle frame"))
          if (operation === undefined)
            return yield* GatewayError.make({ kind: "fenced", message: "Executor lifecycle operation is unavailable" })
          const attribution = frame.attribution
          if (!matchesLifecycle(operation, attribution, access))
            return yield* GatewayError.make({
              kind: "fenced",
              message: "Executor lifecycle does not match its durable operation",
            })
          const result = yield* operations
            .appendFrame(access.fence.assignmentId, frame)
            .pipe(persistenceFailure("Could not persist executor lifecycle frame"))
          if (result === "invalid-sequence")
            return yield* GatewayError.make({
              kind: "fenced",
              message: "Executor lifecycle cursor has different content",
            })
          if (result === "duplicate")
            return operation.state === "completed" || operation.state === "unknown"
              ? ({ _tag: "AlreadyTerminal", result: yield* terminalResult(operation) } as const)
              : ({ _tag: "AlreadyAppended" } as const)
          if (result === "already-terminal")
            return { _tag: "AlreadyTerminal", result: yield* terminalResult(operation) } as const
          if (frame._tag === "Terminal") {
            const completed = yield* operations
              .complete(
                key,
                {
                  assignmentGeneration: access.fence.assignmentGeneration,
                  leaseEpoch: access.leaseEpoch,
                  executorInstanceId: access.fence.executorId,
                  processIncarnation: access.fence.processIncarnation,
                },
                frame.response,
                frame.outcome,
              )
              .pipe(persistenceFailure("Could not persist executor lifecycle frame"))
            if (!completed)
              return yield* GatewayError.make({ kind: "fenced", message: "Executor operation was not dispatched" })
          }
          return { _tag: "Appended" } as const
        }),
      load: (assignmentId, operationKey, attempt) =>
        operations
          .readFrames({ assignmentId, operationKey, attempt })
          .pipe(persistenceFailure("Could not load executor lifecycle frames")),
      prepare: (input) =>
        Effect.gen(function* () {
          const requestDigest = yield* identifyOperation(input)
          const row = yield* operations
            .upsertOperation({ ...input, requestDigest })
            .pipe(persistenceFailure("Could not persist executor operation"))
          if (row === undefined || !matchesOperation(input, row, requestDigest))
            return yield* GatewayError.make({
              kind: "fenced",
              message: "Executor operation key conflicts with a different request",
            })
          return { admittedAt: row.admittedAt, deadlineAt: row.deadlineAt }
        }),
      inspect: (input) =>
        Effect.gen(function* () {
          const row = yield* operations
            .findOperation(input)
            .pipe(persistenceFailure("Could not inspect executor operation"))
          if (row === undefined)
            return yield* GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
          const result = { state: row.state, started: row.started }
          if (row.response !== null) Object.assign(result, { response: row.response })
          if (row.terminalOutcome !== null) Object.assign(result, { outcome: row.terminalOutcome })
          if (row.dispatchedGeneration !== null)
            Object.assign(result, { dispatchedGeneration: row.dispatchedGeneration })
          if (row.dispatchedExecutorInstanceId !== null)
            Object.assign(result, { dispatchedExecutorInstanceId: row.dispatchedExecutorInstanceId })
          if (row.dispatchedProcessIncarnation !== null)
            Object.assign(result, { dispatchedProcessIncarnation: row.dispatchedProcessIncarnation })
          return result
        }),
      dispatch: (input, access) =>
        operations
          .claimDispatch(input, {
            assignmentGeneration: access.fence.assignmentGeneration,
            leaseEpoch: access.leaseEpoch,
            providerInstanceId: access.fence.instanceId,
            executorInstanceId: access.fence.executorId,
            processIncarnation: access.fence.processIncarnation,
          })
          .pipe(
            persistenceFailure("Could not persist executor dispatch"),
            Effect.flatMap((result) => {
              if (result === "claimed" || result === "same-fence") return Effect.void
              if (result === "missing")
                return GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
              return GatewayError.make({ kind: "fenced", message: "Executor dispatch fence is no longer current" })
            }),
          ),
      cancel: (input) =>
        Effect.gen(function* () {
          const digest = yield* identifyOperation(input)
          const current = yield* operations
            .findOperation(input)
            .pipe(persistenceFailure("Could not cancel executor operation"))
          if (current === undefined)
            return yield* GatewayError.make({ kind: "transport", message: "Executor operation is unavailable" })
          if (!matchesOperation(input, current, digest))
            return yield* GatewayError.make({
              kind: "fenced",
              message: "Executor operation key conflicts with a different request",
            })
          if (current.state === "completed" || current.state === "unknown")
            return { _tag: "AlreadyTerminal", result: yield* terminalResult(current) } as const
          if (current.state === "dispatched") return { _tag: "Dispatched", deadlineAt: current.deadlineAt } as const
          const terminalized = yield* operations
            .terminalizeAccepted(input, cancelledResponse, "cancelled")
            .pipe(persistenceFailure("Could not cancel executor operation"))
          if (terminalized !== undefined)
            return {
              _tag: "Cancelled",
              result: { response: cancelledResponse, outcome: "cancelled" },
            } as const
          const changed = yield* operations
            .findOperation(input)
            .pipe(persistenceFailure("Could not cancel executor operation"))
          if (changed?.state === "completed" || changed?.state === "unknown")
            return { _tag: "AlreadyTerminal", result: yield* terminalResult(changed) } as const
          if (changed?.state === "dispatched") return { _tag: "Dispatched", deadlineAt: changed.deadlineAt } as const
          return yield* GatewayError.make({
            kind: "fenced",
            message: "Executor operation changed before cancellation",
          })
        }),
    }
    return lifecycle
  },
}
