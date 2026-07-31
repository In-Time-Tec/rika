import * as ExecutionBackend from "../../execution/contract/execution-service"
import { AgentDepth } from "../../execution/contract/execution-service"
import { ExecutionId } from "../../execution/contract/execution-identifier"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import * as ExecutionStatus from "../../execution/contract/execution-status"
import * as Thread from "../../thread/model/thread-record"
import * as ThreadRepository from "../../thread/repository/thread-repository"
import * as TranscriptRepository from "../../thread/repository/transcript-repository"
import * as Turn from "../../thread/model/turn-record"
import * as TurnRepository from "../../thread/repository/turn-repository"
import * as UsageRepository from "../../thread/repository/usage-repository"
import * as ThreadActivity from "../../thread/query/thread-activity"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import type { InteractiveEvent, QueueItem } from "../interactive/interactive-event"
import { Clock, Duration, Effect, Function, Scope } from "effect"

const isTerminalStatus = ExecutionStatus.isTerminalStatus

export const fanOutTurnStatus = (state: "joining" | "satisfied" | "failed" | "cancelled"): Turn.Status => {
  if (state === "joining") return "running"
  return state === "satisfied" ? "completed" : state
}
export const normalizeChildExecutionId = TranscriptCorrelation.executionKey
export type ThreadUsageEvent = Extract<InteractiveEvent, { readonly _tag: "ThreadUsageUpdated" }>
export const initializeSelectedUsage = (threadId: Thread.ThreadId, request: number): ThreadUsageEvent => ({
  _tag: "ThreadUsageUpdated",
  selectionEpoch: request,
  threadId,
  revision: 0,
  cost: { _tag: "Unavailable" },
  tokens: { _tag: "Unavailable" },
  time: { _tag: "Unavailable" },
})
export const persistedThreadUsage = (
  value: UsageRepository.Aggregate,
): Pick<ThreadUsageEvent, "cost" | "tokens" | "time"> => ({
  cost:
    value.costNanoUsd === undefined
      ? { _tag: "Unavailable" }
      : { _tag: "Available", usd: value.costNanoUsd / 1_000_000_000, unpricedAttempts: value.unpricedAttempts },
  tokens:
    value.tokens === undefined
      ? { _tag: "Unavailable" }
      : { _tag: "Available", total: value.tokens, uncountedAttempts: value.uncountedAttempts },
  time:
    value.activeMillis === undefined
      ? { _tag: "Unavailable" }
      : {
          _tag: "Available",
          accumulatedMillis: value.activeMillis,
          ...(value.activeSince === undefined ? {} : { activeSince: value.activeSince }),
        },
})
export const transcriptProjectionEvent = (change: ExecutionIngest.ProjectionChange): InteractiveEvent => {
  switch (change._tag) {
    case "ProjectionStarted": {
      const { rootStatus: startedRootStatus, ...snapshot } = change.snapshot
      return {
        _tag: "TranscriptProjectionStarted",
        selectionEpoch: 0,
        ...snapshot,
        ...(startedRootStatus === undefined ? {} : { rootStatus: startedRootStatus }),
      }
    }
    case "ProjectionPatched": {
      const { rootStatus: patchedRootStatus, ...patch } = change.patch
      return {
        _tag: "TranscriptProjectionPatched",
        selectionEpoch: 0,
        ...patch,
        ...(patchedRootStatus === undefined ? {} : { rootStatus: patchedRootStatus }),
      }
    }
    case "ProjectionStopped":
      return {
        _tag: "TranscriptProjectionStopped",
        selectionEpoch: 0,
        threadId: change.threadId,
        rootTurnId: change.rootTurnId,
        streamId: change.streamId,
        patchRevision: change.patchRevision,
        status: change.status,
      }
    case "ProjectionFailed":
      return {
        _tag: "TranscriptProjectionFailed",
        selectionEpoch: 0,
        threadId: change.threadId,
        rootTurnId: change.rootTurnId,
        streamId: change.streamId,
        patchRevision: change.patchRevision,
        executionId: change.failure.executionId ?? String(change.rootTurnId),
        reason: change.failure.reason,
        message: change.failure.message,
      }
    default:
      return Function.absurd(change)
  }
}
export const rootExecutionEvents: {
  (turnId: string, events: ReadonlyArray<ExecutionBackend.Event>): ReadonlyArray<ExecutionBackend.Event>
  (events: ReadonlyArray<ExecutionBackend.Event>): (turnId: string) => ReadonlyArray<ExecutionBackend.Event>
} = Function.dual(
  2,
  (turnId: string, events: ReadonlyArray<ExecutionBackend.Event>): ReadonlyArray<ExecutionBackend.Event> =>
    events.filter((event) => ExecutionId.ownsExecution(turnId, event.executionId)),
)
export const undeliveredEvents = (
  events: ReadonlyArray<ExecutionBackend.Event>,
  delivered: ReadonlySet<string>,
): ReadonlyArray<ExecutionBackend.Event> =>
  events.filter((event) => !delivered.has(event.cursor)).toSorted((left, right) => left.sequence - right.sequence)
export type SelectionEpochState = {
  readonly epoch: number
  readonly thread: Thread.Thread
  readonly loadedKeys: Set<string>
  transcriptCursor: TranscriptRepository.PageCursor | undefined
  newestTranscriptCursor: TranscriptRepository.PageCursor | undefined
  hasOlder: boolean
  projectionFeed?: {
    readonly watch: ExecutionIngest.ProjectionWatch
    readonly scope: Scope.Closeable
    promoted: boolean
  }
}
export const makeSelectionState = (thread: Thread.Thread, epoch: number): SelectionEpochState => ({
  epoch,
  thread,
  loadedKeys: new Set(),
  transcriptCursor: undefined,
  newestTranscriptCursor: undefined,
  hasOlder: false,
})
export const projectedOutcomeStatus = (status: "completed" | "failed" | "cancelled"): "complete" | "failed" | "cancelled" =>
  status === "completed" ? "complete" : status
const sessionQuiescencePollAttempts = 40
const sessionQuiescenceCandidateLimit = 8
export const executionTreeQuiescent = Effect.fn("ProductOperation.executionTreeQuiescent")(function* (
  backend: ExecutionBackend.Interface,
  turnId: string,
  reference: boolean = false,
) {
  const root = yield* backend.inspect(turnId, reference ? ExecutionBackend.executionReference : undefined)
  if (root === undefined) return true
  if (!isTerminalStatus(root.status)) return false
  const pending: Array<string> = []
  const seen = new Set<string>()
  for (const child of root.children) {
    if (!isTerminalStatus(child.status)) return false
    seen.add(normalizeChildExecutionId(child.executionId))
    pending.push(child.executionId)
  }
  while (pending.length > 0) {
    const current = pending.shift()!
    const inspection = yield* backend.inspect(current, ExecutionBackend.executionReference)
    if (inspection === undefined) continue
    if (!isTerminalStatus(inspection.status)) return false
    for (const child of inspection.children) {
      const normalized = normalizeChildExecutionId(child.executionId)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      if (!isTerminalStatus(child.status)) return false
      pending.push(child.executionId)
    }
  }
  return true
})
export const hasActiveExecutionWork = Effect.fn("ProductOperation.hasActiveExecutionWork")(function* () {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const persisted =
    backend.listOpenRootExecutions === undefined
      ? (yield* Effect.forEach(yield* (yield* ThreadRepository.Service).listAll, (thread) => turns.list(thread.id), {
          concurrency: 1,
        }))
          .flat()
          .filter(Turn.isAgentExecution)
          .filter((turn) => turn.status !== "queued")
      : (yield* turns.listNonterminal).filter((turn) => turn.status !== "queued")
  for (const turn of persisted) {
    const terminal = isTerminalStatus(turn.status)
    if (turn.reviewFanOutId !== undefined) {
      const fanOut = yield* backend.inspectFanOut(turn.reviewFanOutId)
      if (fanOut === undefined) {
        if (!terminal) yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
        continue
      }
      if (fanOut.state === "joining" || fanOut.members.some((member) => !isTerminalStatus(member.state))) return true
      for (const member of fanOut.members) {
        const executionId = AgentDepth.childExecutionId(turn.id, member.childId)
        if (!(yield* executionTreeQuiescent(backend, executionId, true))) return true
      }
      if (!terminal) {
        const status = fanOutTurnStatus(fanOut.state)
        yield* turns.setStatus(turn.id, status, turn.lastCursor, yield* Clock.currentTimeMillis)
      }
      continue
    }
    const inspection = yield* backend.inspect(turn.id)
    if (inspection === undefined) {
      if (!terminal) yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
      continue
    }
    if (!(yield* executionTreeQuiescent(backend, turn.id))) return true
    if (!terminal)
      yield* turns.setStatus(
        turn.id,
        inspection.status,
        inspection.lastCursor ?? turn.lastCursor,
        yield* Clock.currentTimeMillis,
      )
  }
  return backend.listOpenRootExecutions === undefined ? false : (yield* backend.listOpenRootExecutions).length > 0
})
const blockedSessionWriter = Effect.fn("ProductOperation.blockedSessionWriter")(function* (
  backend: ExecutionBackend.Interface,
  threadId: Thread.ThreadId,
) {
  const turns = yield* TurnRepository.Service
  const history = yield* turns.list(threadId)
  const candidates = history
    .filter(Turn.isAgentExecution)
    .filter((turn) => turn.status === "cancelled" || turn.status === "failed")
    .slice(-sessionQuiescenceCandidateLimit)
    .toReversed()
  for (const candidate of candidates) {
    const quiescent = yield* executionTreeQuiescent(backend, candidate.id).pipe(Effect.orElseSucceed(() => false))
    if (!quiescent) return candidate
  }
  return undefined
})
export const settleStopRequestedTurns = Effect.fn("ProductOperation.settleStopRequestedTurns")(function* <E, R>(
  backend: ExecutionBackend.Interface,
  settle: (
    turnId: Turn.TurnId,
    status: Turn.Status,
    cursor: string | undefined,
    settledAt: number,
  ) => Effect.Effect<void, E, R>,
) {
  const turns = yield* TurnRepository.Service
  for (const turn of yield* turns.listStopRequested) {
    const outcome = yield* Effect.result(backend.cancel(turn.id))
    if (outcome._tag === "Failure") {
      yield* Effect.logWarning("execution.stop.settle_cancel_failed").pipe(
        Effect.annotateLogs({ "rika.turn.id": String(turn.id), "rika.failure.kind": String(outcome.failure) }),
      )
      continue
    }
    const result = outcome.success
    yield* settle(
      turn.id,
      result.status,
      result.checkpoint?.cursor ?? ThreadActivity.latestCursor(turn.id, result.events) ?? turn.lastCursor,
      yield* Clock.currentTimeMillis,
    )
    yield* Effect.logInfo("execution.stop.settled").pipe(Effect.annotateLogs({ "rika.turn.id": String(turn.id) }))
  }
})
export const stopActiveExecutionWork = Effect.fn("ProductOperation.stopActiveExecutionWork")(function* () {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const running = (yield* turns.listNonterminal).filter((turn) => turn.status !== "queued")
  const requestedAt = yield* Clock.currentTimeMillis
  for (const turn of running) yield* turns.requestStop(turn.id, requestedAt)
  if (running.length > 0)
    yield* Effect.logInfo("execution.stop.requested_for_all").pipe(Effect.annotateLogs({ "rika.turn.count": running.length }))
  yield* settleStopRequestedTurns(backend, (turnId, status, cursor, settledAt) =>
    turns.setStatus(turnId, status, cursor, settledAt).pipe(Effect.asVoid),
  )
})
export const settleAbandonedRecoveredWork = Effect.fn("ProductOperation.settleAbandonedRecoveredWork")(function* (
  grace: Duration.Duration,
  watchedThreads: () => ReadonlySet<string>,
) {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const bootAt = yield* Clock.currentTimeMillis
  yield* Effect.sleep(grace)
  const watched = watchedThreads()
  const abandoned = (yield* turns.listNonterminal).filter(
    (turn) => turn.status !== "queued" && turn.createdAt < bootAt && !watched.has(String(turn.threadId)),
  )
  const requestedAt = yield* Clock.currentTimeMillis
  for (const turn of abandoned) {
    yield* turns.requestStop(turn.id, requestedAt)
    yield* Effect.logInfo("execution.recovery.abandoned_stop_requested").pipe(
      Effect.annotateLogs({ "rika.turn.id": String(turn.id), "rika.thread.id": String(turn.threadId) }),
    )
  }
  if (abandoned.length > 0)
    yield* settleStopRequestedTurns(backend, (turnId, status, cursor, settledAt) =>
      turns.setStatus(turnId, status, cursor, settledAt).pipe(Effect.asVoid),
    )
  if (backend.listOpenRootExecutions === undefined) return
  const openRoots = yield* backend.listOpenRootExecutions.pipe(Effect.orElseSucceed(() => []))
  for (const root of openRoots) {
    if (root.createdAt >= bootAt) continue
    const turn = root.turnId === undefined ? undefined : yield* turns.get(Turn.TurnId.make(root.turnId))
    if (turn !== undefined && Turn.isAgentExecution(turn) && !isTerminalStatus(turn.status)) continue
    yield* backend.cancel(root.executionId, ExecutionBackend.executionReference).pipe(
      Effect.catch((failure) =>
        Effect.logWarning("execution.recovery.orphan_cancel_failed").pipe(
          Effect.annotateLogs({ "rika.execution.id": root.executionId, "rika.failure.kind": String(failure) }),
        ),
      ),
    )
    yield* Effect.logInfo("execution.recovery.orphan_cancelled").pipe(
      Effect.annotateLogs({ "rika.execution.id": root.executionId }),
    )
  }
})
export const awaitSessionQuiescence = Effect.fn("ProductOperation.awaitSessionQuiescence")(function* (
  backend: ExecutionBackend.Interface,
  threadId: Thread.ThreadId,
) {
  let blocked = yield* blockedSessionWriter(backend, threadId)
  if (blocked === undefined) return undefined
  yield* Effect.logInfo("execution.admission.blocked").pipe(
    Effect.annotateLogs({
      "rika.thread.id": String(threadId),
      "rika.predecessor.turn.id": String(blocked.id),
      "rika.predecessor.turn.status": blocked.status,
    }),
  )
  for (let attempt = 1; attempt < sessionQuiescencePollAttempts; attempt += 1) {
    yield* Effect.sleep("250 millis")
    blocked = yield* blockedSessionWriter(backend, threadId)
    if (blocked === undefined) return undefined
  }
  yield* Effect.logWarning("execution.admission.deferred").pipe(
    Effect.annotateLogs({
      "rika.thread.id": String(threadId),
      "rika.predecessor.turn.id": String(blocked.id),
      "rika.predecessor.turn.status": blocked.status,
    }),
  )
  return blocked
})
export const queueItem = (turn: Turn.AgentExecutionTurn): QueueItem => {
  const attachments = turn.promptParts
    ?.filter((part) => part.type === "image")
    .flatMap((part) => (part.filename === undefined ? [] : [part.filename]))
  return attachments === undefined || attachments.length === 0
    ? { id: turn.id, prompt: turn.prompt }
    : { id: turn.id, prompt: turn.prompt, attachments }
}
