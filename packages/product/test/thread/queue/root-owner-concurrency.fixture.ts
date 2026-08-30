import * as ExecutionProjection from "@rika/product/execution-projection"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import type { Projection } from "@rika/product/transcript-page"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Cause, Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { unitOrder } from "@rika/transcript/transcript-unit-order"

import { make } from "../../../src/thread/queue/root-owner"
import { turn } from "./root-owner.fixture"

it.effect("coalesces an observer request that arrives before the current observer releases", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({}),
    )
    expect(yield* owner.claim(turn.id)).toBe(true)
    expect(yield* owner.claim(turn.id)).toBe(false)
    expect(yield* owner.release(turn.threadId, turn.id)).toBe(true)
    expect(yield* owner.claim(turn.id)).toBe(true)
    expect(yield* owner.release(turn.threadId, turn.id)).toBe(false)
  }),
)

it.effect("lets another Thread start while one Thread is blocked", () =>
  Effect.gen(function* () {
    const xEntered = yield* Deferred.make<void>()
    const releaseX = yield* Deferred.make<void>()
    const yEntered = yield* Deferred.make<void>()
    const repository = TurnRepository.Service.of({
      prepareExecutionAdmission: (input) => Effect.succeed(input),
      attachExecutionLink: (turnId: Turn.TurnId, executionLink: ExecutionGateway.ExecutionLink) =>
        Effect.succeed({
          ...turn,
          id: turnId,
          threadId: Thread.ThreadId.make(executionLink.threadId),
          executionLink,
        }),
    })
    const owner = yield* make(
      repository,
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({
        startTurn: (input) =>
          (input.threadId === "thread-x"
            ? Deferred.succeed(xEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseX)))
            : Deferred.succeed(yEntered, undefined)
          ).pipe(Effect.as({ runId: `run-${input.turnId}`, threadId: input.threadId, turnId: input.turnId })),
      }),
    )
    const start = (threadId: string, turnId: string) =>
      owner.startTurn({
        threadId,
        turnId,
        workspaceId: "/workspace",
        prompt: "work",
        executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
      })
    const x = yield* Effect.forkChild(start("thread-x", "turn-x"))
    yield* Deferred.await(xEntered)
    const y = yield* Effect.forkChild(start("thread-y", "turn-y"))
    yield* Effect.yieldNow
    const yProgressedWhileXWasBlocked = yield* Deferred.isDone(yEntered)
    yield* Deferred.succeed(releaseX, undefined)
    yield* Fiber.join(x)
    yield* Fiber.join(y)
    expect(yProgressedWhileXWasBlocked).toBe(true)
  }),
)

it.effect("quiesces only the affected Thread fibers", () =>
  Effect.gen(function* () {
    const xEntered = yield* Deferred.make<void>()
    const yEntered = yield* Deferred.make<void>()
    const xInterrupted = yield* Deferred.make<void>()
    const yInterrupted = yield* Deferred.make<void>()
    const finishY = yield* Deferred.make<void>()
    const xTurn = { ...turn, id: Turn.TurnId.make("turn-x"), threadId: Thread.ThreadId.make("thread-x") }
    const yTurn = { ...turn, id: Turn.TurnId.make("turn-y"), threadId: Thread.ThreadId.make("thread-y") }
    const owner = yield* make(
      TurnRepository.Service.of({
        get: (turnId) => Effect.succeed(turnId === xTurn.id ? xTurn : yTurn),
      }),
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({}),
    )
    yield* owner.install({
      run: (turnId) =>
        (turnId === xTurn.id
          ? Deferred.succeed(xEntered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(xInterrupted, undefined).pipe(Effect.asVoid)),
            )
          : Deferred.succeed(yEntered, undefined).pipe(
              Effect.andThen(Deferred.await(finishY)),
              Effect.onInterrupt(() => Deferred.succeed(yInterrupted, undefined).pipe(Effect.asVoid)),
            )
        ).pipe(Effect.asVoid),
    })
    yield* owner.accepted(xTurn.threadId, xTurn.id)
    yield* owner.accepted(yTurn.threadId, yTurn.id)
    yield* Deferred.await(xEntered)
    yield* Deferred.await(yEntered)
    yield* owner.quiesceThread(xTurn.threadId)
    expect(yield* Deferred.isDone(xInterrupted)).toBe(true)
    expect(yield* Deferred.isDone(yInterrupted)).toBe(false)
    yield* Deferred.succeed(finishY, undefined)
  }),
)

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
      projectorCheckpoint: { version: ExecutionProjection.projectionVersion, cursor: "stored-cursor", state: "{}" },
      projectionVersion: 1,
    }
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(completed) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(projection),
        commitProjection: () => Effect.succeed("committed" as const),
      }),
      ExecutionGateway.Service.of({
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "stored-cursor" }),
      }),
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result).toMatchObject({
      status: "completed",
      state: { status: "completed" },
      units: [{ content: { text: "stored answer" } }],
      checkpoint: { cursor: "stored-cursor" },
    })
    expect(Object.hasOwn(result, "changes")).toBe(false)
  }),
)

it.effect("passes the included pricing class to the backend for an OpenAI account route", () =>
  Effect.gen(function* () {
    const route = ExecutionRouteSnapshot.testExecutionRoute()
    const accountTurn: Turn.AgentExecutionTurn = {
      ...turn,
      executionRoute: {
        ...route,
        main: {
          ...route.main,
          candidates: [
            {
              ...route.main.candidates[0]!,
              providerConnection: {
                provider: "openai",
                protocol: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                authentication: "account",
                credentialIdentity: "fingerprint",
              },
            },
          ],
        },
      },
    }
    const completed = { ...accountTurn, status: "completed" as const }
    const projection = {
      turn: completed,
      units: [],
      checkpointGeneration: 1,
      revision: 1,
      state: {
        status: "completed" as const,
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
      projectorCheckpoint: { version: ExecutionProjection.projectionVersion, cursor: "account", state: "{}" },
      projectionVersion: ExecutionProjection.projectionVersion,
    }
    let receivedPricing: string | undefined
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(completed) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(projection),
        commitProjection: () => Effect.succeed("committed" as const),
      }),
      ExecutionGateway.Service.of({
        watchTurn: (_link, input) => {
          receivedPricing = input?.pricing
          return Stream.empty
        },
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "account" }),
      }),
    )
    yield* owner.watchTurn(accountTurn.id)
    expect(receivedPricing).toBe("included")
  }),
)

it.effect("commits and delivers each live change once without retaining or redelivering completion", () =>
  Effect.gen(function* () {
    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "running", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "running",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const completed: ExecutionProjection.Change = {
      _tag: "ProjectionPatch",
      baseRevision: 1,
      revision: 2,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "completed", state: "{}" },
      upsert: [],
      remove: [],
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    let stored: Projection | undefined
    const commits: Array<ExecutionProjection.Change> = []
    const trace: Array<string> = []
    let watches = 0
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(stored),
        commitProjection: (_turn, change) =>
          Effect.sync(() => {
            commits.push(change)
            trace.push(`commit:${change.revision}`)
            stored = {
              turn,
              units: [],
              checkpointGeneration: commits.length,
              revision: change.revision,
              state: change.state,
              projectorCheckpoint: change.checkpoint,
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      }),
      ExecutionGateway.Service.of({
        watchTurn: () => {
          watches += 1
          return watches === 1 ? Stream.fromIterable([running, completed]) : Stream.empty
        },
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "completed" }),
      }),
    )
    const delivered: Array<ExecutionProjection.Change> = []
    const first = yield* owner.watchTurn(turn.id, (change) => {
      delivered.push(change)
      trace.push(`callback:${change.revision}`)
    })
    expect(commits).toEqual([running, completed])
    expect(delivered).toEqual([running, completed])
    expect(trace).toEqual(["commit:1", "callback:1", "commit:2", "callback:2"])
    expect(first).toMatchObject({
      status: "completed",
      state: { status: "completed" },
      checkpoint: { cursor: "completed" },
    })
    expect(Object.hasOwn(first, "changes")).toBe(false)

    const completionDeliveries: Array<ExecutionProjection.Change> = []
    const resumed = yield* owner.watchTurn(turn.id, (change) => completionDeliveries.push(change))
    expect(completionDeliveries).toEqual([])
    expect(commits).toHaveLength(2)
    expect(resumed.status).toBe("completed")
    expect(Object.hasOwn(resumed, "changes")).toBe(false)
  }),
)

it.effect("propagates a consumer callback defect instead of treating it as a reconnect", () =>
  Effect.gen(function* () {
    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "running", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "running",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    let watches = 0
    let commits = 0
    let inspections = 0
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.void,
        commitProjection: () =>
          Effect.sync(() => {
            commits += 1
            return "committed" as const
          }),
      }),
      ExecutionGateway.Service.of({
        watchTurn: () => {
          watches += 1
          return Stream.succeed(running)
        },
        inspectTurn: () =>
          Effect.sync(() => {
            inspections += 1
            return { status: "running" as const, cursor: "running" }
          }),
      }),
    )

    const result = yield* owner
      .watchTurn(turn.id, () => {
        throw new Error("consumer callback defect")
      })
      .pipe(Effect.exit)

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(Cause.pretty(result.cause)).toContain("consumer callback defect")
    expect(watches).toBe(1)
    expect(commits).toBe(1)
    expect(inspections).toBe(0)
  }),
)

it.effect("reloads the committed checkpoint when another projector makes a change stale", () =>
  Effect.gen(function* () {
    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "running", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "running",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const completed: ExecutionProjection.Change = {
      _tag: "ProjectionPatch",
      baseRevision: 1,
      revision: 2,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "completed", state: "{}" },
      upsert: [],
      remove: [],
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const stale = yield* Deferred.make<void>()
    let stored: Projection | undefined
    const commits = new Array<ExecutionProjection.Change>()
    const delivered = new Array<ExecutionProjection.Change>()
    const cursors = new Array<string | undefined>()
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(stored),
        commitProjection: (_turn, change) =>
          Effect.gen(function* () {
            commits.push(change)
            if (commits.length === 1) {
              stored = {
                turn,
                units: [],
                checkpointGeneration: 1,
                revision: 1,
                state: running.state,
                projectorCheckpoint: {
                  version: ExecutionProjection.projectionVersion,
                  cursor: "winner",
                  state: "{}",
                },
                projectionVersion: ExecutionProjection.projectionVersion,
              }
              yield* Deferred.succeed(stale, undefined)
              return "stale" as const
            }
            stored = {
              turn,
              units: change._tag === "ProjectionSnapshot" ? change.units : (stored?.units ?? []),
              checkpointGeneration: (stored?.checkpointGeneration ?? 0) + 1,
              revision: change.revision,
              state: change.state,
              projectorCheckpoint: change.checkpoint,
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      }),
      ExecutionGateway.Service.of({
        watchTurn: (_link, input) => {
          cursors.push(input?.checkpoint?.cursor)
          return Stream.succeed(input?.checkpoint?.cursor === "winner" ? completed : running)
        },
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "completed" }),
      }),
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id, (change) => delivered.push(change)))
    yield* Deferred.await(stale)

    yield* TestClock.adjust("99 millis")
    expect(cursors).toEqual([undefined])
    yield* TestClock.adjust("1 millis")
    const result = yield* Fiber.join(fiber)

    expect(cursors).toEqual([undefined, "winner"])
    expect(commits).toEqual([running, completed])
    expect(delivered).toEqual([completed])
    expect(result).toMatchObject({
      status: "completed",
      state: { status: "completed" },
      checkpoint: { cursor: "completed" },
    })
  }),
)
