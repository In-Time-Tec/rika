import * as ExecutionProjection from "@rika/product/execution-projection"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import type { Projection } from "@rika/product/transcript-page"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import { Cause, Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"

import { make } from "../../../src/thread/queue/root-owner"
import { turn } from "./root-owner.fixture"

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
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({
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
              projectorCheckpoint: change.checkpoint,
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            return "committed" as const
          }),
      }),
      ExecutionGateway.Service.of({
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
      }),
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
    yield* Effect.yieldNow
    expect(attempts).toBe(3)
    expect(inspections).toBe(1)
    yield* TestClock.adjust("99 millis")
    expect(attempts).toBe(3)
    yield* TestClock.adjust("1 millis")
    yield* Effect.yieldNow

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
      TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
      TranscriptRepository.Service.of({ get: () => Effect.void }),
      ExecutionGateway.Service.of({
        watchTurn: () =>
          Stream.fromEffect(
            Effect.gen(function* () {
              attempts += 1
              if (attempts === 1) yield* Deferred.succeed(started, undefined)
              return yield* ExecutionGateway.WatchTurnFailure.make({ message: "still disconnected" })
            }),
          ),
      }),
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
            TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
            TranscriptRepository.Service.of({
              get: () => (stage === "read" ? block : Effect.void),
              commitProjection: () => (stage === "commit" ? block : Effect.succeed("committed" as const)),
            }),
            ExecutionGateway.Service.of({
              watchTurn: () => (stage === "watch" ? Stream.fromEffect(block) : Stream.succeed(running)),
              inspectTurn: () =>
                stage === "inspect" ? block : Effect.succeed({ status: "running" as const, cursor: "running" }),
            }),
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
            TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
            TranscriptRepository.Service.of({
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
                    projectorCheckpoint: change.checkpoint,
                    projectionVersion: ExecutionProjection.projectionVersion,
                  }
                  return "committed" as const
                })
              },
            }),
            ExecutionGateway.Service.of({
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
            }),
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
