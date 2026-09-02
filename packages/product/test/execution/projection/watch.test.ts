import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Layer, Logger, Stream } from "effect"
import { TestClock } from "effect/testing"
import { watch } from "../../../src/execution/projection/watch"
import { provideLayer } from "../../support/product-layer"

const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("stalled"),
  threadId: Thread.ThreadId.make("thread"),
  prompt: "work",
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  executionLink: { runId: "run", threadId: "thread", turnId: "stalled" },
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  status: "running",
  createdAt: 1,
  updatedAt: 2,
}

it.effect("keeps a silent projection isolated from execution authority", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let replacements = 0
    let cancellations = 0
    const memoryTranscripts = Context.get(
      yield* Layer.build(TranscriptRepository.productMemoryLayerWithTurns),
      TranscriptRepository.Service,
    )
    const transcripts = TranscriptRepository.Service.of({
      ...memoryTranscripts,
      replaceUnits: () =>
        Effect.sync(() => {
          replacements += 1
        }).pipe(Effect.andThen(Effect.die("unexpected transcript replacement"))),
    })
    const backend = ExecutionGateway.makeTest({
      watchTurn: () => Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
      cancelTurn: () =>
        Effect.sync(() => {
          cancellations += 1
        }),
      inspectTurn: () => Effect.succeed({ status: "running", cursor: "running" }),
    })
    const fiber = yield* Effect.forkChild(
      watch({
        turnId: turn.id,
        turns: TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
        transcripts,
        backend,
        stallSilenceMs: 1_000,
      }),
    )
    yield* Deferred.await(started)
    yield* TestClock.adjust("2 seconds")
    yield* Effect.yieldNow

    expect(cancellations).toBe(0)
    expect(replacements).toBe(0)
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* Fiber.interrupt(fiber)
  }),
)

it.effect("retries deterministic projection defects without cancelling or settling execution", () =>
  Effect.gen(function* () {
    let replacements = 0
    let cancellations = 0
    let attempts = 0
    let releases = 0
    const memoryTranscripts = Context.get(
      yield* Layer.build(TranscriptRepository.productMemoryLayerWithTurns),
      TranscriptRepository.Service,
    )
    const fiber = yield* Effect.forkChild(
      watch({
        turnId: turn.id,
        turns: TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
        transcripts: TranscriptRepository.Service.of({
          ...memoryTranscripts,
          replaceUnits: () =>
            Effect.sync(() => {
              replacements += 1
            }).pipe(Effect.andThen(Effect.die("unexpected transcript replacement"))),
        }),
        backend: ExecutionGateway.makeTest({
          watchTurn: () =>
            Stream.fromEffect(
              Effect.acquireRelease(
                Effect.sync(() => {
                  attempts += 1
                }),
                () =>
                  Effect.sync(() => {
                    releases += 1
                  }),
              ).pipe(Effect.andThen(Effect.die("projection defect"))),
            ),
          cancelTurn: () =>
            Effect.sync(() => {
              cancellations += 1
            }),
          inspectTurn: () => Effect.succeed({ status: "running", cursor: "running" }),
        }),
      }),
    )
    yield* Effect.yieldNow
    yield* TestClock.adjust("100 millis")
    yield* TestClock.adjust("200 millis")
    yield* TestClock.adjust("400 millis")
    yield* Effect.yieldNow

    expect(attempts).toBeGreaterThanOrEqual(3)
    expect(releases).toBe(attempts)
    expect(cancellations).toBe(0)
    expect(replacements).toBe(0)
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* Fiber.interrupt(fiber)
  }),
)

it.effect("escalates a stalled failing watch to ERROR and slows its retries", () =>
  Effect.gen(function* () {
    const logs: Array<{ readonly level: string; readonly message: string }> = []
    const logger = Logger.make(({ logLevel, message }) => {
      logs.push({ level: logLevel, message: String(message) })
    })
    let attempts = 0
    const memoryTranscripts = Context.get(
      yield* Layer.build(TranscriptRepository.productMemoryLayerWithTurns),
      TranscriptRepository.Service,
    )
    const fiber = yield* Effect.forkChild(
      watch({
        turnId: turn.id,
        turns: TurnRepository.Service.of({ get: () => Effect.succeed(turn) }),
        transcripts: memoryTranscripts,
        backend: ExecutionGateway.makeTest({
          watchTurn: () =>
            Stream.fromEffect(
              Effect.sync(() => {
                attempts += 1
              }).pipe(
                Effect.andThen(
                  Effect.fail(ExecutionGateway.WatchTurnFailure.make({ message: "stored snapshot is undecodable" })),
                ),
              ),
            ),
          cancelTurn: () => Effect.void,
          inspectTurn: () => Effect.succeed({ status: "running", cursor: "running" }),
        }),
        stallSilenceMs: 1_000,
      }).pipe(provideLayer(Logger.layer([logger]))),
    )
    yield* Effect.yieldNow
    for (let step = 0; step < 10; step += 1) yield* TestClock.adjust("100 millis")
    const attemptsBeforeStall = attempts
    expect(attemptsBeforeStall).toBeGreaterThanOrEqual(3)
    expect(logs.filter((entry) => entry.level === "Error")).toHaveLength(0)

    for (let step = 0; step < 59; step += 1) yield* TestClock.adjust("1 second")
    const attemptsWhileStalled = attempts - attemptsBeforeStall
    // At the old 5 s cap a minute of failures costs about a dozen reconnects; backing off to 30 s
    // leaves a handful and each is reported as an error.
    expect(attemptsWhileStalled).toBeLessThanOrEqual(6)
    const escalations = logs.filter(
      (entry) => entry.level === "Error" && entry.message === "execution-projection-watch.reconnecting",
    )
    expect(escalations.length).toBeGreaterThanOrEqual(1)
    expect(escalations.length).toBeLessThanOrEqual(attemptsWhileStalled)
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* Fiber.interrupt(fiber)
  }),
)
