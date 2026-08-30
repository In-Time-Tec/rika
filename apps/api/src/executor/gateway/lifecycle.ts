import * as HostedObservability from "@rika/product/hosted-observability"
import type { AccessWire, CellLifecycleFrame } from "@rika/remote-execution/protocol"
import { Effect, Ref, type Semaphore } from "effect"
import type { ExecuteInput, LifecycleAppendDisposition, LifecycleStore, Socket } from "./contract"
import { GatewayError } from "./contract"
import { gatewayProtocol } from "./protocol"
import type { GatewaySession, PendingOperation } from "./rpc/model"

type TerminalFrame = Extract<CellLifecycleFrame, { readonly _tag: "Terminal" }>

export interface GatewayLifecycleDependencies {
  readonly lifecycle: LifecycleStore
  readonly sessions: Ref.Ref<Map<string, GatewaySession>>
  readonly assignments: Ref.Ref<Map<Socket, string>>
  readonly pending: Ref.Ref<Map<string, PendingOperation>>
  readonly frames: Ref.Ref<Map<string, ReadonlyArray<CellLifecycleFrame>>>
  readonly terminals: Ref.Ref<Map<string, TerminalFrame>>
  readonly admission: Semaphore.Semaphore
  readonly settleCancelled: (assignmentId: string, operationKey: string, attempt: number) => Effect.Effect<void>
}

const invalidHydration = () =>
  GatewayError.make({ kind: "transport", message: "Persisted executor lifecycle is invalid" })

const matchesInput = (frame: CellLifecycleFrame, input: ExecuteInput) => {
  const identity = frame.attribution
  return (
    identity.operationKey === input.operationKey &&
    identity.workspaceId === input.workspaceId &&
    identity.sessionId === input.sessionId &&
    identity.threadId === input.threadId &&
    identity.turnId === input.turnId &&
    identity.runId === input.runId &&
    identity.rootRunId === input.rootRunId &&
    identity.toolCallId === input.toolCallId &&
    identity.attempt === input.attempt
  )
}

const validFramePosition = (frame: CellLifecycleFrame, index: number) =>
  frame.cursor === index + 1 &&
  ((index === 0 && frame._tag === "Accepted") ||
    (index === 1 && frame._tag === "Started") ||
    (index > 1 && (frame._tag === "Output" || frame._tag === "Terminal")))

const inspectRetained = (retained: ReadonlyArray<CellLifecycleFrame>, input: ExecuteInput) => {
  let outputCount = 0
  let terminal: TerminalFrame | undefined
  for (const [index, frame] of retained.entries()) {
    if (!validFramePosition(frame, index) || !matchesInput(frame, input) || terminal !== undefined)
      return { valid: false } as const
    if (frame._tag === "Output" && ++outputCount > 16) return { valid: false } as const
    if (frame._tag === "Terminal") terminal = frame
  }
  return { valid: true, terminal } as const
}

const matchesPending = (frame: CellLifecycleFrame, operation: PendingOperation) => {
  const attribution = frame.attribution
  const request = operation.request
  return (
    attribution.workspaceId === request.workspaceId &&
    attribution.sessionId === request.sessionId &&
    attribution.threadId === request.threadId &&
    attribution.turnId === request.turnId &&
    attribution.runId === request.runId &&
    attribution.rootRunId === request.rootRunId &&
    attribution.toolCallId === request.toolCallId
  )
}

const validAppend = (frame: CellLifecycleFrame, known: ReadonlyArray<CellLifecycleFrame>) =>
  frame.cursor === known.length + 1 &&
  !known.some((retained) => retained._tag === "Terminal") &&
  ((frame.cursor === 1 && frame._tag === "Accepted") ||
    (frame.cursor === 2 && frame._tag === "Started") ||
    (frame.cursor > 2 && (frame._tag === "Output" || frame._tag === "Terminal"))) &&
  !(frame._tag === "Output" && known.filter((retained) => retained._tag === "Output").length >= 16)

const validSession = (
  session: GatewaySession | undefined,
  operation: PendingOperation | undefined,
  socket: Socket,
  access: AccessWire,
  attempt: number,
) =>
  session?.socket === socket &&
  gatewayProtocol.sameAccess(session.access, access) &&
  (operation === undefined || (operation.socket === socket && operation.attempt === attempt))

const conflictingFrame = (existing: CellLifecycleFrame | undefined, frame: CellLifecycleFrame) =>
  existing !== undefined && !gatewayProtocol.equivalentLifecycle(existing, frame)

const observeAccepted = (frame: CellLifecycleFrame, disposition: LifecycleAppendDisposition) => {
  if (disposition._tag !== "Appended" || frame._tag !== "Accepted") return Effect.void
  const attribution = frame.attribution
  return HostedObservability.event("cell_admission", "success", {
    threadId: attribution.threadId,
    turnId: attribution.turnId,
    runId: attribution.runId,
    operationId: attribution.operationKey,
    cellId: attribution.toolCallId,
  })
}

const observeTerminal = (frame: TerminalFrame, disposition: LifecycleAppendDisposition) => {
  if (disposition._tag !== "Appended") return Effect.void
  const attribution = frame.attribution
  if (frame.outcome === "unknown")
    return HostedObservability.unknownOutcome({
      threadId: attribution.threadId,
      turnId: attribution.turnId,
      runId: attribution.runId,
      operationId: attribution.operationKey,
      cellId: attribution.toolCallId,
    })
  let outcome: "success" | "interrupted" | "failure" = "failure"
  if (frame.outcome === "completed") outcome = "success"
  if (frame.outcome === "cancelled") outcome = "interrupted"
  return HostedObservability.event("terminal", outcome, {
    threadId: attribution.threadId,
    turnId: attribution.turnId,
    runId: attribution.runId,
    operationId: attribution.operationKey,
    cellId: attribution.toolCallId,
  })
}

const sendTerminalReceipt = (
  socket: Socket,
  access: AccessWire,
  frame: TerminalFrame,
  disposition: LifecycleAppendDisposition,
) => {
  const attribution = frame.attribution
  socket.send(
    gatewayProtocol.encode(
      disposition._tag === "AlreadyTerminal"
        ? {
            _tag: "CellTerminalSuperseded",
            access,
            operationKey: attribution.operationKey,
            attempt: attribution.attempt,
            cursor: frame.cursor,
            outcome: disposition.result.outcome,
            response: disposition.result.response,
          }
        : {
            _tag: "CellTerminalReceipt",
            access,
            operationKey: attribution.operationKey,
            attempt: attribution.attempt,
            cursor: frame.cursor,
          },
    ),
  )
}

export const gatewayLifecycleFactory = (dependencies: GatewayLifecycleDependencies) => {
  const { lifecycle, sessions, assignments, pending, frames, terminals, admission, settleCancelled } = dependencies

  const hydrate = Effect.fn("ExecutorGateway.hydrate")(function* (input: ExecuteInput) {
    const retained = yield* lifecycle.load(input.assignmentId, input.operationKey, input.attempt)
    const inspection = inspectRetained(retained, input)
    if (!inspection.valid) return yield* invalidHydration()
    const operationKey = gatewayProtocol.key(input.assignmentId, input.operationKey, input.attempt)
    yield* Ref.update(frames, (current) => new Map(current).set(operationKey, retained))
    yield* Ref.update(terminals, (current) => {
      const next = new Map(current)
      if (inspection.terminal === undefined) next.delete(operationKey)
      else next.set(operationKey, inspection.terminal)
      return next
    })
  })

  const persistTerminal = Effect.fn("ExecutorGateway.persistTerminal")(function* (
    assignmentId: string,
    operationKey: string,
    access: AccessWire,
    socket: Socket,
    frame: TerminalFrame,
    disposition: LifecycleAppendDisposition,
  ) {
    const outcome = disposition._tag === "AlreadyTerminal" ? disposition.result.outcome : frame.outcome
    if (outcome === "cancelled")
      yield* settleCancelled(assignmentId, frame.attribution.operationKey, frame.attribution.attempt)
    yield* observeTerminal(frame, disposition)
    if (disposition._tag === "Appended")
      yield* Ref.update(terminals, (current) => new Map(current).set(operationKey, frame))
    sendTerminalReceipt(socket, access, frame, disposition)
  })

  const persistLifecycle = Effect.fn("ExecutorGateway.persistLifecycle")(function* (
    socket: Socket,
    access: AccessWire,
    frame: CellLifecycleFrame,
  ) {
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = (yield* Ref.get(assignments)).get(socket)
        if (assignmentId === undefined)
          return yield* GatewayError.make({ kind: "fenced", message: "Executor is not registered" })
        const session = (yield* Ref.get(sessions)).get(assignmentId)
        const operationKey = gatewayProtocol.key(
          assignmentId,
          frame.attribution.operationKey,
          frame.attribution.attempt,
        )
        const operation = (yield* Ref.get(pending)).get(operationKey)
        if (!validSession(session, operation, socket, access, frame.attribution.attempt))
          return yield* GatewayError.make({ kind: "fenced", message: "Executor lifecycle frame has a stale session" })
        if (operation !== undefined && !matchesPending(frame, operation))
          return yield* GatewayError.make({ kind: "fenced", message: "Executor lifecycle attribution is invalid" })
        const cached = (yield* Ref.get(frames)).get(operationKey)
        const known =
          cached ?? (yield* lifecycle.load(assignmentId, frame.attribution.operationKey, frame.attribution.attempt))
        const existing = known.find((retained) => retained.cursor === frame.cursor)
        if (conflictingFrame(existing, frame))
          return yield* GatewayError.make({
            kind: "fenced",
            message: "Executor lifecycle cursor has different content",
          })
        if (existing === undefined && !validAppend(frame, known))
          return yield* GatewayError.make({ kind: "fenced", message: "Executor lifecycle sequence is invalid" })
        const disposition =
          existing === undefined ? yield* lifecycle.append(access, frame) : { _tag: "AlreadyAppended" as const }
        if (disposition._tag === "Appended" && existing === undefined)
          yield* Ref.update(frames, (current) => new Map(current).set(operationKey, [...known, frame]))
        yield* observeAccepted(frame, disposition)
        if (frame._tag === "Terminal")
          yield* persistTerminal(assignmentId, operationKey, access, socket, frame, disposition)
      }),
    )
  })

  return { hydrate, persistLifecycle }
}
