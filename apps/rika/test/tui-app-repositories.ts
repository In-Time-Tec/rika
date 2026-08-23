import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ThreadRepository from "@rika/product-store/postgres-thread-repository"
import * as ThreadSearchRepository from "@rika/product-store/memory-thread-search-repository"
import * as ThreadSummaryRepository from "@rika/product-store/postgres-thread-summary-repository"
import * as TranscriptRepository from "@rika/product-store/postgres-transcript-repository"
import * as TurnRepository from "@rika/product-store/postgres-turn-repository"
import type * as TurnContract from "@rika/product/turn-repository"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Context, Effect, Layer } from "effect"

export interface HistoricalTranscriptFixture {
  readonly threadId: string
  readonly entryCount: number
  readonly marker: string
}

export const makeTuiAppRepositoryLayers = () => {
  const repositoryLayer = ThreadRepository.memoryLayer()
  const turnRepositoryLayer = TurnRepository.memoryLayer()
  return {
    repositoryLayer,
    turnRepositoryLayer,
    threadSearchRepositoryLayer: ThreadSearchRepository.memoryLayer,
    threadSummaryRepositoryLayer: ThreadSummaryRepository.memoryLayer.pipe(
      Layer.provide(Layer.merge(repositoryLayer, turnRepositoryLayer)),
    ),
    transcriptRepositoryLayer: TranscriptRepository.memoryLayer(),
  }
}

export type TuiAppQueue = (
  threadId: Thread.ThreadId,
) => Effect.Effect<Effect.Success<ReturnType<TurnContract.Interface["readQueue"]>>, TurnContract.RepositoryError>

export const makeTuiAppQueue = (context: Context.Context<TurnContract.Service>): TuiAppQueue => {
  const turns = Context.get(context, TurnRepository.Service)
  return (threadId) => turns.readQueue(threadId)
}

export const seedHistoricalTranscript = Effect.fn("TuiApp.seedHistoricalTranscript")(function* (
  fixture: HistoricalTranscriptFixture,
  workspace: string,
) {
  if (fixture.entryCount < 2) return yield* Effect.die("The transcript fixture requires at least two entries")
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
  const markerIndex = Math.max(0, fixture.entryCount - 400)
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
    checkpoint: { version: ExecutionProjection.projectionVersion, cursor, state: "{}" },
    units,
    hasOlder: false,
    state: {
      status: "completed",
      usage: ExecutionProjection.emptyUsageState(),
      steering: { steeringMessages: 0, followUpMessages: 0 },
    },
  })
})
