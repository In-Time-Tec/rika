import * as ExecutionProjection from "@rika/product/execution-projection"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { unitOrder } from "@rika/transcript/transcript-unit-order"

const encodeStartTurn = Schema.encodeSync(Schema.fromJsonString(ExecutionGateway.StartTurn))
import { make } from "../src/thread/queue/root-turn-owner"

const link = { runId: "root-run", threadId: "thread", turnId: "turn" }

const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("turn"),
  threadId: Thread.ThreadId.make("thread"),
  prompt: "work",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  executionLink: link,
  status: "running",
  createdAt: 0,
  updatedAt: 0,
}

it.effect("returns stored terminal state and units when checkpoint resume yields no new changes", () =>
  Effect.gen(function* () {
    const completed = { ...turn, status: "completed" as const }
    const units = [
      {
        key: "assistant:stored",
        turnId: turn.id,
        order: unitOrder("assistant:stored", 0),
        revision: 3,
        content: { _tag: "Entry" as const, role: "assistant" as const, text: "stored answer" },
      },
    ]
    const projection = {
      turn: completed,
      units,
      checkpointGeneration: 2,
      revision: 3,
      state: {
        status: "completed" as const,
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
      projectorCheckpoint: { version: 1 as const, cursor: "stored-cursor", state: "{}" },
      projectionVersion: 1,
    }
    const owner = yield* make(
      { get: () => Effect.succeed(completed) } as TurnRepository.Interface,
      {
        get: () => Effect.succeed(projection),
        commitProjection: () => Effect.succeed("committed" as const),
      } as TranscriptRepository.Interface,
      { watchTurn: () => Stream.empty } as ExecutionGateway.Interface,
    )
    expect(yield* owner.watchTurn(turn.id)).toMatchObject({
      status: "completed",
      state: { status: "completed" },
      units: [{ content: { text: "stored answer" } }],
      changes: [],
      checkpoint: { cursor: "stored-cursor" },
    })
  }),
)

it.effect("persists the execution link before accepting interruption", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const releaseStart = yield* Deferred.make<void>()
    const attached = yield* Deferred.make<void>()
    const owner = yield* make(
      {
        prepareExecutionAdmission: (input) => Effect.succeed(input),
        attachExecutionLink: () => Deferred.succeed(attached, undefined),
      } as TurnRepository.Interface,
      {} as TranscriptRepository.Interface,
      {
        startTurn: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(releaseStart)), Effect.as(link)),
      } as ExecutionGateway.Interface,
    )
    const fiber = yield* Effect.forkChild(
      owner.startTurn({
        threadId: "thread",
        turnId: "turn",
        workspace: "/workspace",
        prompt: "work",
        executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
      }),
    )
    yield* Deferred.await(started)
    const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber))
    yield* Deferred.succeed(releaseStart, undefined)
    yield* Fiber.join(interruption)
    expect(yield* Deferred.isDone(attached)).toBe(true)
  }),
)

it.effect("recovers every dual-database admission crash window into one idempotent Baton Run", () =>
  Effect.gen(function* () {
    const input: ExecutionGateway.StartTurn = {
      threadId: "thread",
      turnId: "turn",
      workspace: "/workspace",
      prompt: "prepared work",
      promptParts: [{ type: "text", text: "prepared work" }],
      executionRoute: ExecutionRouteSnapshot.testExecutionRoute("high"),
      titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "Prepared work" },
    }
    const scenario = Effect.fn("RootTurnOwner.testCrashWindow")(function* (
      window: "before-start" | "after-start" | "after-link",
    ) {
      let persistedInput: ExecutionGateway.StartTurn | undefined
      let persistedLink: ExecutionGateway.ExecutionLink | undefined
      let failAttach = window === "after-start"
      let startAttempts = 0
      const runs = new Map<string, { readonly input: string; readonly link: ExecutionGateway.ExecutionLink }>()
      const repository = {
        prepareExecutionAdmission: (candidate: ExecutionGateway.StartTurn) =>
          Effect.gen(function* () {
            const encoded = encodeStartTurn(candidate)
            if (persistedInput !== undefined && encodeStartTurn(persistedInput) !== encoded)
              return yield* TurnRepository.RepositoryError.make({ message: "changed prepared admission" })
            persistedInput ??= structuredClone(candidate)
            return structuredClone(persistedInput)
          }),
        listUnlinkedExecutionAdmissions: Effect.sync(() =>
          persistedInput === undefined || persistedLink !== undefined ? [] : [structuredClone(persistedInput)],
        ),
        attachExecutionLink: (_turnId: Turn.TurnId, candidate: ExecutionGateway.ExecutionLink) =>
          Effect.gen(function* () {
            if (failAttach) {
              failAttach = false
              return yield* TurnRepository.RepositoryError.make({ message: "simulated process loss before link" })
            }
            persistedLink = structuredClone(candidate)
            return { ...turn, executionLink: persistedLink }
          }),
      } as unknown as TurnRepository.Interface
      const gateway = {
        startTurn: (candidate: ExecutionGateway.StartTurn) =>
          Effect.gen(function* () {
            startAttempts += 1
            const encoded = encodeStartTurn(candidate)
            const existing = runs.get(candidate.turnId)
            if (existing !== undefined) {
              if (existing.input !== encoded)
                return yield* ExecutionGateway.StartTurnFailure.make({ message: "changed Baton admission" })
              return existing.link
            }
            const executionLink = {
              runId: `opaque-${runs.size + 1}`,
              turnId: candidate.turnId,
              threadId: candidate.threadId,
            }
            runs.set(candidate.turnId, { input: encoded, link: executionLink })
            return executionLink
          }),
      } as unknown as ExecutionGateway.Interface
      const owner = yield* make(repository, {} as TranscriptRepository.Interface, gateway)
      if (window === "before-start") yield* repository.prepareExecutionAdmission(input, 1)
      else yield* Effect.result(owner.startTurn(input))
      const recovered = yield* make(repository, {} as TranscriptRepository.Interface, gateway)
      yield* recovered.recoverExecutionAdmissions
      expect(runs.size).toBe(1)
      expect(persistedInput).toEqual(input)
      expect(persistedLink).toEqual({ runId: "opaque-1", turnId: "turn", threadId: "thread" })
      expect(startAttempts).toBe(window === "after-start" ? 2 : 1)
    })
    yield* scenario("before-start")
    yield* scenario("after-start")
    yield* scenario("after-link")
  }),
)
