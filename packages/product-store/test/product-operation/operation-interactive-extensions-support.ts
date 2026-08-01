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

function providerCostEventImplementation(
  cursor: string,
  amount: number,
  sequence?: number,
): (executionId: string) => ExecutionEvent.Event
function providerCostEventImplementation(
  executionId: string,
  cursor: string,
  amount: number,
  sequence?: number,
): ExecutionEvent.Event
function providerCostEventImplementation(
  executionIdOrCursor: string,
  cursorOrAmount: string | number,
  amountOrSequence?: number,
  sequence?: number,
): ExecutionEvent.Event | ((executionId: string) => ExecutionEvent.Event) {
  if (typeof cursorOrAmount === "number")
    return (executionId) =>
      providerCostEventImplementation(executionId, executionIdOrCursor, cursorOrAmount, amountOrSequence)
  if (amountOrSequence === undefined) throw new Error("Invalid provider cost event arguments")
  return {
    executionId: executionIdOrCursor,
    cursor: cursorOrAmount,
    sequence: sequence ?? 0,
    type: "model.attempt.completed",
    createdAt: 1,
    data: { model_attempt_id: `${cursorOrAmount}-attempt`, cost: { amount: amountOrSequence, currency: "USD" } },
  }
}

type ProviderCostEvent = {
  (executionId: string, cursor: string, amount: number, sequence?: number): ExecutionEvent.Event
  (cursor: string, amount: number, sequence?: number): (executionId: string) => ExecutionEvent.Event
}

export const providerCostEvent: ProviderCostEvent = providerCostEventImplementation

const interactiveLayerImplementation: (
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

function interactiveLayerImplementation2(
  repository: ThreadRepository.Interface,
  turns: TurnContract.Interface,
  backend: ExecutionBackend.Interface,
  registration: Deferred.Deferred<InteractiveSession>,
  makeThreadId?: Effect.Effect<Thread.ThreadId>,
  makeTurnId?: Effect.Effect<Turn.TurnId>,
  transcripts?: TranscriptRepository.Interface,
  usage?: UsageRepository.Interface,
): ReturnType<typeof interactiveLayerImplementation>
function interactiveLayerImplementation2(
  turns: TurnContract.Interface,
  backend: ExecutionBackend.Interface,
  registration: Deferred.Deferred<InteractiveSession>,
): (repository: ThreadRepository.Interface) => ReturnType<typeof interactiveLayerImplementation>
function interactiveLayerImplementation2(
  repositoryOrTurns: ThreadRepository.Interface | TurnContract.Interface,
  turnsOrBackend: TurnContract.Interface | ExecutionBackend.Interface,
  backendOrRegistration: ExecutionBackend.Interface | Deferred.Deferred<InteractiveSession>,
  registrationOrThreadId?: Deferred.Deferred<InteractiveSession> | Effect.Effect<Thread.ThreadId>,
  makeThreadIdOrTurnId?: Effect.Effect<Thread.ThreadId>,
  makeTurnIdOrTranscripts?: Effect.Effect<Turn.TurnId>,
  transcriptsOrUsage?: TranscriptRepository.Interface | UsageRepository.Interface,
  usage?: UsageRepository.Interface,
):
  | ReturnType<typeof interactiveLayerImplementation>
  | ((repository: ThreadRepository.Interface) => ReturnType<typeof interactiveLayerImplementation>) {
  if ("createForSubmission" in repositoryOrTurns) {
    if (!("invokeChild" in turnsOrBackend) || !Deferred.isDeferred<InteractiveSession, never>(backendOrRegistration))
      throw new Error("Invalid interactive layer arguments")
    return (repository) =>
      interactiveLayerImplementation(repository, repositoryOrTurns, turnsOrBackend, backendOrRegistration)
  }
  if (
    !("createForSubmission" in turnsOrBackend) ||
    !("invokeChild" in backendOrRegistration) ||
    registrationOrThreadId === undefined ||
    !Deferred.isDeferred<InteractiveSession, never>(registrationOrThreadId)
  )
    throw new Error("Invalid interactive layer arguments")
  return interactiveLayerImplementation(
    repositoryOrTurns,
    turnsOrBackend,
    backendOrRegistration,
    registrationOrThreadId,
    makeThreadIdOrTurnId,
    makeTurnIdOrTranscripts,
    transcriptsOrUsage === undefined || !("get" in transcriptsOrUsage) ? undefined : transcriptsOrUsage,
    usage,
  )
}

type InteractiveLayer = {
  (
    repository: ThreadRepository.Interface,
    turns: TurnContract.Interface,
    backend: ExecutionBackend.Interface,
    registration: Deferred.Deferred<InteractiveSession>,
    makeThreadId?: Effect.Effect<Thread.ThreadId>,
    makeTurnId?: Effect.Effect<Turn.TurnId>,
    transcripts?: TranscriptRepository.Interface,
    usage?: UsageRepository.Interface,
  ): ReturnType<typeof interactiveLayerImplementation>
  (
    turns: TurnContract.Interface,
    backend: ExecutionBackend.Interface,
    registration: Deferred.Deferred<InteractiveSession>,
  ): (repository: ThreadRepository.Interface) => ReturnType<typeof interactiveLayerImplementation>
}

export const interactiveLayer: InteractiveLayer = interactiveLayerImplementation2

function awaitConditionImplementation(condition: Effect.Effect<boolean>, attempts?: number): Effect.Effect<boolean>
function awaitConditionImplementation(attempts?: number): (condition: Effect.Effect<boolean>) => Effect.Effect<boolean>
function awaitConditionImplementation(
  conditionOrAttempts?: Effect.Effect<boolean> | number,
  attempts?: number,
): Effect.Effect<boolean> | ((condition: Effect.Effect<boolean>) => Effect.Effect<boolean>) {
  if (conditionOrAttempts === undefined) return (condition) => awaitConditionImplementation(condition, 50_000)
  if (typeof conditionOrAttempts === "number")
    return (condition) => awaitConditionImplementation(condition, conditionOrAttempts)
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < (attempts ?? 50_000); attempt += 1) {
      if (yield* conditionOrAttempts) return true
      yield* Effect.yieldNow
    }
    return false
  })
}

type AwaitCondition = {
  (condition: Effect.Effect<boolean>, attempts?: number): Effect.Effect<boolean>
  (attempts?: number): (condition: Effect.Effect<boolean>) => Effect.Effect<boolean>
}

export const awaitCondition: AwaitCondition = awaitConditionImplementation

export const settle = (attempts = 500) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) yield* Effect.yieldNow
  })
