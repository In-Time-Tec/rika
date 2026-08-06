import * as ExecutionProjection from "@rika/product/execution-projection"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as ThreadSearchRepository from "@rika/product-store/sqlite-thread-search-repository"
import * as ThreadSummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Layer } from "effect"

export interface HistoricalTranscriptFixture {
  readonly threadId: string
  readonly entryCount: number
  readonly marker: string
}

export const makeTuiAppRepositoryLayers = (filename: string) => {
  const database = Database.layer(filename)
  return {
    repositoryLayer: ThreadRepository.layer.pipe(Layer.provide(database), Layer.provide(BunServices.layer)),
    turnRepositoryLayer: TurnRepository.layer.pipe(Layer.provide(database), Layer.provide(BunServices.layer)),
    threadSearchRepositoryLayer: ThreadSearchRepository.layer.pipe(
      Layer.provide(database),
      Layer.provide(BunServices.layer),
    ),
    threadSummaryRepositoryLayer: ThreadSummaryRepository.layer.pipe(
      Layer.provide(database),
      Layer.provide(BunServices.layer),
    ),
    transcriptRepositoryLayer: TranscriptRepository.layer.pipe(
      Layer.provide(database),
      Layer.provide(BunServices.layer),
    ),
  }
}

export const seedHistoricalTranscript = Effect.fn("TuiApp.seedHistoricalTranscript")(function* (
  fixture: HistoricalTranscriptFixture,
  workspace: string,
) {
  if (fixture.entryCount <= 400)
    return yield* Effect.die("The historical transcript fixture must exceed the interactive window")
  const threads = yield* ThreadRepository.Service
  const turns = yield* TurnRepository.Service
  const transcripts = yield* TranscriptRepository.Service
  const threadId = Thread.ThreadId.make(fixture.threadId)
  if ((yield* threads.get(threadId)) === undefined)
    yield* threads.create({ id: threadId, workspace, title: "Durable history", now: 1 })
  const turnId = Turn.TurnId.make(`${fixture.threadId}-history`)
  const cursor = `${fixture.threadId}-history-completed`
  const turn: Turn.AgentExecutionTurn = {
    _tag: "AgentExecution",
    id: turnId,
    threadId,
    prompt: "Historical transcript fixture",
    status: "completed",
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    createdAt: 1,
    updatedAt: 1,
  }
  yield* turns.copy(turn, 32)
  const markerIndex = fixture.entryCount - 400
  const notifications = Array.from({ length: fixture.entryCount - 2 }, (_, index): TranscriptUnit.Unit => {
    const key = `${turnId}:history:${index.toString().padStart(4, "0")}`
    return {
      key,
      turnId,
      order: TranscriptOrdering.unitOrder(key, index),
      revision: index + 1,
      content: {
        _tag: "Block",
        block: {
          _tag: "Notification",
          title: `Historical entry ${index}`,
          detail: index === markerIndex ? fixture.marker : `durable history ${index}`,
        },
      },
    }
  })
  const finalKey = `${turnId}:assistant:final`
  const finalUnit: TranscriptUnit.Unit = {
    key: finalKey,
    turnId,
    order: TranscriptOrdering.unitOrder(finalKey, fixture.entryCount - 2),
    revision: fixture.entryCount - 1,
    executionOutcome: { status: "complete" },
    content: { _tag: "Entry", role: "assistant", text: "Historical transcript complete" },
  }
  const userKey = `turn:${turnId}:user`
  const units: ReadonlyArray<TranscriptUnit.Unit> = [
    {
      key: userKey,
      turnId,
      order: TranscriptOrdering.unitOrder(userKey, -1),
      revision: 0,
      content: { _tag: "Entry", role: "user", text: turn.prompt },
    },
    ...notifications,
    finalUnit,
  ]
  yield* transcripts.commitProjection(turn, {
    _tag: "ProjectionSnapshot",
    revision: fixture.entryCount,
    checkpoint: { version: 1, cursor, state: "{}" },
    units,
    hasOlder: false,
    state: {
      status: "completed",
      usage: ExecutionProjection.emptyUsageState(),
      steering: { steeringMessages: 0, followUpMessages: 0 },
    },
  })
})
