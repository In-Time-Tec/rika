import * as BunServices from "@effect/platform-bun/BunServices"
import * as Database from "@rika/product-store/product-database-layer"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as TranscriptUnitOrder from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Context, Effect, FileSystem, Layer, Scope, pipe } from "effect"
import type { BenchMeasurement } from "./benchmark-measurement"
import { cpuSample, summarizeLatencies } from "./benchmark-statistics"

const cpuElapsedSeconds = (before: ReturnType<typeof cpuSample>, after: ReturnType<typeof cpuSample>): number =>
  (after.userMicros - before.userMicros + after.systemMicros - before.systemMicros) / 1_000_000

interface MonotonicClockShape {
  readonly now: () => bigint
}

export class MonotonicClock extends Context.Service<MonotonicClock, MonotonicClockShape>()(
  "rika/scripts/benchmark/fold-persistence-benchmark/MonotonicClock",
) {}

const monotonicMillis = (start: bigint, end: bigint): number => Number(end - start) / 1_000_000

export const defaultEventCount = 50_000
export const defaultCommitBatch = 64
const debounceWindowMs = 1
const debounceBurst = 32

type RepositoryServices = ThreadRepository.Service | TurnRepository.Service | TranscriptRepository.Service

type BenchRuntimeServices = BunServices.BunServices | MonotonicClock | Scope.Scope
type BenchServices = BenchRuntimeServices | RepositoryServices

const sqliteLayer = (filename: string): Layer.Layer<RepositoryServices, never, BunServices.BunServices> => {
  const database = Database.layer(filename).pipe(Layer.provide(BunServices.layer), Layer.orDie)
  return pipe(
    Layer.mergeAll(ThreadRepository.layer, TurnRepository.layer, TranscriptRepository.layer),
    Layer.provide(database),
    Layer.orDie,
  )
}

const projectionState = (
  status: ExecutionProjection.ProjectionState["status"] = "running",
): ExecutionProjection.ProjectionState => ({
  status,
  usage: ExecutionProjection.emptyUsageState(),
  steering: { steeringMessages: 0, followUpMessages: 0 },
})

const checkpoint = (revision: number): ExecutionProjection.Checkpoint => ({
  version: ExecutionProjection.projectionVersion,
  cursor: `bench-${revision}`,
  state: "{}",
})

const answerUnit = (turnId: string, sequence: number): TranscriptUnit.Unit => ({
  key: `assistant:bench:${sequence}`,
  turnId,
  order: TranscriptUnitOrder.unitOrder(`assistant:bench:${sequence}`, sequence),
  revision: sequence,
  content: { _tag: "Entry", role: "assistant", text: "x".repeat(16) },
})

const prepareTurn = (
  threadId: Thread.ThreadId,
  turnId: Turn.TurnId,
  prompt: string,
): Effect.Effect<Turn.AgentExecutionTurn, never, RepositoryServices> =>
  Effect.gen(function* () {
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
    if (turn._tag !== "AgentExecution") return yield* Effect.die("bench seed turn is not an Agent execution")
    const committed = yield* transcripts.commitProjection(turn, {
      _tag: "ProjectionSnapshot",
      revision: 0,
      checkpoint: checkpoint(0),
      units: [],
      hasOlder: false,
      state: projectionState(),
    })
    if (committed !== "committed") return yield* Effect.die("bench seed projection was not committed")
    return turn
  }).pipe(Effect.orDie)

const commitPatch = (
  turn: Turn.AgentExecutionTurn,
  baseRevision: number,
  revision: number,
  upsert: ReadonlyArray<TranscriptUnit.Unit>,
): Effect.Effect<void, never, TranscriptRepository.Service> =>
  Effect.gen(function* () {
    const transcripts = yield* TranscriptRepository.Service
    const result = yield* transcripts.commitProjection(turn, {
      _tag: "ProjectionPatch",
      baseRevision,
      revision,
      checkpoint: checkpoint(revision),
      upsert,
      remove: [],
      state: projectionState(),
    })
    if (result !== "committed") return yield* Effect.die("bench commit returned stale")
  }).pipe(Effect.orDie)

const measureDebounceCommits = (
  turn: Turn.AgentExecutionTurn,
  startRevision: number,
): Effect.Effect<{ readonly latencies: ReadonlyArray<number>; readonly nextRevision: number }, never, BenchServices> =>
  Effect.gen(function* () {
    let revision = startRevision
    const clock = yield* MonotonicClock
    const latencies: Array<number> = []
    for (let burst = 0; burst < 8; burst += 1) {
      const upsert = new Map<string, TranscriptUnit.Unit>()
      for (let index = 0; index < debounceBurst; index += 1) {
        const unit = answerUnit(String(turn.id), revision + index + 1)
        upsert.set(unit.key, unit)
      }
      const baseRevision = revision
      revision += debounceBurst
      yield* Effect.sleep(`${debounceWindowMs} millis`)
      const commitStart = clock.now()
      yield* commitPatch(turn, baseRevision, revision, [...upsert.values()])
      latencies.push(monotonicMillis(commitStart, clock.now()))
    }
    return { latencies, nextRevision: revision }
  }).pipe(Effect.orDie)

export const runFoldPersistenceBench = (options: {
  readonly eventCount?: number
  readonly commitBatch?: number
}): Effect.Effect<
  { readonly measurement: BenchMeasurement; readonly dataRoot: string; readonly foldEventsPerSec: number },
  never,
  BenchRuntimeServices
> =>
  Effect.gen(function* () {
    const clock = yield* MonotonicClock
    const eventCount = options.eventCount ?? defaultEventCount
    const batchSize = options.commitBatch ?? defaultCommitBatch
    const fileSystem = yield* FileSystem.FileSystem
    const directory = yield* fileSystem.makeTempDirectory({ prefix: "rika-bench-" })
    const filename = `${directory}/rika.db`
    const scope = yield* Effect.scope
    const context: Context.Context<RepositoryServices> = yield* pipe(
      sqliteLayer(filename),
      (layer) => Layer.buildWithScope(layer, scope),
      Effect.orDie,
    )
    return yield* Effect.gen(function* () {
      const threadId = Thread.ThreadId.make("bench-thread")
      const turnId = Turn.TurnId.make("bench-turn")
      const turn = yield* prepareTurn(threadId, turnId, "bench prompt")
      const commitLatencies: Array<number> = []
      let foldCpuSeconds = 0
      let persistCpuSeconds = 0
      let pendingUpsert = new Map<string, TranscriptUnit.Unit>()
      let committedRevision = 0
      const foldWallStart = clock.now()
      const wallStart = clock.now()
      const totalCpuStart = cpuSample()
      for (let sequence = 1; sequence <= eventCount; sequence += 1) {
        const foldStart = cpuSample()
        const unit = answerUnit(String(turnId), sequence)
        foldCpuSeconds += cpuElapsedSeconds(foldStart, cpuSample())
        pendingUpsert.set(unit.key, unit)
        if (sequence % batchSize !== 0 && sequence !== eventCount) continue
        const persistStart = cpuSample()
        const commitStart = clock.now()
        yield* commitPatch(turn, committedRevision, sequence, [...pendingUpsert.values()])
        committedRevision = sequence
        commitLatencies.push(monotonicMillis(commitStart, clock.now()))
        persistCpuSeconds += cpuElapsedSeconds(persistStart, cpuSample())
        pendingUpsert = new Map()
      }
      const foldWallSeconds = monotonicMillis(foldWallStart, clock.now()) / 1000
      const stored = yield* TranscriptRepository.Service.pipe(Effect.flatMap((repository) => repository.get(turnId)))
      if (stored === undefined || stored.revision !== eventCount)
        return yield* Effect.die(`bench projection revision mismatch: ${stored?.revision ?? "missing"}`)
      const debounce = yield* measureDebounceCommits(turn, eventCount)
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
    }).pipe(Effect.provide(context), Effect.orDie)
  }).pipe(Effect.orDie)
