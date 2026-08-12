import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { make } from "../src/thread/queue/root-turn-owner"

const encodeStartTurn = Schema.encodeSync(Schema.fromJsonString(ExecutionGateway.StartTurn))

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

it.effect("claims an admissible turn once and refuses a second claim", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      { get: () => Effect.succeed(turn) } as import("@rika/product/turn-repository").Interface,
      {} as import("@rika/product/transcript-repository").Interface,
      {} as ExecutionGateway.Interface,
    )
    expect(yield* owner.claim(turn.id, "running")).toBe(true)
    expect(yield* owner.claim(turn.id, "running")).toBe(false)
    expect(yield* owner.release(turn.id)).toBe(true)
    expect(yield* owner.claim(turn.id, "running")).toBe(true)
  }),
)

it.effect("refuses claims for queued, terminal, and mismatched turns", () =>
  Effect.gen(function* () {
    const statuses = ["queued", "completed", "failed", "cancelled"] as const
    for (const status of statuses) {
      const owner = yield* make(
        { get: () => Effect.succeed({ ...turn, status }) } as import("@rika/product/turn-repository").Interface,
        {} as import("@rika/product/transcript-repository").Interface,
        {} as ExecutionGateway.Interface,
      )
      expect(yield* owner.claim(turn.id, status)).toBe(false)
    }
    const owner = yield* make(
      { get: () => Effect.succeed(turn) } as import("@rika/product/turn-repository").Interface,
      {} as import("@rika/product/transcript-repository").Interface,
      {} as ExecutionGateway.Interface,
    )
    expect(yield* owner.claim(turn.id, "accepted")).toBe(false)
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
      } as import("@rika/product/turn-repository").Interface,
      {} as import("@rika/product/transcript-repository").Interface,
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
              return yield* TurnRepository.RepositoryError.make({
                message: "changed prepared admission",
              })
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
              return yield* TurnRepository.RepositoryError.make({
                message: "simulated process loss before link",
              })
            }
            persistedLink = structuredClone(candidate)
            return { ...turn, executionLink: persistedLink }
          }),
      } as unknown as import("@rika/product/turn-repository").Interface
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
      const owner = yield* make(repository, {} as import("@rika/product/transcript-repository").Interface, gateway)
      if (window === "before-start") yield* repository.prepareExecutionAdmission(input, 1)
      else yield* Effect.result(owner.startTurn(input))
      const recovered = yield* make(repository, {} as import("@rika/product/transcript-repository").Interface, gateway)
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

it.effect("keeps late claims behind a quiesced Thread fence", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      {
        get: () => Effect.succeed(turn),
        list: () => Effect.succeed([turn]),
      } as import("@rika/product/turn-repository").Interface,
      {} as import("@rika/product/transcript-repository").Interface,
      {} as ExecutionGateway.Interface,
    )
    expect(yield* owner.claim(turn.id, "running")).toBe(true)
    yield* owner.quiesceThread(turn.threadId)
    expect(yield* owner.claim(turn.id, "running")).toBe(false)
  }),
)

it.effect("refuses queued claims for a quiesced Thread and releases them", () =>
  Effect.gen(function* () {
    const queued = { ...turn, status: "queued" as const, executionLink: undefined }
    const claim = { turn: queued, token: "token" }
    let released = false
    const owner = yield* make(
      {
        claimNextQueued: () => Effect.succeed(claim),
        releaseQueuedClaim: () =>
          Effect.sync(() => {
            released = true
          }),
        list: () => Effect.succeed([queued]),
      } as unknown as import("@rika/product/turn-repository").Interface,
      {} as import("@rika/product/transcript-repository").Interface,
      {} as ExecutionGateway.Interface,
    )
    yield* owner.quiesceThread(Thread.ThreadId.make("thread"))
    expect(yield* owner.claimQueued(Thread.ThreadId.make("thread"), 0)).toBeUndefined()
    expect(released).toBe(false)
    const open = yield* make(
      {
        claimNextQueued: () => Effect.succeed(claim),
      } as unknown as import("@rika/product/turn-repository").Interface,
      {} as import("@rika/product/transcript-repository").Interface,
      {} as ExecutionGateway.Interface,
    )
    expect(yield* open.claimQueued(Thread.ThreadId.make("thread"), 0)).toEqual(claim)
  }),
)
