import * as ExecutionGateway from "../../execution/gateway/service"
import * as ExecutionProjection from "../../execution/projection/contract"
import * as Thread from "../../thread/model/record"
import * as ThreadRepository from "../../thread/repository/record"
import * as ThreadSummaryRepository from "../../thread/repository/summary"
import * as TranscriptRepository from "../../thread/repository/transcript"
import { recordedShellProjection, settleRecordedShellProjection } from "@rika/transcript/recorded-shell-presentation"
import * as Turn from "../../thread/turn/record"
import * as ThreadResult from "@rika/product/thread-result"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as TurnRepository from "../../thread/repository/turn"
import { clampThreadTitle } from "../../thread/query/title-policy"
import { Input } from "../contract/product"
import { OperationUnavailable } from "../contract/product"
import { OperationError, operationError } from "../error"
import { Clock, Context, Effect, Semaphore, Console } from "effect"

export interface Dependencies {
  readonly defaultWorkspace: string
  readonly pendingTurnCapacity: number
  readonly makeThreadId: Effect.Effect<Thread.ThreadId>
  readonly makeTurnId: Effect.Effect<Turn.TurnId>
  readonly turnMutationAdmission: Semaphore.Semaphore
  readonly backend: ExecutionGateway.Interface
  readonly notifyThreadSummaries: Effect.Effect<void, OperationError, ThreadSummaryRepository.Service>
  readonly deleteThread: (threadId: Thread.ThreadId) => Effect.Effect<void, Error>
  readonly writeThread: (thread: Thread.Thread) => Effect.Effect<void>
  readonly requireThread: (
    repository: ThreadRepository.Interface,
    id: string,
  ) => Effect.Effect<Thread.Thread, OperationError, never>
  readonly markdownExport: (thread: Thread.Thread, turns: ReadonlyArray<Turn.Turn>) => string
  readonly encodeJson: <Value>(value: Value) => string
  readonly unavailable: (input: Input, message: string) => OperationUnavailable
}

export const run = Effect.fn("ThreadOperation.run")(function* (
  input: Extract<Input, { readonly _tag: "Thread" }>,
  dependencies: Dependencies,
) {
  const program = Effect.gen(function* () {
    const repository = yield* ThreadRepository.Service
    const turns = yield* TurnRepository.Service
    const now = yield* Clock.currentTimeMillis
    switch (input.action) {
      case "new": {
        const id = yield* dependencies.makeThreadId
        const thread = yield* repository.create({
          id,
          workspace: input.clientWorkspace ?? dependencies.defaultWorkspace,
          title: "New thread",
          now,
        })
        yield* dependencies.notifyThreadSummaries
        yield* dependencies.writeThread(thread)
        return
      }
      case "list": {
        let threads: ReadonlyArray<Thread.Thread>
        if (input.includeArchived === undefined)
          threads = yield* repository.list(input.limit === undefined ? undefined : { limit: input.limit })
        else
          threads = yield* repository.list(
            input.limit === undefined
              ? { includeArchived: input.includeArchived }
              : { includeArchived: input.includeArchived, limit: input.limit },
          )
        yield* Console.log(dependencies.encodeJson(threads))
        return
      }
      case "search": {
        const searchInput =
          input.includeArchived === undefined ? { limit: 100 } : { includeArchived: input.includeArchived, limit: 100 }
        const candidates = yield* repository.list(searchInput)
        const terms = input.query.map((term: string) => term.toLowerCase())
        const matches = candidates
          .filter((thread) => {
            const fields = [thread.id, thread.title, thread.workspace, ...thread.labels].map((field) =>
              field.toLowerCase(),
            )
            return terms.every((term: string) => fields.some((field) => field.includes(term)))
          })
          .slice(0, Math.min(Math.max(input.limit ?? 50, 1), 100))
        yield* Console.log(dependencies.encodeJson(matches))
        return
      }
      case "last":
      case "top": {
        const thread = (yield* repository.list({ limit: 1 }))[0]
        if (thread === undefined) return yield* operationError("No threads exist")
        yield* dependencies.writeThread(thread)
        return
      }
      case "continue": {
        yield* Effect.gen(function* () {
          let selected: Thread.Thread | ReadonlyArray<Thread.Thread>
          if ("last" in input) {
            const thread = (yield* repository.list({ limit: 1 }))[0]
            if (thread === undefined) return yield* operationError("No threads exist")
            selected = thread
          } else {
            selected = yield* Effect.forEach(input.threadIds, (id) => dependencies.requireThread(repository, id))
          }
          const selectedThreads = Array.isArray(selected) ? selected : [selected]
          const continued = yield* Effect.forEach(selectedThreads, (thread) =>
            Effect.gen(function* () {
              const threadTurns = yield* turns.list(thread.id)
              const history = threadTurns.map((turn) => ({ turn, status: turn.status }))
              return { ...thread, turns: history }
            }),
          )
          yield* Console.log(dependencies.encodeJson(Array.isArray(selected) ? continued : continued[0]))
        }).pipe(Effect.provide(Context.make(ExecutionGateway.Service, dependencies.backend)), Effect.scoped)
        return
      }
      case "rename":
        yield* repository
          .rename(Thread.ThreadId.make(input.threadId), clampThreadTitle(input.title) || "New thread", now)
          .pipe(Effect.flatMap(dependencies.writeThread))
        yield* dependencies.notifyThreadSummaries
        return
      case "label":
        yield* repository
          .label(Thread.ThreadId.make(input.threadId), input.labels, now)
          .pipe(Effect.flatMap(dependencies.writeThread))
        yield* dependencies.notifyThreadSummaries
        return
      case "pin":
        yield* repository
          .setPinned(Thread.ThreadId.make(input.threadId), true, now)
          .pipe(Effect.flatMap(dependencies.writeThread))
        yield* dependencies.notifyThreadSummaries
        return
      case "archive":
        yield* repository
          .setArchived(Thread.ThreadId.make(input.threadId), true, now)
          .pipe(Effect.flatMap(dependencies.writeThread))
        yield* dependencies.notifyThreadSummaries
        return
      case "unarchive":
        yield* repository
          .setArchived(Thread.ThreadId.make(input.threadId), false, now)
          .pipe(Effect.flatMap(dependencies.writeThread))
        yield* dependencies.notifyThreadSummaries
        return
      case "delete":
        yield* dependencies.deleteThread(Thread.ThreadId.make(input.threadId))
        yield* dependencies.notifyThreadSummaries
        return
      case "export": {
        const thread = yield* dependencies.requireThread(repository, input.threadId)
        const threadTurns = yield* turns.list(thread.id)
        yield* Console.log(
          input.format === "json"
            ? dependencies.encodeJson({ thread, turns: threadTurns })
            : dependencies.markdownExport(thread, threadTurns),
        )
        return
      }
      case "usage": {
        const thread = yield* dependencies.requireThread(repository, input.threadId)
        const threadTurns = yield* turns.list(thread.id)
        const usageSummary = yield* TranscriptRepository.Service.pipe(
          Effect.flatMap((transcripts) => transcripts.usage(thread.id)),
        )
        const usage = usageSummary.usage
        const statusNames: ReadonlyArray<ExecutionStatus.Status> = [
          "accepted",
          "queued",
          "running",
          "waiting",
          "completed",
          "failed",
          "cancelled",
        ]
        const statuses = Object.fromEntries(
          statusNames.map((status) => [status, threadTurns.filter((turn) => turn.status === status).length]),
        )
        let contextUsage = null
        if (usage.context !== undefined)
          contextUsage =
            usageSummary.contextCapacity === undefined
              ? { inputTokens: usage.context.inputTokens, pending: usage.contextPending }
              : {
                  inputTokens: usage.context.inputTokens,
                  ...usageSummary.contextCapacity,
                  pending: usage.contextPending,
                }
        yield* Console.log(
          dependencies.encodeJson({
            threadId: thread.id,
            turns: threadTurns.length,
            statuses,
            costUsd: usage.costNanoUsd === undefined ? null : usage.costNanoUsd / 1_000_000_000,
            tokens: usage.tokens ?? null,
            activeMillis: usage.active._tag === "Available" ? usage.active.accumulatedMillis : null,
            context: contextUsage,
            attempts: {
              priced: usage.pricedAttempts,
              unpriced: usage.unpricedAttempts,
              included: usage.includedAttempts ?? 0,
              counted: usage.countedAttempts,
              uncounted: usage.uncountedAttempts,
            },
            sourceComplete: usage.sourceComplete,
            projectionVersion: ExecutionProjection.projectionVersion,
          }),
        )
        return
      }
      case "fork": {
        return yield* dependencies.turnMutationAdmission.withPermits(1)(
          Effect.gen(function* () {
            const source = yield* dependencies.requireThread(repository, input.threadId)
            const sourceTurns = yield* turns.list(source.id)
            const boundary =
              input.atTurn === undefined
                ? sourceTurns.length - 1
                : sourceTurns.findIndex((turn) => turn.id === input.atTurn)
            if (boundary < 0 && input.atTurn !== undefined)
              return yield* operationError(`Turn ${input.atTurn} does not exist in thread ${input.threadId}`)
            const copiedSourceTurns = sourceTurns.slice(0, boundary + 1)
            const runningShell = copiedSourceTurns.find(ThreadResult.TurnResult.isRunningRecordedShell)
            if (runningShell !== undefined)
              return yield* operationError(
                `Cannot fork thread ${input.threadId} while recorded shell turn ${runningShell.id} is running`,
              )
            const forkId = yield* dependencies.makeThreadId
            const queuedCopies = copiedSourceTurns.filter((turn) => turn.status === "queued").length
            if (queuedCopies > dependencies.pendingTurnCapacity)
              return yield* TurnRepository.QueueFull.make({
                threadId: forkId,
                capacity: dependencies.pendingTurnCapacity,
                count: queuedCopies,
              })
            let forkCreated = false
            return yield* Effect.gen(function* () {
              const fork = yield* repository.create({
                id: forkId,
                workspace: source.workspace,
                title: source.title,
                now,
              })
              forkCreated = true
              yield* repository.setArchived(fork.id, true, now)
              if (source.labels.length > 0) yield* repository.label(fork.id, source.labels, now)
              const summaries = yield* ThreadSummaryRepository.Service
              const transcripts = yield* TranscriptRepository.Service
              for (const sourceTurn of copiedSourceTurns) {
                const id = yield* dependencies.makeTurnId
                if (ThreadResult.TurnResult.isRecordedShell(sourceTurn)) {
                  if (!ThreadResult.TurnResult.isTerminalRecordedShell(sourceTurn))
                    return yield* operationError(`Cannot fork running recorded shell turn ${sourceTurn.id}`)
                  const copied = yield* turns.copyRecordedShell({ ...sourceTurn, id, threadId: fork.id })
                  yield* transcripts.replaceUnits(
                    copied,
                    settleRecordedShellProjection(
                      recordedShellProjection({ id: copied.id, command: copied.command, status: "running" }),
                      copied,
                    ).units,
                  )
                  yield* summaries.ensureTurn(copied.id, copied.threadId, copied.updatedAt)
                  continue
                }
                const copied = yield* turns.copy(
                  { ...sourceTurn, id, threadId: fork.id },
                  dependencies.pendingTurnCapacity,
                )
                yield* summaries.ensureTurn(copied.id, copied.threadId, copied.updatedAt)
              }
              const published = yield* repository.setArchived(fork.id, false, now)
              yield* dependencies.notifyThreadSummaries
              yield* dependencies.writeThread(published)
            }).pipe(
              Effect.onError(() =>
                forkCreated
                  ? repository.discard(forkId).pipe(
                      Effect.catch((error) =>
                        Effect.logError("thread.fork.cleanup.failed").pipe(
                          Effect.annotateLogs({
                            "rika.thread.id": String(forkId),
                            "rika.failure.kind": String(error),
                          }),
                        ),
                      ),
                    )
                  : Effect.void,
              ),
            )
          }),
        )
      }
    }
  })
  yield* program.pipe(Effect.mapError((error) => dependencies.unavailable(input, String(error))))
})
