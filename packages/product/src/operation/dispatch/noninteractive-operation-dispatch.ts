import * as Thread from "../../thread/model/thread-record"
import * as ThreadRepository from "../../thread/repository/thread-repository"
import * as ThreadResult from "@rika/product/thread-result"
import * as TurnRepository from "../../thread/repository/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import { clampThreadTitle } from "../../thread/query/thread-title-policy"
import { reviewRouteMode } from "../review/review-policy"
import { Clock, Console, Effect } from "effect"
import { turnFailure } from "../failure-message"
import { compareUnitOrder } from "@rika/transcript/transcript-unit-order"
import type { Dependencies, NoninteractiveInput } from "./noninteractive-operation-contract"

// The server-scope execution coordinator owns the run's watch, retries, and queue drain. This
// path admits the turn, notifies the coordinator, and awaits the durable settlement of the whole
// retry lineage before reporting the transcript the coordinator committed.

export const run = Effect.fn("NoninteractiveOperation.run")(function* (
  input: NoninteractiveInput,
  dependencies: Dependencies,
) {
  const program = Effect.gen(function* () {
    const threads = yield* ThreadRepository.Service
    const turns = yield* TurnRepository.Service
    const now = yield* Clock.currentTimeMillis
    const thread =
      input.threadId === undefined
        ? yield* threads.create({
            id: yield* dependencies.makeThreadId,
            workspace: input.workspace ?? dependencies.defaultWorkspace,
            title: clampThreadTitle(input.prompt.join(" ")) || "New thread",
            now,
          })
        : yield* threads
            .get(Thread.ThreadId.make(input.threadId))
            .pipe(
              Effect.flatMap((existingThread) =>
                existingThread === undefined
                  ? dependencies.operationError(`Thread ${input.threadId} does not exist`)
                  : Effect.succeed(existingThread),
              ),
            )
    const turnId = yield* dependencies.makeTurnId
    const prompt = input.prompt.join(" ")
    const resolvedExecutionRoute = yield* dependencies.resolveExecutionRoute(
      input.mode ?? "medium",
      undefined,
      thread.workspace,
    )
    const observed = yield* dependencies.createObservedSubmission(turns, {
      id: turnId,
      threadId: thread.id,
      prompt,
      executionRoute:
        input._tag === "Review"
          ? { ...resolvedExecutionRoute, mode: reviewRouteMode(resolvedExecutionRoute.mode) }
          : resolvedExecutionRoute,
      queueCapacity: dependencies.pendingTurnCapacity,
      now,
    })
    const submitted = observed.turn
    yield* dependencies.ensureTurnSummary(submitted)
    yield* Effect.logInfo("turn.accepted").pipe(
      Effect.annotateLogs({
        "rika.thread.id": String(thread.id),
        "rika.turn.id": String(submitted.id),
        "rika.turn.status": submitted.status,
      }),
    )
    if (submitted.status === "queued") return
    if (!ThreadResult.TurnResult.isAgentExecution(submitted))
      return yield* dependencies.operationError(`Turn ${submitted.id} is not an executable turn`)
    const ingest = dependencies.ingest
    const settledOutcome = yield* ingest.awaitSettled(submitted.id)
    const finalTurnId = settledOutcome.finalTurnId
    if (input._tag === "Run" && input.streamJson)
      yield* Effect.forEach(settledOutcome.changes, (change) => Console.log(JSON.stringify(change)), {
        discard: true,
      })
    const settled = yield* turns.get(finalTurnId)
    if (settled === undefined) return
    const transcripts = yield* TranscriptRepository.Service
    const projection = yield* transcripts.get(finalTurnId)
    const ordered = (projection?.units ?? []).toSorted((left, right) => compareUnitOrder(left.order, right.order))
    const text = ordered
      .filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")
      .map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))
      .join("")
    if (text.length > 0) yield* Console.log(text)
    if (settled.status === "cancelled")
      return yield* dependencies.operationError(`Turn ${finalTurnId} was cancelled before it completed`)
    if (settled.status === "failed") {
      const failure = turnFailure(ordered)
      return yield* dependencies.operationError(
        settledOutcome.failure ??
          (failure === undefined ? `Turn ${finalTurnId} failed` : `Turn ${finalTurnId} failed: ${failure.message}`),
      )
    }
    if (settled.status === "completed" && text.length === 0)
      return yield* dependencies.operationError(`Turn ${finalTurnId} completed without output`)
  })
  yield* program.pipe(
    Effect.provide(dependencies.executionDependencies),
    Effect.scoped,
    Effect.mapError((error) => dependencies.unavailable(input, String(error))),
  )
})
