import { TurnResult } from "@rika/product/thread-result"
import { Service } from "@rika/product/thread-summary-repository"
export { Service }
import * as ExecutionStatus from "@rika/product/execution-status"
import { Effect, Layer, Ref, Schema } from "effect"
import * as ThreadRepository from "../thread/memory-thread-repository"
import { ThreadId } from "@rika/product/thread-record"
import { EditTotals, RepairCandidate, ThreadSummary } from "@rika/product/thread-summary"
import * as TurnRepository from "../turn/memory-turn-repository"
import { TurnId } from "@rika/product/turn-record"
import * as ThreadState from "@rika/product/thread-state"

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("ThreadSummaryRepositoryError", {
  message: Schema.String,
}) {}

export interface ListInput {
  readonly includeArchived?: boolean
  readonly limit?: number
}

export interface TurnActivityInput {
  readonly turnId: TurnId
  readonly threadId: ThreadId
  readonly projectedCursor?: string
  readonly complete: boolean
  readonly editTotals: EditTotals
  readonly lastEventAt?: number
  readonly now: number
}

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<ThreadSummary>, RepositoryError>
  readonly ensureTurn: (turnId: TurnId, threadId: ThreadId, now: number) => Effect.Effect<void, RepositoryError>
  readonly replaceTurn: (input: TurnActivityInput) => Effect.Effect<void, RepositoryError>
  readonly markRead: (threadId: ThreadId, now: number) => Effect.Effect<void, RepositoryError>
  readonly listRepairCandidates: (limit?: number) => Effect.Effect<ReadonlyArray<RepairCandidate>, RepositoryError>
}

interface Activity {
  readonly turnId: TurnId
  readonly threadId: ThreadId
  readonly projectedCursor?: string
  readonly complete: boolean
  readonly editTotals: EditTotals
  readonly lastEventAt?: number
  readonly updatedAt: number
}

const repositoryError = (error: unknown) => RepositoryError.make({ message: String(error) })
const listLimit = (value: number | undefined) => Math.min(Math.max(value ?? 100, 1), 100)

const compareSummaries = (left: ThreadSummary, right: ThreadSummary) =>
  Number(right.pinned) - Number(left.pinned) ||
  right.lastActivityAt - left.lastActivityAt ||
  left.id.localeCompare(right.id)

export const makeMemory = Effect.fn("ThreadSummaryRepository.makeMemory")(function* () {
  const threads = yield* ThreadRepository.Service
  const turns = yield* TurnRepository.Service
  const activities = yield* Ref.make(new Map<TurnId, Activity>())
  const readAt = yield* Ref.make(new Map<ThreadId, number>())

  const list = Effect.fn("ThreadSummaryRepository.list")(function* (input: ListInput = {}) {
    const threadValues = yield* threads
      .list({ includeArchived: true, limit: 100 })
      .pipe(Effect.mapError(repositoryError))
    const activityValues = yield* Ref.get(activities)
    const readValues = yield* Ref.get(readAt)
    const summaries = yield* Effect.forEach(threadValues, (thread) =>
      Effect.gen(function* () {
        const history = yield* turns.list(thread.id).pipe(Effect.mapError(repositoryError))
        const projected = history.flatMap((turn) => {
          const activity = activityValues.get(turn.id)
          return activity === undefined ? [] : [activity]
        })
        const currentProjected = history.flatMap((turn) => {
          const activity = activityValues.get(turn.id)
          return activity !== undefined &&
            (TurnResult.isAgentExecution(turn)
              ? activity.projectedCursor === turn.lastCursor &&
                (!ExecutionStatus.isTerminalStatus(turn.status) || activity.complete)
              : !ExecutionStatus.isTerminalStatus(turn.status) || activity.complete)
            ? [activity]
            : []
        })
        const lastActivityAt = Math.max(
          thread.createdAt,
          ...history.map((turn) => turn.updatedAt),
          ...projected.flatMap((activity) => (activity.lastEventAt === undefined ? [] : [activity.lastEventAt])),
        )
        const totals = currentProjected.reduce(
          (total, activity) => ({
            added: total.added + activity.editTotals.added,
            modified: total.modified + activity.editTotals.modified,
            removed: total.removed + activity.editTotals.removed,
          }),
          { added: 0, modified: 0, removed: 0 },
        )
        return ThreadSummary.make({
          id: thread.id,
          workspace: thread.workspace,
          title: thread.title,
          pinned: thread.pinned,
          archived: thread.archived,
          status: ThreadState.threadState(history.map((turn) => turn.status)),
          unread: lastActivityAt > (readValues.get(thread.id) ?? 0),
          lastActivityAt,
          ...(history.length > 0 && currentProjected.length === history.length ? { editTotals: totals } : {}),
        })
      }),
    )
    return summaries
      .filter((summary) => input.includeArchived === true || !summary.archived)
      .toSorted(compareSummaries)
      .slice(0, listLimit(input.limit))
  })

  return Service.of({
    list,
    ensureTurn: Effect.fn("ThreadSummaryRepository.ensureTurn")(function* (turnId, threadId, now) {
      yield* Ref.update(activities, (current) =>
        current.has(turnId)
          ? current
          : new Map(current).set(turnId, {
              turnId,
              threadId,
              complete: false,
              editTotals: { added: 0, modified: 0, removed: 0 },
              updatedAt: now,
            }),
      )
    }),
    replaceTurn: Effect.fn("ThreadSummaryRepository.replaceTurn")(function* (input) {
      yield* Ref.update(activities, (current) =>
        (current.get(input.turnId)?.updatedAt ?? Number.NEGATIVE_INFINITY) > input.now
          ? current
          : new Map(current).set(input.turnId, {
              turnId: input.turnId,
              threadId: input.threadId,
              ...(input.projectedCursor === undefined ? {} : { projectedCursor: input.projectedCursor }),
              complete: input.complete,
              editTotals: structuredClone(input.editTotals),
              ...(input.lastEventAt === undefined ? {} : { lastEventAt: input.lastEventAt }),
              updatedAt: input.now,
            }),
      )
    }),
    markRead: Effect.fn("ThreadSummaryRepository.markRead")(function* (threadId, now) {
      yield* Ref.update(readAt, (current) => new Map(current).set(threadId, Math.max(current.get(threadId) ?? 0, now)))
    }),
    listRepairCandidates: Effect.fn("ThreadSummaryRepository.listRepairCandidates")(function* (limit = 25) {
      const activityValues = yield* Ref.get(activities)
      const threadValues = yield* threads
        .list({ includeArchived: true, limit: 100 })
        .pipe(Effect.mapError(repositoryError))
      const history = (yield* Effect.forEach(threadValues, (thread) =>
        turns.list(thread.id).pipe(Effect.mapError(repositoryError)),
      )).flat()
      return history
        .filter(TurnResult.isAgentExecution)
        .filter((turn) => {
          const activity = activityValues.get(turn.id)
          return (
            activity === undefined ||
            activity.projectedCursor !== turn.lastCursor ||
            (ExecutionStatus.isTerminalStatus(turn.status) && !activity.complete)
          )
        })
        .slice(0, listLimit(limit))
        .map((turn) =>
          RepairCandidate.make({
            turnId: turn.id,
            threadId: turn.threadId,
            status: turn.status,
            ...(turn.lastCursor === undefined ? {} : { lastCursor: turn.lastCursor }),
          }),
        )
    }),
  })
})

export const memoryLayer = Layer.effect(Service, makeMemory())
