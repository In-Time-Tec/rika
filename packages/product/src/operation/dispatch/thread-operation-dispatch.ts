import * as ExecutionBackend from "../../execution/contract/execution-service"
import * as UsageSnapshot from "@rika/product/usage-snapshot"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import * as Thread from "../../thread/model/thread-record"
import * as ThreadRepository from "../../thread/repository/thread-repository"
import * as ThreadSummaryRepository from "../../thread/repository/thread-summary-repository"
import * as TranscriptRepository from "../../thread/repository/transcript-repository"
import * as Turn from "../../thread/model/turn-record"
import * as TurnRepository from "../../thread/repository/turn-repository"
import * as UsageRepository from "../../thread/repository/usage-repository"
import * as ThreadActivity from "../../thread/query/thread-activity"
import { clampThreadTitle } from "../../thread/query/thread-title-policy"
import { Input } from "../contract/product-operation"
import { OperationUnavailable } from "../contract/product-operation-service"
import { operationError } from "../operation-error"
import { Clock, Context, Effect, Semaphore, Console } from "effect"

export interface Dependencies {
  readonly defaultWorkspace: string
  readonly pendingTurnCapacity: number
  readonly makeThreadId: Effect.Effect<Thread.ThreadId>
  readonly makeTurnId: Effect.Effect<Turn.TurnId>
  readonly turnMutationAdmission: Semaphore.Semaphore
  readonly backend: ExecutionBackend.Interface
  readonly usageRepository: UsageRepository.Interface
  readonly notifyThreadSummaries: Effect.Effect<void, unknown, ThreadSummaryRepository.Service>
  readonly writeThread: (thread: Thread.Thread) => Effect.Effect<void>
  readonly requireThread: (repository: ThreadRepository.Interface, id: string) => Effect.Effect<Thread.Thread, unknown>
  readonly markdownExport: (thread: Thread.Thread, turns: ReadonlyArray<Turn.Turn>) => string
  readonly encodeJson: (value: unknown) => string
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
        const threads = yield* repository.list({
          ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        yield* Console.log(dependencies.encodeJson(threads))
        return
      }
      case "search": {
        const candidates = yield* repository.list({
          ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
          limit: 100,
        })
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
          const backend = yield* ExecutionBackend.Service
          let selected: Thread.Thread | ReadonlyArray<Thread.Thread>
          if ("last" in input) {
            const thread = (yield* repository.list({ limit: 1 }))[0]
            if (thread === undefined) return yield* operationError("No threads exist")
            selected = thread
          } else {
            selected = yield* Effect.forEach(input.threadIds as ReadonlyArray<string>, (id) =>
              dependencies.requireThread(repository, id),
            )
          }
          const selectedThreads = Array.isArray(selected) ? selected : [selected]
          const continued = yield* Effect.forEach(selectedThreads, (thread) =>
            Effect.gen(function* () {
              const threadTurns = yield* turns.list(thread.id)
              const history = yield* Effect.forEach(threadTurns, (turn) =>
                backend
                  .replay(turn.id)
                  .pipe(Effect.map((result) => ({ turn, status: result.status, events: result.events }))),
              )
              return { ...thread, turns: history }
            }),
          )
          yield* Console.log(dependencies.encodeJson(Array.isArray(selected) ? continued : continued[0]))
        }).pipe(Effect.provide(Context.make(ExecutionBackend.Service, dependencies.backend)), Effect.scoped)
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
        yield* repository.remove(Thread.ThreadId.make(input.threadId))
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
        const usage = yield* dependencies.usageRepository.readThread(String(thread.id))
        const statusNames: ReadonlyArray<Turn.Status> = [
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
        yield* Console.log(
          dependencies.encodeJson({
            threadId: thread.id,
            turns: threadTurns.length,
            statuses,
            costUsd: usage.costNanoUsd === undefined ? null : usage.costNanoUsd / 1_000_000_000,
            tokens: usage.tokens ?? null,
            activeMillis: usage.activeMillis ?? null,
            attempts: {
              priced: usage.pricedAttempts,
              unpriced: usage.unpricedAttempts,
              counted: usage.countedAttempts,
              uncounted: usage.uncountedAttempts,
            },
            sourceComplete: usage.sourceComplete,
            projectionVersion: UsageSnapshot.projectionVersion,
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
            const runningShell = copiedSourceTurns.find(Turn.isRunningRecordedShell)
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
                if (Turn.isRecordedShell(sourceTurn)) {
                  if (!Turn.isTerminalRecordedShell(sourceTurn))
                    return yield* operationError(`Cannot fork running recorded shell turn ${sourceTurn.id}`)
                  const copied = yield* transcripts.copyRecordedShell(
                    { ...sourceTurn, id, threadId: fork.id },
                    ExecutionIngest.projectionVersion,
                  )
                  yield* summaries.ensureTurn(copied.turn.id, copied.turn.threadId, copied.turn.updatedAt)
                  continue
                }
                const copied = yield* turns.copy(
                  { ...sourceTurn, id, threadId: fork.id },
                  dependencies.pendingTurnCapacity,
                )
                const execution = yield* dependencies.backend.inspect(sourceTurn.id)
                if (execution === undefined) yield* summaries.ensureTurn(copied.id, copied.threadId, copied.updatedAt)
                else {
                  const replayed = yield* dependencies.backend.replay(sourceTurn.id)
                  yield* summaries.replaceTurn(
                    ThreadActivity.projectionInput(
                      fork.id,
                      { ...replayed, turnId: copied.id },
                      yield* Clock.currentTimeMillis,
                    ),
                  )
                }
              }
              const published = yield* repository.setArchived(fork.id, false, now)
              yield* dependencies.notifyThreadSummaries
              yield* dependencies.writeThread(published)
            }).pipe(
              Effect.onError(() =>
                forkCreated
                  ? repository.remove(forkId).pipe(
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
