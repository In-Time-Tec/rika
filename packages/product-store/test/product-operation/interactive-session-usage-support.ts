import type { InteractiveSession } from "@rika/product/interactive-session"
import { Service } from "@rika/product/product-operation-service"
import { Context, Deferred, Effect, Layer, Ref, Result, Schema, Scope } from "effect"
import * as TranscriptRepositoryContract from "@rika/product/transcript-repository"
import * as TurnContract from "@rika/product/turn-repository"
import * as UsageRepositoryContract from "@rika/product/usage-repository"
import { makeMemory } from "../../src/usage/memory-usage-repository"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { Fixtures as TranscriptFixtures } from "./interactive-session-transcript-support"
import { thread, waitForSessions, productLayer } from "./interactive-session-base-support"
import { executionRoute } from "../support/product-test-current-state"
import { invalidatedProjection } from "../support/product-test-transcript-fixture"

export const spendThread = thread("spend-thread", 1)
export const spendTurnId = RuntimeFixtures.Turn.TurnId.make("spend-turn")
const spendExecutionId = String(spendTurnId)

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
  timestampSource: "server",
  ...fields,
})

const spendEvents: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> = [
  stamped("spend-started", "execution.started", 10_000, 1),
  stamped("spend-context", "model.usage.reported", 15_000, 2, {
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
  stamped("spend-usage", "model.attempt.completed", 20_000, 3, {
    data: {
      model_call_id: "spend-call",
      model_attempt_id: "spend-attempt",
      attempt: 1,
      cost: { amount: 0.75, currency: "USD" },
    },
  }),
  stamped("spend-answer", "model.output.completed", 30_000, 4, { text: "spent" }),
]

const spendCompleted = stamped("spend-completed", "execution.completed", 40_000, 5)

const spendTimeline: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> = [...spendEvents, spendCompleted]

const legacyUsageRow = () => {
  const folded = TranscriptFixtures.UsageCost.foldBatch(
    TranscriptFixtures.UsageCost.empty,
    spendTimeline.map((event) => ({
      threadId: String(spendThread.id),
      turnId: String(spendTurnId),
      event,
    })),
    new Set([spendExecutionId]),
  )
  if (Result.isFailure(folded)) throw folded.failure
  const snapshot = folded.success
  const totals = TranscriptFixtures.UsageCost.materialize(snapshot, String(spendTurnId), String(spendThread.id))
  return {
    foldJson: JSON.stringify({
      ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
        JSON.parse(TranscriptFixtures.UsageCost.serialize(snapshot)),
      ),
      version: TranscriptFixtures.UsageCost.foldVersion - 1,
    }),
    totals: {
      ...(totals.costNanoUsd === undefined ? {} : { costNanoUsd: totals.costNanoUsd }),
      ...(totals.tokens === undefined ? {} : { tokens: totals.tokens }),
      pricedAttempts: totals.pricedAttempts,
      unpricedAttempts: totals.unpricedAttempts,
      countedAttempts: totals.countedAttempts,
      uncountedAttempts: totals.uncountedAttempts,
      sourceComplete: false,
    },
  }
}

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
  readonly legacy?: boolean
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
      stopIntent: "none",
      createdAt: 1,
      updatedAt: 1,
      ...(options.turnStatus === undefined ? {} : { lastCursor: "spend-completed" }),
    }
    const repositories = yield* RuntimeFixtures.ThreadRepository.makeMemory([spendThread])
    const turns = yield* RuntimeFixtures.TurnRepository.makeMemory([spendTurn])
    const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
    const transcripts =
      options.legacy === true
        ? yield* RuntimeFixtures.TranscriptRepository.makeMemory({
            initial: [
              invalidatedProjection(
                spendTurn,
                TranscriptFixtures.TranscriptProjection.Projection.project(
                  String(spendTurnId),
                  spendTurn.prompt,
                  spendTimeline,
                ).revision,
              ),
            ],
            turns,
          })
        : yield* RuntimeFixtures.TranscriptRepository.makeMemory({ turns })
    const follows = yield* Ref.make(0)
    const blocked = yield* Ref.make(0)
    const legacy = options.legacy === true ? legacyUsageRow() : undefined
    const usage = yield* makeMemory({
      initial:
        legacy === undefined
          ? []
          : [
              {
                sourceId: String(spendTurnId),
                turnId: String(spendTurnId),
                threadId: String(spendThread.id),
                revision: 1,
                projectionVersion: RuntimeFixtures.UsageRepository.projectionVersion - 1,
                foldJson: legacy.foldJson,
                ...legacy.totals,
              },
            ],
    })
    const terminal = {
      turnId: String(spendTurnId),
      status: "completed" as const,
      waits: [],
      pendingTools: [],
      children: [],
    }
    const backend = RuntimeFixtures.ExecutionBackend.Service.of({
      invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
      createFanOut: () => Effect.die("unused"),
      inspectFanOut: () => Effect.die("unused"),
      cancelFanOut: () => Effect.die("unused"),
      registerWorkflows: () => Effect.die("unused"),
      startWorkflow: () => Effect.die("unused"),
      inspectWorkflow: () => Effect.die("unused"),
      cancelWorkflow: () => Effect.die("unused"),
      start: () => Effect.die("unused"),
      inspect: (turnId) => {
        if (String(turnId) !== String(spendTurnId)) return Effect.void.pipe(Effect.as(undefined))
        if (options.turnStatus === undefined) {
          return Effect.succeed({ ...terminal, status: "running" as const, lastCursor: "spend-answer" })
        }
        return Effect.succeed({ ...terminal, lastCursor: "spend-completed" })
      },
      follow: (turnId, cursor, onEvent) =>
        options.legacy === true
          ? Ref.update(follows, (count) => count + 1).pipe(
              Effect.andThen(options.gate === undefined ? Effect.void : Deferred.await(options.gate)),
              Effect.andThen(
                Effect.sync(() => {
                  const after = typeof cursor === "string" ? cursor : cursor?.cursor
                  const boundary =
                    after === undefined ? -1 : spendTimeline.findIndex((candidate) => candidate.cursor === after)
                  const pending = spendTimeline.slice(boundary + 1)
                  for (const event of pending) onEvent?.(event)
                  return { turnId: String(turnId), status: "completed" as const, events: pending }
                }),
              ),
            )
          : Ref.update(blocked, (count) => count + 1).pipe(
              Effect.andThen(options.gate === undefined ? Effect.void : Deferred.await(options.gate)),
              Effect.andThen(Ref.updateAndGet(follows, (count) => count + 1)),
              Effect.tap((count) =>
                Effect.sync(() => {
                  for (const event of count === 1 ? spendEvents : spendTimeline) onEvent?.(event)
                }),
              ),
              Effect.map((count) => ({
                turnId: String(turnId),
                status: count === 1 ? ("running" as const) : ("completed" as const),
                events: count === 1 ? spendEvents : spendTimeline,
              })),
            ),
      steer: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      replay: (turnId) =>
        Ref.update(blocked, (count) => count + 1).pipe(
          Effect.andThen(options.gate === undefined ? Effect.void : Deferred.await(options.gate)),
          Effect.as({ turnId: String(turnId), status: "completed" as const, events: spendTimeline }),
        ),
      pageEvents: (turnId, _direction, cursor) =>
        Ref.update(blocked, (count) => count + 1).pipe(
          Effect.andThen(options.gate === undefined ? Effect.void : Deferred.await(options.gate)),
          Effect.as({
            events: cursor === undefined ? spendTimeline : [],
            hasMore: false,
            newestCursor: "spend-completed",
            turnId: String(turnId),
          }),
        ),
      resolveInvocationSource: () => Effect.die("unused"),
    })
    const layer = productLayer({
      repositoryLayer: Layer.succeed(RuntimeFixtures.ThreadRepository.Service, repositories),
      turnRepositoryLayer: Layer.succeed(RuntimeFixtures.TurnRepository.Service, turns),
      transcriptRepositoryLayer: Layer.succeed(RuntimeFixtures.TranscriptRepository.Service, transcripts),
      usageRepositoryLayer: Layer.succeed(RuntimeFixtures.UsageRepository.Service, usage),
      backendLayer: Layer.succeed(RuntimeFixtures.ExecutionBackend.Service, backend),
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
