import * as ExecutionBackend from "../../execution/contract/execution-service"
import { AgentDepth } from "../../execution/contract/execution-service"
import * as ExecutionStatus from "../../execution/contract/execution-status"
import * as Thread from "../../thread/model/thread-record"
import * as ThreadRepository from "../../thread/repository/thread-repository"
import * as Turn from "../../thread/model/turn-record"
import * as TurnRepository from "../../thread/repository/turn-repository"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import { Clock, Effect } from "effect"
export interface ExecutionActivity {
  readonly active: number
  readonly pending: number
  readonly reading: number
  readonly stopped: boolean
}

export const isProductExecutionQuiescent = (activity: ExecutionActivity): boolean =>
  activity.active === 0 && activity.pending === 0 && activity.reading === 0 && activity.stopped

export const fanOutTurnStatus = (state: "joining" | "satisfied" | "failed" | "cancelled"): Turn.Status => {
  if (state === "joining") return "running"
  return state === "satisfied" ? "completed" : state
}

const isTerminalStatus = ExecutionStatus.isTerminalStatus
const normalizeChildExecutionId = TranscriptCorrelation.executionKey

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

const sessionQuiescencePollAttempts = 40
const sessionQuiescenceCandidateLimit = 8

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
