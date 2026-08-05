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

type CollectEvents = {
  (session: InteractiveSession, events: Array<InteractiveEvent>): Effect.Effect<void>
  (events: Array<InteractiveEvent>): (session: InteractiveSession) => Effect.Effect<void>
}
function collectEventsImplementation(
  events: Array<InteractiveEvent>,
): (session: InteractiveSession) => Effect.Effect<void>
function collectEventsImplementation(session: InteractiveSession, events: Array<InteractiveEvent>): Effect.Effect<void>
function collectEventsImplementation(
  sessionOrEvents: InteractiveSession | Array<InteractiveEvent>,
  events?: Array<InteractiveEvent>,
): Effect.Effect<void> | ((session: InteractiveSession) => Effect.Effect<void>) {
  if (!("events" in sessionOrEvents)) {
    if (events !== undefined) throw new Error("Invalid event collection arguments")
    return (session) => collectEventsImplementation(session, sessionOrEvents)
  }
  if (events === undefined) throw new Error("Invalid event collection arguments")
  return Effect.forkChild(sessionOrEvents.events((event) => events.push(event))).pipe(Effect.andThen(Effect.yieldNow))
}

type WaitForSessions = {
  (sessions: Ref.Ref<ReadonlyArray<InteractiveSession>>, count?: number): Effect.Effect<void>
  (count?: number): (sessions: Ref.Ref<ReadonlyArray<InteractiveSession>>) => Effect.Effect<void>
}
function waitForSessionsImplementation(
  sessions: Ref.Ref<ReadonlyArray<InteractiveSession>>,
  count?: number,
): Effect.Effect<void>
function waitForSessionsImplementation(
  count?: number,
): (sessions: Ref.Ref<ReadonlyArray<InteractiveSession>>) => Effect.Effect<void>
function waitForSessionsImplementation(
  sessionsOrCount?: Ref.Ref<ReadonlyArray<InteractiveSession>> | number,
  count?: number,
): Effect.Effect<void> | ((sessions: Ref.Ref<ReadonlyArray<InteractiveSession>>) => Effect.Effect<void>) {
  if (sessionsOrCount === undefined) return (sessions) => waitForSessionsImplementation(sessions, 1)
  if (typeof sessionsOrCount === "number") return (sessions) => waitForSessionsImplementation(sessions, sessionsOrCount)
  return Effect.gen(function* () {
    while ((yield* Ref.get(sessionsOrCount)).length < (count ?? 1)) yield* Effect.yieldNow
  })
}

type Thread = {
  (id: string, updatedAt: number): RuntimeFixtures.Thread.Thread
  (updatedAt: number): (id: string) => RuntimeFixtures.Thread.Thread
}
function threadImplementation(updatedAt: number): (id: string) => RuntimeFixtures.Thread.Thread
function threadImplementation(id: string, updatedAt: number): RuntimeFixtures.Thread.Thread
function threadImplementation(
  idOrUpdatedAt: string | number,
  updatedAt?: number,
): RuntimeFixtures.Thread.Thread | ((id: string) => RuntimeFixtures.Thread.Thread) {
  if (typeof idOrUpdatedAt === "number") return (id) => threadImplementation(id, idOrUpdatedAt)
  if (updatedAt === undefined) throw new Error("Invalid thread arguments")
  const id = idOrUpdatedAt
  return {
    id: RuntimeFixtures.Thread.ThreadId.make(id),
    workspace: "/work",
    title: id,
    labels: [],
    pinned: false,
    archived: false,
    lineage: { _tag: "Original" },
    createdAt: updatedAt,
    updatedAt,
  }
}

type Active = {
  (threadId: RuntimeFixtures.Thread.ThreadId, id?: string): RuntimeFixtures.Turn.AgentExecutionTurn
  (id?: string): (threadId: RuntimeFixtures.Thread.ThreadId) => RuntimeFixtures.Turn.AgentExecutionTurn
}

const makeActive = (
  threadId: RuntimeFixtures.Thread.ThreadId,
  id: string,
): RuntimeFixtures.Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: RuntimeFixtures.Turn.TurnId.make(id),
  threadId,
  prompt: "active prompt",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: executionRoute(),
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  executionLink: { runId: "fixture-active-run", turnId: id, threadId: String(threadId) },
})

function activeImplementation(
  threadId: RuntimeFixtures.Thread.ThreadId,
  id?: string,
): RuntimeFixtures.Turn.AgentExecutionTurn
function activeImplementation(
  id?: string,
): (threadId: RuntimeFixtures.Thread.ThreadId) => RuntimeFixtures.Turn.AgentExecutionTurn
function activeImplementation(
  threadIdOrId?: RuntimeFixtures.Thread.ThreadId | string,
  id = "active",
):
  | RuntimeFixtures.Turn.AgentExecutionTurn
  | ((threadId: RuntimeFixtures.Thread.ThreadId) => RuntimeFixtures.Turn.AgentExecutionTurn) {
  if (threadIdOrId === undefined) return (threadId) => makeActive(threadId, id)
  return makeActive(RuntimeFixtures.Thread.ThreadId.make(threadIdOrId), id)
}

export const collectEvents: CollectEvents = collectEventsImplementation
export const waitForSessions: WaitForSessions = waitForSessionsImplementation
export const thread: Thread = threadImplementation
export const active: Active = activeImplementation

export const serverEvents = (
  events: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event>,
): ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> =>
  events.map((event) => ({ ...event, timestampSource: "baton" as const }))

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
      timestampSource: "baton",
    },
    ...stamped.map((event, index) => Object.assign({}, event, { sequence: index + 1 })),
  ]
}
