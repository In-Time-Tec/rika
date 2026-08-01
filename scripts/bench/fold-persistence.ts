import * as TranscriptPage from "@rika/product/transcript-page"
import * as Database from "../../packages/product-store/src/product-database"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "../../packages/product-store/src/thread-repository"
import * as TranscriptRepository from "../../packages/product-store/src/transcript-repository"
import * as TurnRepository from "../../packages/product-store/src/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { projectionVersion } from "../../packages/product/src/execution-ingest"
import { Context, Effect, FileSystem, Layer } from "effect"
import type { BenchMeasurement } from "./baseline"
import { cpuSample, summarizeLatencies } from "./stats"

const cpuElapsedSeconds = (before: ReturnType<typeof cpuSample>, after: ReturnType<typeof cpuSample>): number =>
  (after.userMicros - before.userMicros + after.systemMicros - before.systemMicros) / 1_000_000

interface MonotonicClockShape {
  readonly now: () => bigint
}

export class MonotonicClock extends Context.Service<MonotonicClock, MonotonicClockShape>()(
  "rika/scripts/bench/fold-persistence/MonotonicClock",
) {}

const monotonicMillis = (start: bigint, end: bigint): number => Number(end - start) / 1_000_000

export const defaultEventCount = 50_000
export const defaultCommitBatch = 64
const debounceWindowMs = 1
const debounceBurst = 32

const sqliteLayer = (filename: string) => {
  const database = Database.layer(filename)
  return Layer.mergeAll(ThreadRepository.layer, TurnRepository.layer, TranscriptRepository.layer).pipe(
    Layer.provide(database),
  )
}

const preparedEvent = (): TranscriptSourceEvent.SourceEvent => ({
  cursor: "bench-0",
  sequence: 0,
  type: "model.input.prepared",
  createdAt: 0,
})

const deltaEvent = (sequence: number): TranscriptSourceEvent.SourceEvent => ({
  cursor: `bench-${sequence}`,
  sequence,
  type: "model.output.delta",
  createdAt: sequence,
  data: { model_call_id: "bench-call", model_attempt_id: "bench-attempt", transient_index: sequence, delta: "x" },
  text: "x",
})

const completeEvent = (sequence: number): TranscriptSourceEvent.SourceEvent => ({
  cursor: `bench-${sequence}`,
  sequence,
  type: "model.output.completed",
  createdAt: sequence,
  text: "x",
})

const executionCheckpoint = (
  turn: Turn.AgentExecutionTurn,
  state: TranscriptProjectionModel.ProjectionState,
): TranscriptPage.ExecutionCheckpoint => ({
  executionKey: TranscriptCorrelation.executionKey(String(turn.id)),
  executionId: String(turn.id),
  cursor: state.checkpointCursor ?? "",
  sequence: state.revision,
  state,
})

const prepareTurn = Effect.fn("Bench.prepareTurn")(function* (
  threadId: Thread.ThreadId,
  turnId: Turn.TurnId,
  prompt: string,
) {
  const threads = yield* ThreadRepository.Service
  const turns = yield* TurnRepository.Service
  const transcripts = yield* TranscriptRepository.Service
  if ((yield* threads.get(threadId)) === undefined)
    yield* threads.create({ id: threadId, workspace: `/bench/${threadId}`, title: "bench", now: 1 })
  yield* turns.createForSubmission({
    id: turnId,
    threadId,
    prompt,
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    queueCapacity: 128,
    now: 2,
  })
  const turn = yield* turns.setStatus(turnId, "running", undefined, 3)
  const empty = TranscriptProjection.Projection.empty(turnId, prompt)
  const committed = yield* transcripts.commitDelta(
    turn,
    TranscriptProjection.Projection.projectionState(empty),
    { upsert: empty.units, remove: [] },
    {
      executionCheckpoints: [executionCheckpoint(turn, TranscriptProjection.Projection.projectionState(empty))],
      projectionVersion,
      expectedGeneration: undefined,
    },
  )
  if (committed !== "committed") return yield* Effect.die("bench seed projection was not committed")
  const stored = yield* transcripts.get(turnId)
  return { turn, generation: stored?.checkpointGeneration }
})

const commitBatch = Effect.fn("Bench.commitBatch")(function* (
  turn: Turn.AgentExecutionTurn,
  fold: TranscriptProjection.ProjectionFold,
  upsert: ReadonlyArray<TranscriptUnit.Unit>,
  remove: ReadonlyArray<string>,
  expectedGeneration: number | undefined,
) {
  const transcripts = yield* TranscriptRepository.Service
  const state = TranscriptProjection.Fold.snapshotFoldState(fold)
  const result = yield* transcripts.commitDelta(
    turn,
    state,
    { upsert, remove },
    {
      executionCheckpoints: [executionCheckpoint(turn, state)],
      projectionVersion,
      expectedGeneration,
    },
  )
  if (result !== "committed") return yield* Effect.die("bench commit returned stale")
  return expectedGeneration === undefined ? 0 : expectedGeneration + 1
})

const measureDebounceCommits = Effect.fn("Bench.measureDebounceCommits")(function* (
  turn: Turn.AgentExecutionTurn,
  fold: TranscriptProjection.ProjectionFold,
  startSequence: number,
  generation: number | undefined,
) {
  let sequence = startSequence
  let expectedGeneration = generation
  const clock = yield* MonotonicClock
  const latencies: Array<number> = []
  for (let burst = 0; burst < 8; burst += 1) {
    const upsert = new Map<string, TranscriptUnit.Unit>()
    const remove = new Set<string>()
    for (let index = 0; index < debounceBurst; index += 1) {
      sequence += 1
      const mutation = TranscriptProjection.Fold.applyFoldEvent(fold, deltaEvent(sequence))
      for (const unit of mutation.units.upsert) {
        upsert.set(unit.key, unit)
        remove.delete(unit.key)
      }
      for (const key of mutation.units.remove) {
        remove.add(key)
        upsert.delete(key)
      }
    }
    sequence += 1
    const completion = TranscriptProjection.Fold.applyFoldEvent(fold, completeEvent(sequence))
    for (const unit of completion.units.upsert) {
      upsert.set(unit.key, unit)
      remove.delete(unit.key)
    }
    for (const key of completion.units.remove) remove.add(key)
    yield* Effect.sleep(`${debounceWindowMs} millis`)
    const commitStart = clock.now()
    expectedGeneration = yield* commitBatch(turn, fold, [...upsert.values()], [...remove], expectedGeneration)
    latencies.push(monotonicMillis(commitStart, clock.now()))
  }
  return { latencies, nextSequence: sequence, generation: expectedGeneration }
})

export const runFoldPersistenceBench = Effect.fn("Bench.runFoldPersistenceBench")(function* (options: {
  readonly eventCount?: number
  readonly commitBatch?: number
}) {
  const clock = yield* MonotonicClock
  const eventCount = options.eventCount ?? defaultEventCount
  const batchSize = options.commitBatch ?? defaultCommitBatch
  const streamEvent = (sequence: number): TranscriptSourceEvent.SourceEvent =>
    sequence % batchSize === 0 || sequence === eventCount ? completeEvent(sequence) : deltaEvent(sequence)
  const fileSystem = yield* FileSystem.FileSystem
  const directory = yield* fileSystem.makeTempDirectory({ prefix: "rika-bench-" })
  const filename = `${directory}/rika.db`
  const context: Context.Context<ThreadRepository.Service | TurnRepository.Service | TranscriptRepository.Service> =
    yield* Layer.build(sqliteLayer(filename))
  return yield* Effect.gen(function* () {
    const threadId = Thread.ThreadId.make("bench-thread")
    const turnId = Turn.TurnId.make("bench-turn")
    const seeded = yield* prepareTurn(threadId, turnId, "bench prompt")
    const turn = seeded.turn
    let expectedGeneration = seeded.generation
    const fold = TranscriptProjection.Fold.makeProjectionFold(String(turnId), turn.prompt)
    TranscriptProjection.Fold.applyFoldEvent(fold, preparedEvent())
    const commitLatencies: Array<number> = []
    let foldCpuSeconds = 0
    let persistCpuSeconds = 0
    let pendingUpsert = new Map<string, TranscriptUnit.Unit>()
    let pendingRemove = new Set<string>()
    const foldWallStart = clock.now()
    const wallStart = clock.now()
    const totalCpuStart = cpuSample()
    for (let sequence = 1; sequence <= eventCount; sequence += 1) {
      const foldStart = cpuSample()
      const mutation = TranscriptProjection.Fold.applyFoldEvent(fold, streamEvent(sequence))
      foldCpuSeconds += cpuElapsedSeconds(foldStart, cpuSample())
      for (const unit of mutation.units.upsert) {
        pendingUpsert.set(unit.key, unit)
        pendingRemove.delete(unit.key)
      }
      for (const key of mutation.units.remove) {
        pendingRemove.add(key)
        pendingUpsert.delete(key)
      }
      if (sequence % batchSize !== 0 && sequence !== eventCount) continue
      const persistStart = cpuSample()
      const commitStart = clock.now()
      expectedGeneration = yield* commitBatch(
        turn,
        fold,
        [...pendingUpsert.values()],
        [...pendingRemove],
        expectedGeneration,
      )
      commitLatencies.push(monotonicMillis(commitStart, clock.now()))
      persistCpuSeconds += cpuElapsedSeconds(persistStart, cpuSample())
      pendingUpsert = new Map()
      pendingRemove = new Set()
    }
    const foldWallSeconds = monotonicMillis(foldWallStart, clock.now()) / 1000
    const stored = yield* TranscriptRepository.Service.pipe(Effect.flatMap((repository) => repository.get(turnId)))
    if (stored === undefined || stored.revision !== eventCount)
      return yield* Effect.die(`bench projection revision mismatch: ${stored?.revision ?? "missing"}`)
    const debounce = yield* measureDebounceCommits(turn, fold, eventCount, stored.checkpointGeneration)
    const debounceSummary = summarizeLatencies(debounce.latencies)
    const wallEnd = clock.now()
    const totalCpuEnd = cpuSample()
    const wallSeconds = monotonicMillis(wallStart, wallEnd) / 1000
    const commitSummary = summarizeLatencies(commitLatencies)
    const measurement: BenchMeasurement = {
      eventCount,
      commitBatch: batchSize,
      wallSeconds,
      eventsPerSec: eventCount / wallSeconds,
      foldCpuSeconds,
      persistCpuSeconds,
      totalCpuSeconds: cpuElapsedSeconds(totalCpuStart, totalCpuEnd),
      commitLatencyMsP50: commitSummary.p50,
      commitLatencyMsP99: commitSummary.p99,
      debounceCommitLatencyMsP50: debounceSummary.p50,
    }
    return { measurement, dataRoot: directory, foldEventsPerSec: eventCount / foldWallSeconds }
  }).pipe(Effect.provide(context))
})
