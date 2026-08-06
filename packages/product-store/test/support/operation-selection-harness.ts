import type { InteractiveSession } from "@rika/product/interactive-session"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as TurnContract from "@rika/product/turn-repository"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as Turn from "@rika/product/turn-record"
import { Service } from "@rika/product/product-operation-service"

import { Deferred, Effect, Layer, Ref, Stream } from "effect"
import { productLayer } from "./operation-layer-harness"
import { backend } from "./operation-execution-fixtures"
import { selectionThread } from "./operation-selection-fixtures"
import { holdSession } from "./operation-session-harness"

export const makeSelectionLoadHarness = Effect.fn("OperationTest.makeSelectionLoadHarness")(function* (
  eventCount: number,
  deferredUsage: boolean = false,
) {
  const previous = selectionThread("selection-previous")
  const target = selectionThread("selection-target")
  const repository = yield* ThreadRepository.makeMemory([previous, target])
  const turns = yield* TurnRepository.makeMemory()
  const targetGetEntered = yield* Deferred.make<void>()
  const releaseTargetGet = yield* Deferred.make<void>()
  const liveEventsEmitted = yield* Deferred.make<void>()
  const usageRequested = yield* Deferred.make<void>()
  const releaseExecution = yield* Deferred.make<void>()
  const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
  let targetGetBlocked = false
  let targetGetFailed = false
  let targetPageBlocked = false
  let targetPageFailed = false
  const delayedRepository = ThreadRepository.Service.of({
    ...repository,
    get: (id) => {
      if (targetGetFailed && id === target.id)
        return Effect.fail(ThreadRepository.RepositoryError.make({ message: "forced thread lookup failure" }))
      if (targetGetBlocked && id === target.id)
        return Deferred.succeed(targetGetEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseTargetGet)),
          Effect.andThen(repository.get(id)),
        )
      return repository.get(id)
    },
  })
  const streamed: ReadonlyArray<ExecutionEvent.Event> = Array.from({ length: eventCount }, (_, index) => ({
    executionId: "selection-live-run",
    cursor: `selection-live-${index + 1}`,
    sequence: index + 1,
    type: "model.output.delta",
    createdAt: index + 1,
    text: String(index + 1),
  }))
  const usage: ExecutionEvent.Event = {
    executionId: "selection-live-run",
    cursor: "selection-live-usage",
    sequence: eventCount + 1,
    type: "model.attempt.completed",
    createdAt: eventCount + 1,
    data: {
      provider: "openai",
      model: "gpt-5.6-sol",
      input_tokens: 100,
      input_tokens_uncached: 100,
      input_tokens_cache_read: 0,
      input_tokens_cache_write: 0,
      output_tokens: 10,
    },
  }
  const completed: ExecutionEvent.Event = {
    executionId: "selection-live-run",
    cursor: "selection-live-completed",
    sequence: eventCount + (deferredUsage ? 2 : 1),
    type: "execution.completed",
    timestampSource: "baton",
    createdAt: eventCount + (deferredUsage ? 2 : 1),
  }
  const started: ExecutionEvent.Event = {
    executionId: "selection-live-run",
    cursor: "selection-live-started",
    sequence: 0,
    type: "execution.started",
    timestampSource: "baton",
    createdAt: 0,
  }
  const targetPageEntered = yield* Deferred.make<void>()
  const releaseTargetPage = yield* Deferred.make<void>()
  const selectionTurns = TurnRepository.Service.of({
    ...turns,
    page: (threadId, options) => {
      if (targetPageFailed && threadId === target.id)
        return Effect.fail(TurnContract.RepositoryError.make({ message: "forced Turn page failure" }))
      if (targetPageBlocked && threadId === target.id)
        return Deferred.succeed(targetPageEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseTargetPage)),
          Effect.andThen(turns.page(threadId, options)),
        )
      return turns.page(threadId, options)
    },
  })
  const selectionBackend = ExecutionGateway.Service.of({
    ...backend,
    startTurn: (input) =>
      Effect.succeed({ runId: "selection-live-run", turnId: input.turnId, threadId: input.threadId }),
    watchTurn: () =>
      Stream.fromIterable([started, ...streamed]).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(liveEventsEmitted, undefined)).pipe(Stream.drain)),
        Stream.concat(
          deferredUsage ? Stream.fromEffect(Deferred.await(usageRequested)).pipe(Stream.drain) : Stream.empty,
        ),
        Stream.concat(deferredUsage ? Stream.succeed(usage) : Stream.empty),
        Stream.concat(Stream.fromEffect(Deferred.await(releaseExecution)).pipe(Stream.drain)),
        Stream.concat(Stream.succeed(completed)),
      ),
    inspectTurn: () => Effect.succeed({ status: "running" }),
  })
  const transcripts = yield* TranscriptRepository.makeMemory({ turns: selectionTurns })
  const layer: Layer.Layer<Service, Error, never> = productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, delayedRepository),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, selectionTurns),
    transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
    backendLayer: Layer.succeed(ExecutionGateway.Service, selectionBackend),
    defaultWorkspace: "/work",
    makeThreadId: Effect.die("unused"),
    makeTurnId: Effect.succeed(Turn.TurnId.make("selection-live-turn")),
    interactive: holdSession(sessions),
  })
  return {
    previous,
    target,
    turns,
    sessions,
    layer,
    targetGetEntered,
    targetPageEntered,
    liveEventsEmitted,
    releaseExecution: Deferred.succeed(releaseExecution, undefined),
    releaseUsage: Deferred.succeed(usageRequested, undefined),
    beginTargetGet: Effect.sync(() => {
      targetGetBlocked = true
    }),
    failTargetGet: Effect.sync(() => {
      targetGetFailed = true
    }),
    beginTargetPage: Effect.sync(() => {
      targetPageBlocked = true
    }),
    failTargetPage: Effect.sync(() => {
      targetPageFailed = true
    }),
    releaseTargetGet: Effect.sync(() => {
      targetGetBlocked = false
    }).pipe(Effect.andThen(Deferred.succeed(releaseTargetGet, undefined))),
    releaseTargetPage: Effect.sync(() => {
      targetPageBlocked = false
    }).pipe(Effect.andThen(Deferred.succeed(releaseTargetPage, undefined))),
  }
})
