import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionEvent from "@rika/product/execution-event"
import { Cause, Clock, Context, Effect, Function } from "effect"
import { clampThreadTitle } from "../../thread/query/thread-title-policy"
import type { InteractiveEvent } from "../interactive/interactive-event"
import type { InteractiveDependencyContext } from "../interactive/interactive-session-runtime"

type ApplyGeneratedTitleInput = {
  readonly turns: import("@rika/product/turn-repository").Interface
  readonly dependencyContext: InteractiveDependencyContext
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
  readonly fork: (effect: Effect.Effect<void, never, never>) => void
}

const applyGeneratedTitleImpl = (input: ApplyGeneratedTitleInput, turnId: Turn.TurnId, event: ExecutionEvent.Event) => {
  if (event.type !== "thread.title.generated") return
  const generated = event.data?.title
  if (typeof generated !== "string") return
  input.fork(
    Effect.gen(function* () {
      const turn = yield* input.turns.get(turnId)
      if (turn === undefined || turn._tag !== "AgentExecution") return
      const expected = clampThreadTitle(turn.prompt) || "New thread"
      const title = clampThreadTitle(generated)
      if (title.length === 0) return
      const threads = Context.get(input.dependencyContext, ThreadRepository.Service)
      const renamed = yield* threads.renameIfTitle(turn.threadId, expected, title, yield* Clock.currentTimeMillis)
      if (renamed === undefined) return
      input.publishInteractiveActivity(0, { _tag: "ThreadTitled", threadId: renamed.id, title: renamed.title })
      const summaries = Context.get(input.dependencyContext, ThreadSummaryRepository.Service)
      input.publishInteractiveActivity(0, { _tag: "ThreadsListed", threads: yield* summaries.list() })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("thread-title.projection.failed").pipe(
          Effect.annotateLogs({ "rika.turn.id": String(turnId), "rika.failure.cause": Cause.pretty(cause) }),
        ),
      ),
    ),
  )
}

export const applyGeneratedTitle: {
  (
    turnId: Turn.TurnId,
    event: ExecutionEvent.Event,
  ): (input: ApplyGeneratedTitleInput) => ReturnType<typeof applyGeneratedTitleImpl>
  (
    input: ApplyGeneratedTitleInput,
    turnId: Turn.TurnId,
    event: ExecutionEvent.Event,
  ): ReturnType<typeof applyGeneratedTitleImpl>
} = Function.dual(3, applyGeneratedTitleImpl)
