import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Service } from "@rika/product/product-operation-service"
import { productLayer } from "@rika/product/product-operation-service"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as TurnContract from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as UsageRepository from "@rika/product-store/sqlite-usage-repository"
import * as SummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as TranscriptIdentity from "@rika/transcript/transcript-unit-identity"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { expect } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref, Schema, Scope } from "effect"
import {
  ExecutionIngest,
  executeInteractiveCommand,
  InteractiveEventSchema,
} from "@rika/product/product-operation-service"
import * as UsageCost from "@rika/product/usage-projection"
import { invalidatedProjection, storeProjection } from "../support/product-test-transcript-fixture"

export const baseBackend = ExecutionBackend.Service.of({
  invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
  createFanOut: () => Effect.die("unused"),
  inspectFanOut: () => Effect.die("unused"),
  cancelFanOut: () => Effect.die("unused"),
  registerWorkflows: () => Effect.die("unused"),
  startWorkflow: () => Effect.die("unused"),
  inspectWorkflow: () => Effect.die("unused"),
  cancelWorkflow: () => Effect.die("unused"),
  start: (input) => Effect.succeed({ turnId: input.turnId, status: "completed", events: [] }),
  replay: (turnId) => Effect.succeed({ turnId, status: "completed", events: [] }),
  cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
  inspect: () => Effect.void.pipe(Effect.as(undefined)),
  steer: (turnId) => Effect.succeed({ steeringMessageId: `steering:${turnId}:steering:0`, sequence: 0 }),
  resolveInvocationSource: () => Effect.die("unused"),
})

export const thread = (id: string): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: "/work",
  title: id,
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
})

export const providerCostEvent = (
  executionId: string,
  cursor: string,
  amount: number,
  sequence = 0,
): ExecutionBackend.Event => ({
  executionId,
  cursor,
  sequence,
  type: "model.attempt.completed",
  createdAt: 1,
  data: { model_attempt_id: `${cursor}-attempt`, cost: { amount, currency: "USD" } },
})

export const interactiveLayer: (
  repository: ThreadRepository.Interface,
  turns: TurnContract.Interface,
  backend: ExecutionBackend.Interface,
  registration: Deferred.Deferred<InteractiveSession>,
  makeThreadId?: Effect.Effect<Thread.ThreadId>,
  makeTurnId?: Effect.Effect<Turn.TurnId>,
  transcripts?: TranscriptRepository.Interface,
  usage?: UsageRepository.Interface,
) => Layer.Layer<Service, object, never> = (
  repository,
  turns,
  backend,
  registration,
  makeThreadId = Effect.die("unused"),
  makeTurnId = Effect.die("unused"),
  transcripts,
  usage,
) =>
  productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    threadSummaryRepositoryLayer: SummaryRepository.memoryLayer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(ThreadRepository.Service, repository), Layer.succeed(TurnRepository.Service, turns)),
      ),
    ),
    transcriptRepositoryLayer:
      transcripts === undefined
        ? TranscriptRepository.memoryLayerWithTurns.pipe(Layer.provide(Layer.succeed(TurnRepository.Service, turns)))
        : Layer.succeed(TranscriptRepository.Service, transcripts),
    usageRepositoryLayer:
      usage === undefined ? UsageRepository.memoryLayer : Layer.succeed(UsageRepository.Service, usage),
    backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
    defaultWorkspace: "/work",
    makeThreadId,
    makeTurnId,
    interactive: (_, session) => Deferred.succeed(registration, session).pipe(Effect.andThen(Effect.never)),
  })

export const awaitCondition = (condition: Effect.Effect<boolean>, attempts = 50_000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (yield* condition) return true
      yield* Effect.yieldNow
    }
    return false
  })

export const settle = (attempts = 500) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) yield* Effect.yieldNow
  })

export const terminalTransitionScenario = (
  inspectedStatus: "failed" | "cancelled",
  pagedHistory: boolean,
  oversizedProjection: boolean = false,
): Effect.Effect<void, object, Scope.Scope> =>
  Effect.scoped(
    Effect.gen(function* () {
      const selected = thread(`terminal-${inspectedStatus}-${pagedHistory ? "paged" : "single"}`)
      const target: Turn.Turn = {
        _tag: "AgentExecution",
        id: Turn.TurnId.make(`turn-${selected.id}`),
        threadId: selected.id,
        prompt: "terminal transition",
        stopIntent: "none",
        author: { _tag: "Human" },
        lineage: { _tag: "Original" },
        executionRoute: Turn.testExecutionRoute(),
        status: oversizedProjection ? inspectedStatus : "completed",
        lastCursor: "terminal-cursor",
        createdAt: 1,
        updatedAt: 1,
      }
      const repository = yield* ThreadRepository.makeMemory([selected])
      const turns = yield* TurnRepository.makeMemory([target])
      const stale = oversizedProjection
        ? {
            ...TranscriptProjection.Projection.empty(target.id, target.prompt),
            units: [
              {
                key: `turn:${target.id}:user`,
                turnId: target.id,
                order: TranscriptOrdering.unitOrder(`turn:${target.id}:user`, -1),
                revision: 0,
                content: { _tag: "Entry" as const, role: "user" as const, text: target.prompt },
              },
              {
                key: `${target.id}:assistant:opening`,
                turnId: target.id,
                order: TranscriptOrdering.unitOrder(`${target.id}:assistant:opening`, 1),
                revision: 1,
                content: { _tag: "Entry" as const, role: "assistant" as const, text: "opening response" },
              },
              ...Array.from(
                { length: 220 },
                (_, index): TranscriptUnit.Unit => ({
                  key: `${target.id}:nested:${index.toString().padStart(3, "0")}`,
                  turnId: target.id,
                  order: TranscriptOrdering.unitOrder(
                    `${target.id}:nested:${index.toString().padStart(3, "0")}`,
                    index + 2,
                  ),
                  revision: index + 2,
                  content: {
                    _tag: "Block",
                    block: { _tag: "Notification", title: String(index), detail: "x".repeat(40_000) },
                  },
                }),
              ),
              {
                key: `${target.id}:assistant:final`,
                turnId: target.id,
                order: TranscriptOrdering.unitOrder(`${target.id}:assistant:final`, 222),
                revision: 222,
                content: { _tag: "Entry" as const, role: "assistant" as const, text: "final response" },
              },
            ],
            revision: 222,
            checkpointCursor: "terminal-cursor",
          }
        : TranscriptProjection.Projection.project(target.id, target.prompt, [
            {
              cursor: "terminal-cursor",
              sequence: 1,
              type: "execution.completed",
              createdAt: 1,
            },
          ])
      const transcripts = oversizedProjection
        ? yield* TranscriptRepository.makeMemory({ turns })
        : yield* TranscriptRepository.makeMemory({
            initial: [invalidatedProjection(target, stale.revision)],
            turns,
          })
      if (oversizedProjection)
        yield* storeProjection(transcripts, target, stale, {
          consumed: { [String(target.id)]: { cursor: "terminal-cursor", sequence: 222, status: inspectedStatus } },
          projectionVersion: ExecutionIngest.projectionVersion,
        })
      const pageCount = pagedHistory ? 34 : 2
      const replayEvents: ReadonlyArray<ExecutionBackend.Event> = Array.from({ length: pageCount }, (_, index) => {
        const terminal = index === pageCount - 1
        let type: ExecutionBackend.Event["type"]
        if (terminal) {
          type = `execution.${inspectedStatus}` as const
        } else if (index === 0) {
          type = "execution.started"
        } else {
          type = "model.output.delta"
        }
        return {
          executionId: String(target.id),
          cursor: terminal ? "terminal-cursor" : `cursor-${index}`,
          sequence: index + 1,
          type,
          createdAt: index + 1,
          ...(index === 0 || terminal ? { timestampSource: "server" } : {}),
          ...(!terminal && index > 0 ? { text: "history" } : {}),
          ...(terminal && inspectedStatus === "failed" ? { text: "durable failure" } : {}),
        }
      })
      const backend = ExecutionBackend.Service.of({
        ...baseBackend,
        inspect: (executionId) =>
          Effect.succeed({
            turnId: executionId,
            status: inspectedStatus,
            lastCursor: "terminal-cursor",
            waits: [],
            pendingTools: [],
            children: [],
          }),
        replay: (executionId) => Effect.succeed({ turnId: executionId, status: inspectedStatus, events: replayEvents }),
        pageEvents: (_executionId, _direction, cursor) => {
          const index = cursor === undefined ? 0 : replayEvents.findIndex((event) => event.cursor === cursor) + 1
          const event = replayEvents[index]
          return Effect.succeed({
            events: event === undefined ? [] : [event],
            hasMore: index < replayEvents.length - 1,
            ...(event === undefined ? {} : { oldestCursor: event.cursor, newestCursor: event.cursor }),
          })
        },
      })
      const registration = yield* Deferred.make<InteractiveSession>()
      const context = yield* Layer.build(
        interactiveLayer(
          repository,
          turns,
          backend,
          registration,
          Effect.die("unused"),
          Effect.die("unused"),
          transcripts,
        ),
      )
      const operation = Context.get(context, Service)
      const operationFiber = yield* Effect.forkChild(
        operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
      )
      const session = yield* Deferred.await(registration)
      const events = yield* Queue.unbounded<InteractiveEvent>()
      const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

      yield* session.selectThread(selected.id, 1)
      let selectedEvent: Extract<InteractiveEvent, { readonly _tag: "SelectionLoaded" }> | undefined
      let refoldStopped = false
      let refoldStarted = false
      let refoldFinished = false
      while (true) {
        const event = yield* Queue.take(events)
        if (event._tag === "ExecutionFailed") return yield* Effect.die(event.message)
        if (event._tag === "SelectionLoaded") selectedEvent = event
        if (event._tag === "TranscriptProjectionStopped" && event.rootTurnId === target.id) refoldStopped = true
        if (event._tag === "ThreadRefolding" && event.threadId === selected.id) {
          if (event.refolding) refoldStarted = true
          else if (refoldStarted) refoldFinished = true
        }
        if (
          selectedEvent !== undefined &&
          (oversizedProjection ? selectedEvent.entries.length > 0 : refoldStopped || refoldFinished)
        )
          break
      }
      if (selectedEvent === undefined) return yield* Effect.die("selection was not loaded")
      const loadedPages = [oversizedProjection ? selectedEvent.entries : []]
      if (oversizedProjection) {
        if (selectedEvent._tag !== "SelectionLoaded") return yield* Effect.die("oversized selection was not loaded")
        expect(selectedEvent.hasOlder).toBe(true)
        expect(selectedEvent.entries.some((entry) => entry.unit.key === `${target.id}:assistant:final`)).toBe(true)
        const encodedSelection = yield* Schema.encodeEffect(InteractiveEventSchema)(selectedEvent)
        const selectionWire = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(encodedSelection)
        expect(new TextEncoder().encode(selectionWire).byteLength).toBeLessThan(8 * 1024 * 1024)
        let hasOlder = selectedEvent.hasOlder
        let before = selectedEvent.oldestCursor
        for (let page = 0; page < 10 && hasOlder; page += 1) {
          if (before === undefined) return yield* Effect.die("missing selection transcript cursor")
          yield* session.loadOlder(
            selected.id,
            1,
            before,
            loadedPages.flat().map((entry) => entry.unit.key),
          )
          let prepended = yield* Queue.take(events)
          while (prepended._tag !== "TranscriptPagePrepended") prepended = yield* Queue.take(events)
          loadedPages.push(prepended.entries)
          hasOlder = prepended.hasOlder
          before = prepended.oldestCursor
        }
        loadedPages.reverse()
        const loadedEntries = loadedPages.flat()
        const storedProjection = yield* transcripts.get(target.id)
        expect(hasOlder).toBe(false)
        expect(new Set(loadedEntries.map((entry) => entry.unit.key)).size).toBe(loadedEntries.length)
        expect(loadedEntries.some((entry) => entry.unit.key === `turn:${target.id}:user`)).toBe(true)
        expect(loadedEntries.some((entry) => entry.unit.key === `${target.id}:assistant:opening`)).toBe(true)
        expect(new Set(loadedEntries.map((entry) => entry.unit.key))).toEqual(
          new Set(stale.units.map((unit) => unit.key)),
        )
        expect(storedProjection?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
        expect(storedProjection?.units.some((unit) => unit.key === `${target.id}:assistant:opening`)).toBe(true)
      }
      const stored = yield* transcripts.get(target.id)
      if (stored === undefined) return yield* Effect.die("authoritative projection was not stored")
      const deliveredUnits: ReadonlyArray<TranscriptUnit.Unit> =
        loadedPages.flat().length === 0 ? stored.units : loadedPages.flat().map((entry) => entry.unit)
      const deliveredTurn = loadedPages.flat()[0]?.turn ?? stored.turn
      expect(deliveredTurn.status).toBe(inspectedStatus)
      expect(Turn.isAgentExecution(deliveredTurn) ? deliveredTurn.lastCursor : undefined).toBe("terminal-cursor")
      expect(yield* turns.get(target.id)).toMatchObject({
        status: inspectedStatus,
        lastCursor: "terminal-cursor",
        updatedAt: 1,
      })
      if (!oversizedProjection)
        expect(deliveredUnits.some((unit) => unit.executionOutcome?.status === inspectedStatus)).toBe(true)
      expect(deliveredUnits.some((unit) => unit.executionOutcome?.status === "complete")).toBe(false)
      if (!oversizedProjection)
        expect(stored.units.some((unit) => unit.executionOutcome?.status === inspectedStatus)).toBe(true)
      expect(stored.units.some((unit) => unit.executionOutcome?.status === "complete")).toBe(false)

      yield* Fiber.interrupt(feed)
      yield* Fiber.interrupt(operationFiber)
    }),
  )

export {
  ThreadRepository,
  Thread,
  TranscriptRepository,
  TurnRepository,
  TurnContract,
  Turn,
  UsageRepository,
  SummaryRepository,
  ExecutionBackend,
  TranscriptIdentity,
  TranscriptOrdering,
  TranscriptProjection,
  TranscriptUnit,
}
export { Context, Deferred, Effect, Fiber, Layer, Queue, Ref, Schema }
export { ExecutionIngest, executeInteractiveCommand, InteractiveEventSchema, UsageCost }
export { invalidatedProjection, storeProjection }
