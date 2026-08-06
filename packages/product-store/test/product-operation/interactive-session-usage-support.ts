import type { InteractiveSession } from "@rika/product/interactive-session"
import { Service } from "@rika/product/product-operation-service"
import { Context, Deferred, Effect, Layer, Ref, Scope, Stream } from "effect"
import * as TranscriptRepositoryContract from "@rika/product/transcript-repository"
import * as TurnContract from "@rika/product/turn-repository"
import * as UsageRepositoryContract from "@rika/product/usage-repository"
import { makeMemory } from "../../src/usage/memory-usage-repository"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { thread, waitForSessions, productLayer } from "./interactive-session-base-support"
import { executionRoute } from "../support/product-test-current-state"

export const spendThread = thread("spend-thread", 1)
export const spendTurnId = RuntimeFixtures.Turn.TurnId.make("spend-turn")
const spendExecutionId = `${spendTurnId}-run`

const stamped = (
  cursor: string,
  type: RuntimeFixtures.ExecutionEvent.Event["type"],
  createdAt: number,
  sequence: number,
  fields: Partial<
    Pick<RuntimeFixtures.ExecutionEvent.Event, "childExecutionId" | "timestampSource" | "text" | "content" | "data">
  > = {},
): RuntimeFixtures.ExecutionEvent.Event => ({
  executionId: spendExecutionId,
  cursor,
  sequence,
  type,
  createdAt,
  timestampSource: "baton",
  ...fields,
})

const spendEvents: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> = [
  stamped("spend-started", "execution.started", 10_000, 0),
  stamped("spend-context", "model.attempt.completed", 15_000, 1, {
    data: {
      model_call_id: "spend-call",
      model_attempt_id: "spend-attempt",
      attempt: 1,
      provider: "openai",
      model: "gpt-5.6-sol",
      input_tokens: 50,
      input_tokens_uncached: 50,
      input_tokens_cache_read: 0,
      input_tokens_cache_write: 0,
      output_tokens: 10,
    },
  }),
  stamped("spend-usage", "model.attempt.completed", 20_000, 2, {
    data: {
      model_call_id: "spend-call",
      model_attempt_id: "spend-attempt",
      attempt: 1,
      cost: { amount: 0.75, currency: "USD" },
    },
  }),
  stamped("spend-answer", "model.output.completed", 30_000, 3, { text: "spent" }),
]

const spendCompleted = stamped("spend-completed", "execution.completed", 40_000, 4)

const spendTimeline: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> = [...spendEvents, spendCompleted]

export interface SpendHarness {
  readonly session: InteractiveSession
  readonly usage: UsageRepositoryContract.Interface
  readonly turns: TurnContract.Interface
  readonly transcripts: TranscriptRepositoryContract.Interface
  readonly follows: Ref.Ref<number>
  readonly blocked: Ref.Ref<number>
}

type SpendHarnessOptions = {
  readonly gate?: Deferred.Deferred<void>
  readonly turnStatus?: RuntimeFixtures.ExecutionStatus.Status
}

export const makeSpendHarness: (options: SpendHarnessOptions) => Effect.Effect<SpendHarness, object, Scope.Scope> =
  Effect.fn("InteractiveSessionTest.makeSpendHarness")(function* (options) {
    const spendTurn: RuntimeFixtures.Turn.AgentExecutionTurn = {
      _tag: "AgentExecution",
      id: spendTurnId,
      threadId: spendThread.id,
      prompt: "spend prompt",
      author: { _tag: "Human" },
      lineage: { _tag: "Original" },
      executionRoute: executionRoute(),
      status: options.turnStatus ?? "running",
      createdAt: 1,
      updatedAt: 1,
      executionLink: { runId: spendExecutionId, turnId: String(spendTurnId), threadId: String(spendThread.id) },
    }
    const repositories = yield* RuntimeFixtures.ThreadRepository.makeMemory([spendThread])
    const turns = yield* RuntimeFixtures.TurnRepository.makeMemory([spendTurn])
    const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
    const transcripts = yield* RuntimeFixtures.TranscriptRepository.makeMemory({ turns })
    const follows = yield* Ref.make(0)
    const blocked = yield* Ref.make(0)
    const usage = yield* makeMemory()
    const backend = RuntimeFixtures.ExecutionGateway.Service.of({
      startTurn: () => Effect.die("unused"),
      inspectTurn: (link) => {
        if (link.runId !== spendExecutionId) return Effect.succeed({ status: "unavailable" })
        return Effect.succeed({ status: options.turnStatus === undefined ? "running" : "completed" })
      },
      watchTurn: (_link, _cursor) =>
        Stream.unwrap(
          Ref.update(blocked, (count) => count + 1).pipe(
            Effect.andThen(options.gate === undefined ? Effect.void : Deferred.await(options.gate)),
            Effect.andThen(Ref.updateAndGet(follows, (count) => count + 1)),
            Effect.map((count) => Stream.fromIterable(count === 1 ? spendEvents : spendTimeline)),
          ),
        ),
      steerTurn: () => Effect.die("unused"),
      cancelTurn: () => Effect.die("unused"),
    })
    const layer = productLayer({
      repositoryLayer: Layer.succeed(RuntimeFixtures.ThreadRepository.Service, repositories),
      turnRepositoryLayer: Layer.succeed(RuntimeFixtures.TurnRepository.Service, turns),
      transcriptRepositoryLayer: Layer.succeed(RuntimeFixtures.TranscriptRepository.Service, transcripts),
      usageRepositoryLayer: Layer.succeed(RuntimeFixtures.UsageRepository.Service, usage),
      backendLayer: Layer.succeed(RuntimeFixtures.ExecutionGateway.Service, backend),
      defaultWorkspace: "/work",
      makeThreadId: Effect.die("unused"),
      makeTurnId: Effect.die("unused"),
      interactive: (_, session) =>
        Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
    })
    const context = yield* Layer.build(layer)
    const operation = Context.get(context, Service)
    yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
    yield* waitForSessions(sessions)
    const session = (yield* Ref.get(sessions))[0]
    if (session === undefined) return yield* Effect.die("Missing interactive session")
    return { session, usage, turns, transcripts, follows, blocked }
  })
