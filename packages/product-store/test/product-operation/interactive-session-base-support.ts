import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { productLayer as makeProductLayer } from "@rika/product/product-operation-service"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { Effect, Layer, Ref } from "effect"
type ProductLayerOptions = Parameters<typeof makeProductLayer>[0]
export const projectionVersion = 4

import { executionRoute } from "../support/product-test-current-state"

export const productLayer = (options: ProductLayerOptions): ReturnType<typeof makeProductLayer> =>
  makeProductLayer({
    ...options,
    threadSummaryRepositoryLayer:
      options.threadSummaryRepositoryLayer ??
      RuntimeFixtures.SummaryRepository.memoryLayer.pipe(
        Layer.provide(Layer.merge(options.repositoryLayer, options.turnRepositoryLayer)),
        Layer.orDie,
      ),
    transcriptRepositoryLayer:
      options.transcriptRepositoryLayer ??
      RuntimeFixtures.TranscriptRepository.memoryLayerWithTurns.pipe(
        Layer.provide(options.turnRepositoryLayer),
        Layer.orDie,
      ),
    usageRepositoryLayer: options.usageRepositoryLayer ?? RuntimeFixtures.UsageRepository.memoryLayer.pipe(Layer.orDie),
  })

export const collectEvents = (session: InteractiveSession, events: Array<InteractiveEvent>) =>
  Effect.forkChild(session.events((event) => events.push(event))).pipe(Effect.andThen(Effect.yieldNow))

export const waitForSessions = (sessions: Ref.Ref<ReadonlyArray<InteractiveSession>>, count = 1) =>
  Effect.gen(function* () {
    while ((yield* Ref.get(sessions)).length < count) yield* Effect.yieldNow
  })

export const thread = (id: string, updatedAt: number): RuntimeFixtures.Thread.Thread => ({
  id: RuntimeFixtures.Thread.ThreadId.make(id),
  workspace: "/work",
  title: id,
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: updatedAt,
  updatedAt,
})

export const active = (
  threadId: RuntimeFixtures.Thread.ThreadId,
  id = "active",
): RuntimeFixtures.Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: RuntimeFixtures.Turn.TurnId.make(id),
  threadId,
  prompt: "active prompt",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: executionRoute(),
  status: "running",
  stopIntent: "none",
  createdAt: 1,
  updatedAt: 1,
  lastCursor: "active-cursor",
})

export const serverEvents = (
  events: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event>,
): ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> =>
  events.map((event) => ({ ...event, timestampSource: "server" as const }))

export const completeServerTimeline = (
  events: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event>,
): ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> => {
  if (events.length === 0) return events
  const stamped = serverEvents(events)
  if (stamped.some((event) => event.type === "execution.started" || event.type === "execution.accepted")) return stamped
  const first = stamped[0]!
  return [
    {
      executionId: first.executionId,
      cursor: `${first.executionId}:started`,
      sequence: 0,
      type: "execution.started",
      createdAt: first.createdAt - 1,
      timestampSource: "server",
    },
    ...stamped.map((event, index) => Object.assign({}, event, { sequence: index + 1 })),
  ]
}
