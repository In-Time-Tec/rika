import * as ExecutionProjection from "@rika/product/execution-projection"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import type { Projection } from "@rika/product/transcript-page"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { unitOrder } from "@rika/transcript/transcript-unit-order"

import { make } from "../../../src/thread/queue/root-owner"
import { link, turn } from "./root-owner.fixture"

it.effect("falls back to the persisted running status when the backend run is unavailable", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({ get: () => Effect.void }),
      ExecutionGateway.Service.of({
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "unavailable" as const }),
      }),
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("running")
    expect(result.state.status).toBe("running")
  }),
)

it.effect("keeps preview traffic out of the transcript repository and final result", () =>
  Effect.gen(function* () {
    const completed: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "preview-completed", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const previews: ReadonlyArray<ExecutionGateway.ModelPreviewEvent> = Array.from({ length: 100 }, (_, index) => ({
      _tag: "ModelPreview",
      runId: link.runId,
      attemptFence: 1,
      turn: 0,
      modelCallId: "call",
      modelAttemptId: "attempt",
      attempt: 0,
      sequence: index,
      changes: [{ channel: "text", offset: index, delta: "x" }],
    }))
    const execute = Effect.fn("RootTurnOwner.testPreviewNonAuthority")(function* (enabled: boolean) {
      let stored: Projection | undefined
      const commits: Array<ExecutionProjection.Change> = []
      const delivered: Array<ExecutionProjection.Change | ExecutionGateway.ModelPreviewEvent> = []
      const owner = yield* make(
        TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
        TranscriptRepository.Service.of({
          get: () => Effect.succeed(stored),
          commitProjection: (_turn, change) =>
            Effect.sync(() => {
              commits.push(change)
              stored = {
                turn,
                units: change._tag === "ProjectionSnapshot" ? change.units : change.upsert,
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
          watchTurn: () => Stream.fromIterable(enabled ? [...previews, completed] : [completed]),
          inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "preview-completed" }),
        }),
      )
      const result = yield* owner.watchTurn(
        turn.id,
        (change) => delivered.push(change),
        (preview) => delivered.push(preview),
      )
      return { commits, delivered, result }
    })

    const observed = yield* execute(true)
    const baseline = yield* execute(false)
    expect(observed.delivered).toHaveLength(101)
    expect(observed.delivered.filter((event) => event._tag === "ModelPreview")).toHaveLength(100)
    expect(observed.commits).toEqual([completed])
    expect(baseline.commits).toEqual([completed])
    expect(observed.result).toEqual(baseline.result)
  }),
)

it.effect("keeps late accepted callbacks behind a quiesced Thread fence", () =>
  Effect.gen(function* () {
    let launches = 0
    const owner = yield* make(
      TurnRepository.Service.of({
        get: () => Effect.succeed(turn),
        list: () => Effect.succeed([turn]),
      }),
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({}),
    )
    yield* owner.install({ run: () => Effect.sync(() => (launches += 1)).pipe(Effect.asVoid) })
    expect(yield* owner.claim(turn.id, "running")).toBe(true)
    yield* owner.quiesceThread(turn.threadId)
    yield* owner.accepted(turn.threadId, turn.id)
    yield* Effect.yieldNow
    expect(launches).toBe(0)
  }),
)

it.effect("claims a terminal turn only while its recovered status still matches", () =>
  Effect.gen(function* () {
    let current: Turn.AgentExecutionTurn = { ...turn, status: "completed" }
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(current) }),
      TranscriptRepository.Service.of({}),
      ExecutionGateway.Service.of({}),
    )

    expect(yield* owner.claim(turn.id)).toBe(false)
    expect(yield* owner.claim(turn.id, "failed")).toBe(false)
    expect(yield* owner.claim(turn.id, "completed")).toBe(true)
    expect(yield* owner.release(turn.threadId, turn.id)).toBe(false)

    current = { ...current, status: "failed" }
    expect(yield* owner.claim(turn.id, "completed")).toBe(false)
  }),
)

it.effect("settles a terminal Run only from a matching stored projection cursor", () =>
  Effect.gen(function* () {
    const projection: Projection = {
      turn: { ...turn, status: "completed" },
      units: [],
      checkpointGeneration: 1,
      revision: 1,
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
      projectorCheckpoint: { version: ExecutionProjection.projectionVersion, cursor: "terminal", state: "{}" },
      projectionVersion: ExecutionProjection.projectionVersion,
    }
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({ get: () => Effect.succeed(projection) }),
      ExecutionGateway.Service.of({
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "terminal" }),
      }),
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("completed")
    expect(result.state.status).toBe("completed")
    expect(result.checkpoint).toEqual(expect.objectContaining({ cursor: "terminal" }))
  }),
)

it.effect("replays a stale running cursor before returning a coherent terminal projection", () =>
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
    const terminalUnit = {
      key: "assistant:terminal",
      turnId: turn.id,
      order: unitOrder("assistant:terminal", 0),
      revision: 1,
      content: { _tag: "Entry" as const, role: "assistant" as const, text: "terminal answer" },
    }
    const completed: ExecutionProjection.Change = {
      _tag: "ProjectionPatch",
      baseRevision: 1,
      revision: 2,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "terminal", state: "{}" },
      upsert: [terminalUnit],
      remove: [],
      state: {
        status: "completed",
        usage: { ...ExecutionProjection.emptyUsageState(), sourceComplete: true },
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    let stored: Projection | undefined
    const cursors = new Array<string | undefined>()
    const commits = new Array<ExecutionProjection.Change>()
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(stored),
        commitProjection: (_turn, change) =>
          Effect.sync(() => {
            commits.push(change)
            stored = {
              turn,
              units: change._tag === "ProjectionSnapshot" ? change.units : change.upsert,
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
        watchTurn: (_link, input) => {
          cursors.push(input?.checkpoint?.cursor)
          return Stream.succeed(input?.checkpoint?.cursor === "running" ? completed : running)
        },
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "terminal" }),
      }),
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id))
    yield* Effect.yieldNow
    yield* TestClock.adjust("100 millis")
    yield* Effect.yieldNow
    const result = yield* Fiber.join(fiber)

    expect(cursors).toEqual([undefined, "running"])
    expect(commits).toEqual([running, completed])
    expect(result).toMatchObject({
      status: "completed",
      state: { status: "completed", usage: { sourceComplete: true } },
      units: [{ content: { text: "terminal answer" } }],
      checkpoint: { cursor: "terminal" },
    })
  }),
)

it.effect("falls back to the persisted running status when the backend run is unavailable", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({ get: () => Effect.void }),
      ExecutionGateway.Service.of({
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "unavailable" as const }),
      }),
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("running")
    expect(result.state.status).toBe("running")
  }),
)

it.effect("does not authorize a terminal result when Generalist inspection is unavailable", () =>
  Effect.gen(function* () {
    const completedTurn = { ...turn, status: "completed" as const }
    const projection: Projection = {
      turn: completedTurn,
      units: [],
      checkpointGeneration: 1,
      revision: 1,
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
      projectorCheckpoint: {
        version: ExecutionProjection.projectionVersion,
        cursor: "local-terminal",
        state: "{}",
      },
      projectionVersion: ExecutionProjection.projectionVersion,
    }
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(completedTurn) }),
      TranscriptRepository.Service.of({ get: () => Effect.succeed(projection) }),
      ExecutionGateway.Service.of({
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "unavailable" as const }),
      }),
    )

    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("running")
    expect(result.state.status).toBe("running")
    expect(result.checkpoint).toEqual(expect.objectContaining({ cursor: "local-terminal" }))
  }),
)

it.effect("withholds an emitted terminal projection until matching Generalist inspection succeeds", () =>
  Effect.gen(function* () {
    const completed: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "terminal", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const inspected = yield* Deferred.make<void>()
    let stored: Projection | undefined
    let inspections = 0
    const commits = new Array<ExecutionProjection.Change>()
    const delivered = new Array<ExecutionProjection.Change>()
    const owner = yield* make(
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
        get: () => Effect.succeed(stored),
        commitProjection: (_turn, change) =>
          Effect.sync(() => {
            commits.push(change)
            stored = {
              turn,
              units: change._tag === "ProjectionSnapshot" ? change.units : [],
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
        watchTurn: () => Stream.succeed(completed),
        inspectTurn: () =>
          Effect.gen(function* () {
            inspections += 1
            if (inspections === 1) {
              yield* Deferred.succeed(inspected, undefined)
              return { status: "unavailable" as const }
            }
            return { status: "completed" as const, cursor: "terminal" }
          }),
      }),
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id, (change) => delivered.push(change)))
    yield* Deferred.await(inspected)

    expect(commits).toEqual([])
    expect(delivered).toEqual([])
    yield* TestClock.adjust("99 millis")
    expect(commits).toEqual([])
    yield* TestClock.adjust("1 millis")
    const result = yield* Fiber.join(fiber)

    expect(inspections).toBe(2)
    expect(commits).toEqual([completed])
    expect(delivered).toEqual([completed])
    expect(result).toMatchObject({ status: "completed", checkpoint: { cursor: "terminal" } })
  }),
)
