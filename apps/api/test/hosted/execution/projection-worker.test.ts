import "./projection-worker.harness"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import { ThreadId as HostedThreadId } from "@rika/product/hosted-model"
import * as Thread from "@rika/product/thread-record"
import type { Projection } from "@rika/product/transcript-page"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { Context, Deferred, Effect, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  HostedProjectionWorker,
  layer as hostedProjectionWorkerLayer,
} from "../../../src/hosted/execution/projection-worker"
import { HostedPreviewBus, makeHostedPreviewBus } from "../../../src/hosted/thread/previews"
import { HostedThreadApplication } from "../../../src/hosted/thread/application"
import { layerTest as hostedWorkerRuntimeLayerTest } from "../../../src/hosted/worker-runtime"

const threadId = Thread.ThreadId.make("thread-test")
const turnId = Turn.TurnId.make("turn-test")
const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: turnId,
  threadId,
  prompt: "test",
  executionRoute: ExecutionRoute.testExecutionRoute(),
  executionLink: { runId: "run-test", threadId, turnId },
  status: "running",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}

const state = (status: "running" | "completed") => ({
  status,
  usage: ExecutionProjection.emptyUsageState(),
  steering: { steeringMessages: 0, followUpMessages: 0 },
})

const testProjectionWorkerLayer = (options: Parameters<typeof hostedProjectionWorkerLayer>[0]) =>
  hostedProjectionWorkerLayer(options).pipe(
    Layer.provide(HostedPreviewBus.memoryLayer),
    Layer.provide(
      Layer.mock(HostedThreadApplication, {
        projectionCommitted: () => Effect.void,
      }),
    ),
    Layer.provide(hostedWorkerRuntimeLayerTest),
  )

it.effect("projects durable changes and publishes transient previews for a recovered Turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const projected = yield* Deferred.make<void>()
      const projectionPublished = yield* Deferred.make<void>()
      const previews = yield* makeHostedPreviewBus()
      const subscription = yield* previews.bus.subscribe(HostedThreadId.make(threadId))
      let projection: Projection | undefined
      const turns = Layer.mock(TurnRepository.Service, {
        get: () => Effect.succeed(turn),
        setStatus: () => Effect.die("projection worker settled the Turn"),
      })
      const transcripts = TranscriptRepository.Service.of({
        ...Context.get(yield* Layer.build(TranscriptRepository.memoryLayer()), TranscriptRepository.Service),
        listProjectionRecoveryCandidates: () => Effect.succeed([{ threadId, turnId, createdAt: turn.createdAt }]),
        get: () => Effect.succeed(projection),
        commitProjection: (_turn: Turn.AgentExecutionTurn, change: ExecutionProjection.Change, withinTransaction) =>
          Effect.sync(() => {
            const common = {
              turn,
              units: change._tag === "ProjectionSnapshot" ? change.units : (projection?.units ?? []),
              checkpointGeneration: (projection?.checkpointGeneration ?? 0) + 1,
              revision: change.revision,
              state: change.state,
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            projection =
              change.checkpoint === undefined ? common : { ...common, projectorCheckpoint: change.checkpoint }
          }).pipe(
            Effect.andThen(withinTransaction ?? Effect.void),
            Effect.andThen(change.state.status === "completed" ? Deferred.succeed(projected, undefined) : Effect.void),
            Effect.as("committed" as const),
          ),
      })
      const running: ExecutionProjection.Change = {
        _tag: "ProjectionSnapshot",
        revision: 0,
        checkpoint: {
          version: ExecutionProjection.projectionVersion,
          cursor: "running",
          state: "{}",
        },
        units: [],
        hasOlder: false,
        state: state("running"),
      }
      const completed: ExecutionProjection.Change = {
        _tag: "ProjectionPatch",
        baseRevision: 0,
        revision: 1,
        checkpoint: {
          version: ExecutionProjection.projectionVersion,
          cursor: "completed",
          state: "{}",
        },
        upsert: [],
        remove: [],
        state: state("completed"),
      }
      const preview: ExecutionGateway.ModelPreviewEvent = {
        _tag: "ModelPreview",
        runId: "run-test",
        attemptFence: 1,
        turn: 0,
        modelCallId: "call-test",
        modelAttemptId: "attempt-test",
        attempt: 1,
        sequence: 0,
        changes: [{ channel: "text", offset: 0, delta: "streamed" }],
      }
      const gateway = ExecutionGateway.Service.of({
        ...Context.get(yield* Layer.build(ExecutionGateway.layerTest()), ExecutionGateway.Service),
        watchTurn: () => Stream.fromIterable([preview, running, completed]),
        inspectTurn: () => Effect.succeed({ status: "completed", cursor: "completed" }),
      })
      const context = yield* Layer.build(
        hostedProjectionWorkerLayer({
          concurrency: 2,
          fallbackIntervalMillis: 10,
        }).pipe(
          Layer.provide(hostedWorkerRuntimeLayerTest),
          Layer.provide(turns),
          Layer.provide(Layer.succeed(TranscriptRepository.Service, transcripts)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
          Layer.provide(Layer.succeed(HostedPreviewBus, previews.bus)),
          Layer.provide(
            Layer.mock(HostedThreadApplication, {
              projectionCommitted: () => Deferred.succeed(projectionPublished, undefined),
            }),
          ),
        ),
      )
      yield* Deferred.await(projected)
      yield* Deferred.await(projectionPublished)
      expect(yield* subscription.take).toEqual({
        _tag: "Preview",
        value: { threadId: HostedThreadId.make(threadId), turnId, preview },
      })
      yield* HostedProjectionWorker.pipe(
        Effect.provide(context),
        Effect.flatMap((worker) => worker.ready),
      )
      expect(projection).toMatchObject({
        revision: 1,
        state: { status: "completed" },
        projectorCheckpoint: { cursor: "completed" },
      })
    }),
  ),
)

it.effect("replays an existing transcript when its projection version is stale", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const completedTurn: Turn.AgentExecutionTurn = { ...turn, status: "completed" }
      const turns = Context.get(
        yield* Layer.build(
          Layer.mock(TurnRepository.Service, {
            get: () => Effect.succeed(completedTurn),
          }),
        ),
        TurnRepository.Service,
      )
      const stale: Projection = {
        turn: completedTurn,
        units: [],
        checkpointGeneration: 1,
        revision: 99,
        state: state("completed"),
        projectionVersion: ExecutionProjection.projectionVersion - 1,
      }
      const memory = yield* TranscriptRepository.makeMemory({ initial: [stale], turns })
      const projected = yield* Deferred.make<void>()
      const transcripts = TranscriptRepository.Service.of({
        ...memory,
        commitProjection: (projectedTurn, change) =>
          memory
            .commitProjection(projectedTurn, change)
            .pipe(
              Effect.tap((result) => (result === "committed" ? Deferred.succeed(projected, undefined) : Effect.void)),
            ),
      })
      const watchInputs = new Array<Parameters<ExecutionGateway.Interface["watchTurn"]>[1]>()
      const replay: ExecutionProjection.Change = {
        _tag: "ProjectionSnapshot",
        revision: 1,
        checkpoint: {
          version: ExecutionProjection.projectionVersion,
          cursor: "replayed",
          state: "{}",
        },
        units: [],
        hasOlder: false,
        state: state("completed"),
      }
      const gateway = ExecutionGateway.makeTest({
        watchTurn: (_link, input) =>
          Stream.fromEffect(
            Effect.sync(() => {
              watchInputs.push(input)
            }),
          ).pipe(Stream.flatMap(() => Stream.succeed(replay))),
        inspectTurn: () => Effect.succeed({ status: "completed", cursor: "replayed" }),
      })
      yield* Layer.build(
        testProjectionWorkerLayer({ concurrency: 1, fallbackIntervalMillis: 10 }).pipe(
          Layer.provide(Layer.succeed(TurnRepository.Service, turns)),
          Layer.provide(Layer.succeed(TranscriptRepository.Service, transcripts)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
        ),
      )
      yield* Deferred.await(projected)

      expect(watchInputs).toHaveLength(1)
      expect(watchInputs[0]).not.toHaveProperty("checkpoint")
      expect(watchInputs[0]).not.toHaveProperty("units")
      expect(yield* memory.get(completedTurn.id)).toMatchObject({
        revision: 1,
        projectionVersion: ExecutionProjection.projectionVersion,
        projectorCheckpoint: { cursor: "replayed" },
      })
    }),
  ),
)

it.effect("does not reset active projection age when a duplicate candidate is rejected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const turns = Layer.mock(TurnRepository.Service, {
        get: () => Deferred.succeed(started, undefined).pipe(Effect.as(turn)),
      })
      const transcripts = TranscriptRepository.Service.of({
        ...Context.get(yield* Layer.build(TranscriptRepository.memoryLayer()), TranscriptRepository.Service),
        listProjectionRecoveryCandidates: () => Effect.succeed([{ threadId, turnId, createdAt: turn.createdAt }]),
        get: () => Effect.as(Effect.void, undefined),
      })
      const gateway = ExecutionGateway.Service.of({
        ...Context.get(yield* Layer.build(ExecutionGateway.layerTest()), ExecutionGateway.Service),
        watchTurn: () => Stream.never,
      })
      const context = yield* Layer.build(
        testProjectionWorkerLayer({
          concurrency: 1,
          fallbackIntervalMillis: 10,
        }).pipe(
          Layer.provide(turns),
          Layer.provide(Layer.succeed(TranscriptRepository.Service, transcripts)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
        ),
      )

      yield* Deferred.await(started)
      const worker = Context.get(context, HostedProjectionWorker)
      const admitted = yield* worker.status
      yield* TestClock.adjust(11)
      const duplicateRejected = yield* worker.status
      expect(duplicateRejected.oldestActiveAt).toBe(admitted.oldestActiveAt)
      expect(duplicateRejected.oldestActiveAgeMillis).toBe(10)
      expect(duplicateRejected).toMatchObject({
        active: 1,
        capacity: 1,
        availableCapacity: 0,
      })
      yield* worker.ready
    }),
  ),
)

it.effect("does not cancel or settle execution when projection is silent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const silentTurnId = Turn.TurnId.make("turn-silent")
      const nextTurnId = Turn.TurnId.make("turn-next")
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      const projections = new Map<Turn.TurnId, Projection>()
      const turnFor = (id: Turn.TurnId): Turn.AgentExecutionTurn => ({
        ...turn,
        id,
        executionLink: { runId: `run-${id}`, threadId, turnId: id },
      })
      const turns = Layer.mock(TurnRepository.Service, {
        get: (id: Turn.TurnId) => Effect.succeed(turnFor(id)),
        setStatus: (id: Turn.TurnId) =>
          Ref.update(events, (current) => [...current, `settled:${id}`]).pipe(Effect.as(turnFor(id))),
      })
      const transcriptRepository = Context.get(
        yield* Layer.build(TranscriptRepository.memoryLayer()),
        TranscriptRepository.Service,
      )
      const transcripts = TranscriptRepository.Service.of({
        ...transcriptRepository,
        listProjectionRecoveryCandidates: () =>
          Effect.succeed(
            [silentTurnId, nextTurnId].map((candidateTurnId) => ({
              threadId,
              turnId: candidateTurnId,
              createdAt: turn.createdAt,
            })),
          ),
        get: (id: Turn.TurnId) => Effect.sync(() => projections.get(id)),
        replaceUnits: (failed: Turn.Turn, units) =>
          Ref.update(events, (current) => [...current, `persisted:${failed.id}`]).pipe(
            Effect.andThen(transcriptRepository.replaceUnits(failed, units)),
          ),
        commitProjection: (candidateTurn: Turn.AgentExecutionTurn, change: ExecutionProjection.Change) =>
          Effect.sync(() => {
            const previous = projections.get(candidateTurn.id)
            const common = {
              turn: candidateTurn,
              units: change._tag === "ProjectionSnapshot" ? change.units : (previous?.units ?? []),
              checkpointGeneration: (previous?.checkpointGeneration ?? 0) + 1,
              revision: change.revision,
              state: change.state,
              projectionVersion: ExecutionProjection.projectionVersion,
            }
            const next: Projection =
              change.checkpoint === undefined ? common : { ...common, projectorCheckpoint: change.checkpoint }
            projections.set(candidateTurn.id, next)
            return "committed" as const
          }),
      })
      const completed: ExecutionProjection.Change = {
        _tag: "ProjectionSnapshot",
        revision: 0,
        checkpoint: {
          version: ExecutionProjection.projectionVersion,
          cursor: "completed",
          state: "{}",
        },
        units: [],
        hasOlder: false,
        state: state("completed"),
      }
      const gateway = ExecutionGateway.Service.of({
        ...Context.get(yield* Layer.build(ExecutionGateway.layerTest()), ExecutionGateway.Service),
        watchTurn: (link) =>
          Stream.fromEffect(Ref.update(events, (current) => [...current, `started:${link.turnId}`])).pipe(
            Stream.flatMap(() => (link.turnId === silentTurnId ? Stream.never : Stream.succeed(completed))),
          ),
        inspectTurn: () => Effect.succeed({ status: "completed", cursor: "completed" }),
        cancelTurn: (link) => Ref.update(events, (current) => [...current, `cancelled:${link.turnId}`]),
      })
      const context = yield* Layer.build(
        testProjectionWorkerLayer({
          concurrency: 1,
          fallbackIntervalMillis: 60_000,
        }).pipe(
          Layer.provide(turns),
          Layer.provide(Layer.succeed(TranscriptRepository.Service, transcripts)),
          Layer.provide(Layer.succeed(ExecutionGateway.Service, gateway)),
        ),
      )

      yield* TestClock.adjust(15 * 60_000)
      yield* Effect.yieldNow
      const observed = yield* Ref.get(events)
      expect(observed).not.toContain(`cancelled:${silentTurnId}`)
      expect(observed).not.toContain(`persisted:${silentTurnId}`)
      expect(observed).not.toContain(`settled:${silentTurnId}`)
      expect(observed).not.toContain(`started:${nextTurnId}`)
      expect(yield* Context.get(context, HostedProjectionWorker).status).toMatchObject({
        active: 1,
        availableCapacity: 0,
      })
    }),
  ),
)

it.effect("rejects a stale projection worker when listing blocks after a successful scan", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lists = yield* Ref.make(0)
      const blocked = yield* Deferred.make<ReadonlyArray<TranscriptRepository.ProjectionRecoveryCandidate>>()
      const transcripts = TranscriptRepository.Service.of({
        ...Context.get(yield* Layer.build(TranscriptRepository.memoryLayer()), TranscriptRepository.Service),
        listProjectionRecoveryCandidates: () =>
          Ref.getAndUpdate(lists, (count) => count + 1).pipe(
            Effect.flatMap((count) => (count === 0 ? Effect.succeed([]) : Deferred.await(blocked))),
          ),
      })
      const context = yield* Layer.build(
        testProjectionWorkerLayer({
          concurrency: 1,
          fallbackIntervalMillis: 10,
        }).pipe(
          Layer.provide(Layer.mock(TurnRepository.Service, {})),
          Layer.provide(Layer.succeed(TranscriptRepository.Service, transcripts)),
          Layer.provide(ExecutionGateway.layerTest()),
        ),
      )
      const worker = Context.get(context, HostedProjectionWorker)
      yield* Effect.yieldNow
      yield* worker.ready
      yield* TestClock.adjust(51)
      expect((yield* Effect.exit(worker.ready))._tag).toBe("Failure")
    }),
  ),
)

it.effect("rejects the current projection list failure immediately", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const transcripts = TranscriptRepository.Service.of({
        ...Context.get(yield* Layer.build(TranscriptRepository.memoryLayer()), TranscriptRepository.Service),
        listProjectionRecoveryCandidates: () => Effect.die("list unavailable"),
      })
      const context = yield* Layer.build(
        testProjectionWorkerLayer({
          concurrency: 1,
          fallbackIntervalMillis: 10,
        }).pipe(
          Layer.provide(Layer.mock(TurnRepository.Service, {})),
          Layer.provide(Layer.succeed(TranscriptRepository.Service, transcripts)),
          Layer.provide(ExecutionGateway.layerTest()),
        ),
      )
      const worker = Context.get(context, HostedProjectionWorker)
      yield* Effect.yieldNow
      expect((yield* worker.status).scan._tag).toBe("Failed")
      expect((yield* Effect.exit(worker.ready))._tag).toBe("Failure")
    }),
  ),
)
