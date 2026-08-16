import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import type { Projection } from "@rika/product/transcript-page"
import { expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { unitOrder } from "@rika/transcript/transcript-unit-order"
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

it.effect("claims a terminal turn only while its recovered status still matches", () =>
  Effect.gen(function* () {
    let current: Turn.AgentExecutionTurn = { ...turn, status: "completed" }
    const owner = yield* make(
      { get: () => Effect.succeed(current) } as TurnRepository.Interface,
      {} as TranscriptRepository.Interface,
      {} as ExecutionGateway.Interface,
    )

    expect(yield* owner.claim(turn.id)).toBe(false)
    expect(yield* owner.claim(turn.id, "failed")).toBe(false)
    expect(yield* owner.claim(turn.id, "completed")).toBe(true)
    expect(yield* owner.release(turn.id)).toBe(false)

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
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      { get: () => Effect.succeed(projection) } as TranscriptRepository.Interface,
      {
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "terminal" }),
      } as ExecutionGateway.Interface,
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("completed")
    expect(result.state.status).toBe("completed")
    expect(result.checkpoint?.cursor).toBe("terminal")
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
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      {
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
              ...(change.checkpoint === undefined ? {} : { projectorCheckpoint: change.checkpoint }),
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      } as TranscriptRepository.Interface,
      {
        watchTurn: (_link, input) => {
          cursors.push(input?.checkpoint?.cursor)
          return Stream.succeed(input?.checkpoint?.cursor === "running" ? completed : running)
        },
        inspectTurn: () => Effect.succeed({ status: "completed" as const, cursor: "terminal" }),
      } as ExecutionGateway.Interface,
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id))
    yield* TestClock.adjust("100 millis")
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
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      { get: () => Effect.void } as TranscriptRepository.Interface,
      {
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "unavailable" as const }),
      } as ExecutionGateway.Interface,
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("running")
    expect(result.state.status).toBe("running")
  }),
)

it.effect("does not authorize a terminal result when Baton inspection is unavailable", () =>
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
      { get: () => Effect.succeed(completedTurn) } as TurnRepository.Interface,
      { get: () => Effect.succeed(projection) } as TranscriptRepository.Interface,
      {
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "unavailable" as const }),
      } as ExecutionGateway.Interface,
    )

    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("running")
    expect(result.state.status).toBe("running")
    expect(result.checkpoint?.cursor).toBe("local-terminal")
  }),
)

it.effect("withholds an emitted terminal projection until matching Baton inspection succeeds", () =>
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
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      {
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
              ...(change.checkpoint === undefined ? {} : { projectorCheckpoint: change.checkpoint }),
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      } as TranscriptRepository.Interface,
      {
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
      } as ExecutionGateway.Interface,
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

it.effect("reconnects after watcher failures and replays from the newest committed checkpoint", () =>
  Effect.gen(function* () {
    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "running-cursor", state: "{}" },
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
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "completed-cursor", state: "{}" },
      upsert: [],
      remove: [],
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const started = yield* Deferred.make<void>()
    let stored: Projection | undefined
    let attempts = 0
    let inspections = 0
    const cursors = new Array<string | undefined>()
    const commits = new Array<ExecutionProjection.Change>()
    const delivered = new Array<ExecutionProjection.Change>()
    const owner = yield* make(
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      {
        get: () => Effect.succeed(stored),
        commitProjection: (_turn, change) =>
          Effect.sync(() => {
            commits.push(change)
            stored = {
              turn,
              units: change._tag === "ProjectionSnapshot" ? change.units : (stored?.units ?? []),
              checkpointGeneration: (stored?.checkpointGeneration ?? 0) + 1,
              revision: change.revision,
              state: change.state,
              ...(change.checkpoint === undefined ? {} : { projectorCheckpoint: change.checkpoint }),
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      } as TranscriptRepository.Interface,
      {
        watchTurn: (_link, input) => {
          attempts += 1
          cursors.push(input?.checkpoint?.cursor)
          if (attempts === 1)
            return Stream.fromEffect(
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(
                  Effect.fail(ExecutionGateway.WatchTurnFailure.make({ message: "watch transport failed" })),
                ),
              ),
            )
          if (attempts === 2) return Stream.die("projector defect")
          return Stream.succeed(attempts === 3 ? running : completed)
        },
        inspectTurn: () =>
          Effect.sync(() => {
            inspections += 1
            return inspections === 1
              ? ({ status: "running", cursor: "running-cursor" } as const)
              : ({ status: "completed", cursor: "completed-cursor" } as const)
          }),
      } as ExecutionGateway.Interface,
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id, (change) => delivered.push(change)))
    yield* Deferred.await(started)

    yield* TestClock.adjust("99 millis")
    expect(attempts).toBe(1)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(2)
    yield* TestClock.adjust("199 millis")
    expect(attempts).toBe(2)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(3)
    expect(inspections).toBe(1)
    yield* TestClock.adjust("99 millis")
    expect(attempts).toBe(3)
    yield* TestClock.adjust("1 millis")

    const result = yield* Fiber.join(fiber)
    expect(attempts).toBe(4)
    expect(inspections).toBe(2)
    expect(cursors).toEqual([undefined, undefined, undefined, "running-cursor"])
    expect(commits).toEqual([running, completed])
    expect(delivered).toEqual([running, completed])
    expect(result).toMatchObject({
      status: "completed",
      state: { status: "completed" },
      checkpoint: { cursor: "completed-cursor" },
    })
  }),
)

it.effect("caps reconnect backoff at five seconds and remains interruptible", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let attempts = 0
    const owner = yield* make(
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      { get: () => Effect.void } as TranscriptRepository.Interface,
      {
        watchTurn: () =>
          Stream.fromEffect(
            Effect.gen(function* () {
              attempts += 1
              if (attempts === 1) yield* Deferred.succeed(started, undefined)
              return yield* ExecutionGateway.WatchTurnFailure.make({ message: "still disconnected" })
            }),
          ),
      } as ExecutionGateway.Interface,
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id))
    yield* Deferred.await(started)

    yield* TestClock.adjust("99 millis")
    expect(attempts).toBe(1)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(2)
    yield* TestClock.adjust("199 millis")
    expect(attempts).toBe(2)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(3)
    yield* TestClock.adjust("399 millis")
    expect(attempts).toBe(3)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(4)
    yield* TestClock.adjust("799 millis")
    expect(attempts).toBe(4)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(5)
    yield* TestClock.adjust("1599 millis")
    expect(attempts).toBe(5)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(6)
    yield* TestClock.adjust("3199 millis")
    expect(attempts).toBe(6)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(7)
    yield* TestClock.adjust("4999 millis")
    expect(attempts).toBe(7)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(8)
    yield* TestClock.adjust("4999 millis")
    expect(attempts).toBe(8)
    yield* TestClock.adjust("1 millis")
    expect(attempts).toBe(9)

    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }),
)

it.effect("propagates interruption while blocked at every observation boundary", () =>
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
    yield* Effect.forEach(
      ["read", "watch", "commit", "inspect"] as const,
      (stage) =>
        Effect.gen(function* () {
          const blocked = yield* Deferred.make<void>()
          const block = Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never))
          const owner = yield* make(
            { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
            {
              get: () => (stage === "read" ? block : Effect.void),
              commitProjection: () => (stage === "commit" ? block : Effect.succeed("committed" as const)),
            } as TranscriptRepository.Interface,
            {
              watchTurn: () => (stage === "watch" ? Stream.fromEffect(block) : Stream.succeed(running)),
              inspectTurn: () =>
                stage === "inspect" ? block : Effect.succeed({ status: "running" as const, cursor: "running" }),
            } as ExecutionGateway.Interface,
          )
          const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id))
          yield* Deferred.await(blocked)
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }),
      { discard: true },
    )
  }),
)

it.effect("recovers typed errors and defects at every projection boundary", () =>
  Effect.gen(function* () {
    const completed: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "completed-cursor", state: "{}" },
      units: [],
      hasOlder: false,
      state: {
        status: "completed",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const faults = [
      "transcript-read-error",
      "transcript-read-defect",
      "transcript-final-read-error",
      "transcript-final-read-defect",
      "transcript-commit-error",
      "transcript-commit-defect",
      "inspect-error",
      "inspect-defect",
    ] as const
    yield* Effect.forEach(
      faults,
      (fault) =>
        Effect.gen(function* () {
          const faulted = yield* Deferred.make<void>()
          let stored: Projection | undefined
          let reads = 0
          let commits = 0
          let inspections = 0
          let watches = 0
          const delivered = new Array<ExecutionProjection.Change>()
          const transcriptError = (message: string) =>
            Deferred.succeed(faulted, undefined).pipe(
              Effect.andThen(TranscriptRepository.RepositoryError.make({ message })),
            )
          const defect = (message: string) =>
            Deferred.succeed(faulted, undefined).pipe(Effect.andThen(Effect.die(message)))
          const owner = yield* make(
            { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
            {
              get: () => {
                reads += 1
                if (reads === 1 && fault === "transcript-read-error") return transcriptError(fault)
                if (reads === 1 && fault === "transcript-read-defect") return defect(fault)
                if (reads === 2 && fault === "transcript-final-read-error") return transcriptError(fault)
                if (reads === 2 && fault === "transcript-final-read-defect") return defect(fault)
                return Effect.succeed(stored)
              },
              commitProjection: (_turn, change) => {
                commits += 1
                if (commits === 1 && fault === "transcript-commit-error") return transcriptError(fault)
                if (commits === 1 && fault === "transcript-commit-defect") return defect(fault)
                return Effect.sync(() => {
                  stored = {
                    turn,
                    units: change._tag === "ProjectionSnapshot" ? change.units : (stored?.units ?? []),
                    checkpointGeneration: (stored?.checkpointGeneration ?? 0) + 1,
                    revision: change.revision,
                    state: change.state,
                    ...(change.checkpoint === undefined ? {} : { projectorCheckpoint: change.checkpoint }),
                    projectionVersion: ExecutionProjection.projectionVersion,
                  }
                  return "committed" as const
                })
              },
            } as TranscriptRepository.Interface,
            {
              watchTurn: (_link, input) => {
                watches += 1
                return input?.checkpoint?.cursor === "completed-cursor" ? Stream.empty : Stream.succeed(completed)
              },
              inspectTurn: () => {
                inspections += 1
                if (inspections === 1 && fault === "inspect-error")
                  return Deferred.succeed(faulted, undefined).pipe(
                    Effect.andThen(ExecutionGateway.InspectTurnFailure.make({ message: "inspect transport failed" })),
                  )
                if (inspections === 1 && fault === "inspect-defect") return defect(fault)
                return Effect.succeed({ status: "completed" as const, cursor: "completed-cursor" })
              },
            } as ExecutionGateway.Interface,
          )
          const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id, (change) => delivered.push(change)))
          yield* Deferred.await(faulted)
          yield* Effect.yieldNow
          const watchesBeforeRetry = fault === "transcript-read-error" || fault === "transcript-read-defect" ? 0 : 1
          expect(watches).toBe(watchesBeforeRetry)
          yield* TestClock.adjust("99 millis")
          expect(watches).toBe(watchesBeforeRetry)
          yield* TestClock.adjust("1 millis")
          const result = yield* Fiber.join(fiber)

          expect(watches).toBe(watchesBeforeRetry + 1)
          expect(delivered).toEqual([completed])
          expect(result).toMatchObject({
            status: "completed",
            state: { status: "completed" },
            checkpoint: { cursor: "completed-cursor" },
          })
        }),
      { discard: true },
    )
  }),
)


it.effect("terminalizes a turn whose watch stream repeatedly dies with the same defect instead of reconnecting forever", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let attempts = 0
    let failures = 0
    const replaced = new Array<ReadonlyArray<unknown>>()
    const owner = yield* make(
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      {
        get: () => Effect.void,
        replaceUnits: (_updated, units) =>
          Effect.sync(() => {
            replaced.push(units)
            return {
              turn: _updated,
              units,
              checkpointGeneration: replaced.length,
              revision: 1,
              state: {
                status: "failed",
                usage: ExecutionProjection.emptyUsageState(),
                steering: { steeringMessages: 0, followUpMessages: 0 },
              },
              projectionVersion: ExecutionProjection.projectionVersion,
            }
          }),
      } as TranscriptRepository.Interface,
      {
        watchTurn: () =>
          Stream.fromEffect(
            Effect.gen(function* () {
              attempts += 1
              if (attempts === 1) yield* Deferred.succeed(started, undefined)
              failures += 1
              return yield* Effect.die(new RangeError("Baton projector steering text exceeds 4096"))
            }),
          ),
      } as ExecutionGateway.Interface,
    )
    const fiber = yield* Effect.forkChild(owner.watchTurn(turn.id))
    yield* Deferred.await(started)

    yield* TestClock.adjust("99 millis")
    expect(attempts).toBe(1)
    yield* TestClock.adjust("1 millis")
    yield* TestClock.adjust("199 millis")
    expect(attempts).toBe(2)
    expect(failures).toBe(2)
    yield* TestClock.adjust("1 millis")

    expect(replaced).toHaveLength(1)
    const result = yield* Fiber.join(fiber)
    expect(attempts).toBe(3)
    expect(failures).toBe(3)
    expect(replaced).toHaveLength(1)
    expect(result.status).toBe("failed")
    expect(result.state.status).toBe("failed")
    const failureUnit = replaced[0]?.[0] as {
      content: { block: { _tag: string; category: string; retryable: boolean } }
    }
    expect(failureUnit.content.block).toMatchObject({
      _tag: "Error",
      category: "projection-defect",
      retryable: false,
    })
  }),
)
