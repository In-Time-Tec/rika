import { Service } from "@rika/product/product-operation-service"
import type { InteractiveSession } from "@rika/product/interactive-session"
import { productLayer } from "@rika/product/product-operation-service"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as TurnContract from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as UsageRepository from "@rika/product-store/sqlite-usage-repository"
import * as SummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import { Deferred, Effect, Layer } from "effect"
import { storeProjection } from "../support/product-test-transcript-fixture"

export { storeProjection }

export const baseBackend = ExecutionBackend.Service.of({
  invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
  createFanOut: () => Effect.die("unused"),
  inspectFanOut: () => Effect.die("unused"),
  cancelFanOut: () => Effect.die("unused"),
  registerWorkflows: () => Effect.die("unused"),
  startWorkflow: () => Effect.die("unused"),
  inspectWorkflow: () => Effect.die("unused"),
  cancelWorkflow: () => Effect.die("unused"),
  start: (input) => Effect.succeed({ turnId: input.turnId, status: "completed", events: [] }),
  replay: (turnId) => Effect.succeed({ turnId, status: "completed", events: [] }),
  cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
  inspect: () => Effect.void.pipe(Effect.as(undefined)),
  steer: (turnId) => Effect.succeed({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
  resolveInvocationSource: () => Effect.die("unused"),
})

export const thread = (id: string): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: "/work",
  title: id,
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
})

export const providerCostEvent = (
  executionId: string,
  cursor: string,
  amount: number,
  sequence = 0,
): ExecutionEvent.Event => ({
  executionId,
  cursor,
  sequence,
  type: "model.attempt.completed",
  createdAt: 1,
  data: { model_attempt_id: `${cursor}-attempt`, cost: { amount, currency: "USD" } },
})

export const interactiveLayer: (
  repository: ThreadRepository.Interface,
  turns: TurnContract.Interface,
  backend: ExecutionBackend.Interface,
  registration: Deferred.Deferred<InteractiveSession>,
  makeThreadId?: Effect.Effect<Thread.ThreadId>,
  makeTurnId?: Effect.Effect<Turn.TurnId>,
  transcripts?: TranscriptRepository.Interface,
  usage?: UsageRepository.Interface,
) => Layer.Layer<Service, object, never> = (
  repository,
  turns,
  backend,
  registration,
  makeThreadId = Effect.die("unused"),
  makeTurnId = Effect.die("unused"),
  transcripts,
  usage,
) =>
  productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    threadSummaryRepositoryLayer: SummaryRepository.memoryLayer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(ThreadRepository.Service, repository), Layer.succeed(TurnRepository.Service, turns)),
      ),
    ),
    transcriptRepositoryLayer:
      transcripts === undefined
        ? TranscriptRepository.memoryLayerWithTurns.pipe(Layer.provide(Layer.succeed(TurnRepository.Service, turns)))
        : Layer.succeed(TranscriptRepository.Service, transcripts),
    usageRepositoryLayer:
      usage === undefined ? UsageRepository.memoryLayer : Layer.succeed(UsageRepository.Service, usage),
    backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
    defaultWorkspace: "/work",
    makeThreadId,
    makeTurnId,
    interactive: (_, session) => Deferred.succeed(registration, session).pipe(Effect.andThen(Effect.never)),
  })

export const awaitCondition = (condition: Effect.Effect<boolean>, attempts = 50_000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (yield* condition) return true
      yield* Effect.yieldNow
    }
    return false
  })

export const settle = (attempts = 500) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) yield* Effect.yieldNow
  })
