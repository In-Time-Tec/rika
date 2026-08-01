import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as UsageRepository from "@rika/product-store/sqlite-usage-repository"
import * as SummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as TranscriptIdentity from "@rika/transcript/transcript-unit-identity"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref, Schema } from "effect"
import { ExecutionIngest } from "@rika/product/product-operation"
import { Operation } from "@rika/product/product-operation"
import { executeInteractiveCommand, InteractiveEventSchema } from "@rika/product/product-operation"
import * as UsageCost from "@rika/product/usage-projection"
import { invalidatedProjection, storeProjection } from "../support/product-test-transcript-fixture"

const baseBackend = ExecutionBackend.Service.of({
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

const thread = (id: string): Thread.Thread => ({
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

const providerCostEvent = (
  executionId: string,
  cursor: string,
  amount: number,
  sequence = 0,
): ExecutionEvent.Event => ({
  executionId,
  cursor,
  sequence,
  type: "model.attempt.completed",
  createdAt: 1,
  data: { model_attempt_id: `${cursor}-attempt`, cost: { amount, currency: "USD" } },
})

const interactiveLayer = (
  repository: ThreadRepository.Interface,
  turns: TurnRepository.Interface,
  backend: ExecutionBackend.Interface,
  registration: Deferred.Deferred<Operation.InteractiveSession>,
  makeThreadId: Effect.Effect<Thread.ThreadId> = Effect.die("unused"),
  makeTurnId: Effect.Effect<Turn.TurnId> = Effect.die("unused"),
  transcripts?: TranscriptRepository.Interface,
  usage?: UsageRepository.Interface,
) =>
  Operation.productLayer({
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

const awaitCondition = (condition: Effect.Effect<boolean>, attempts = 50_000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (yield* condition) return true
      yield* Effect.yieldNow
    }
    return false
  })

const settle = (attempts = 500) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) yield* Effect.yieldNow
  })

const terminalTransitionScenario = (
  inspectedStatus: "failed" | "cancelled",
  pagedHistory: boolean,
  oversizedProjection: boolean = false,
) =>
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
        executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
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
      const replayEvents: ReadonlyArray<ExecutionEvent.Event> = Array.from({ length: pageCount }, (_, index) => {
        const terminal = index === pageCount - 1
        let type: ExecutionEvent.Event["type"]
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
      const registration = yield* Deferred.make<Operation.InteractiveSession>()
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
      const operation = Context.get(context, Operation.Service)
      const operationFiber = yield* Effect.forkChild(
        operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
      )
      const session = yield* Deferred.await(registration)
      const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
      const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

      yield* session.selectThread(selected.id, 1)
      let selectedEvent: Extract<Operation.InteractiveEvent, { readonly _tag: "SelectionLoaded" }> | undefined
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
      expect(ThreadResult.TurnResult.isAgentExecution(deliveredTurn) ? deliveredTurn.lastCursor : undefined).toBe("terminal-cursor")
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

describe("interactive session extensions", () => {
  it.effect("adopts completed to failed and cancelled transitions through authoritative refold", () =>
    Effect.forEach(["failed", "cancelled"] as const, (status) => terminalTransitionScenario(status, false), {
      discard: true,
    }),
  )

  it.effect("adopts completed to failed and cancelled transitions from a multi-page authoritative history", () =>
    Effect.forEach(["failed", "cancelled"] as const, (status) => terminalTransitionScenario(status, true), {
      discard: true,
    }),
  )

  it.effect("previews a non-terminal thread from persisted units", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const previewed = thread("previewed")
        const running: Turn.Turn = {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("preview-turn"),
          threadId: previewed.id,
          prompt: "preview prompt",
          stopIntent: "none",
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          status: "running",
          lastCursor: "stored-cursor",
          createdAt: 1,
          updatedAt: 1,
        }
        const repository = yield* ThreadRepository.makeMemory([previewed])
        const turns = yield* TurnRepository.makeMemory([running])
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        yield* storeProjection(
          transcripts,
          running,
          TranscriptProjection.Projection.project(running.id, running.prompt, [
            {
              cursor: "stored-cursor",
              sequence: 1,
              type: "model.output.completed",
              createdAt: 1,
              text: "persisted preview answer",
            },
          ]),
          { consumed: { [String(running.id)]: { cursor: "stored-cursor", sequence: 1 } }, projectionVersion: 2 },
        )
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) =>
            Effect.succeed({
              turnId: String(executionId),
              status: "running" as const,
              waits: [],
              pendingTools: [],
              children: [],
            }),
          replay: (executionId) =>
            Effect.succeed({
              turnId: String(executionId),
              status: "running" as const,
              events: [
                {
                  executionId: String(executionId),
                  cursor: "backend-cursor",
                  sequence: 2,
                  type: "model.output.completed",
                  createdAt: 2,
                  text: "backend rebuilt answer",
                },
              ],
            }),
          follow: (executionId) =>
            Effect.succeed({ turnId: String(executionId), status: "running" as const, events: [] }),
        })
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
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
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events: Array<Operation.InteractiveEvent> = []
        const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))

        yield* session.previewThread(String(previewed.id))
        for (
          let attempt = 0;
          attempt < 400 && !events.some((event) => event._tag === "ThreadPreviewLoaded");
          attempt += 1
        )
          yield* Effect.yieldNow

        const preview = events.find((event) => event._tag === "ThreadPreviewLoaded")
        if (preview?._tag !== "ThreadPreviewLoaded") return yield* Effect.die("missing thread preview")
        expect(preview.threadId).toBe(String(previewed.id))
        expect(preview.turns.map((value) => value.prompt)).toEqual(["preview prompt"])
        const previewUnits = yield* Schema.decodeUnknownEffect(Schema.Array(TranscriptUnit.Unit))(
          preview.turns.flatMap((value) => value.units),
        )
        expect(
          previewUnits.some(
            (unit) => unit.content._tag === "Entry" && unit.content.text === "persisted preview answer",
          ),
        ).toBe(true)
        expect(
          previewUnits.some((unit) => unit.content._tag === "Entry" && unit.content.text === "backend rebuilt answer"),
        ).toBe(false)

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("bounds an oversized stored Turn without failing the selection", () =>
    terminalTransitionScenario("failed", true, true),
  )

  it.effect("submits while persisted thread usage is still loading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = thread("persisted-usage-read")
        const repository = yield* ThreadRepository.makeMemory([selected])
        const turns = yield* TurnRepository.makeMemory()
        const usageContext = yield* Layer.build(UsageRepository.memoryLayer)
        const memoryUsage = Context.get(usageContext, UsageRepository.Service)
        const readStarted = yield* Deferred.make<void>()
        const releaseRead = yield* Deferred.make<void>()
        const usage: UsageRepository.Interface = {
          ...memoryUsage,
          readThread: (threadId) =>
            Deferred.succeed(readStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRead)),
              Effect.andThen(memoryUsage.readThread(threadId)),
            ),
        }
        const submissionStarted = yield* Deferred.make<void>()
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: () => Effect.die("usage loading must not inspect Relay"),
          replay: () => Effect.die("usage loading must not replay Relay"),
          start: (input) =>
            Deferred.succeed(submissionStarted, undefined).pipe(Effect.andThen(baseBackend.start(input))),
        })
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const context = yield* Layer.build(
          interactiveLayer(
            repository,
            turns,
            backend,
            registration,
            Effect.die("unused"),
            Effect.succeed(Turn.TurnId.make("submitted-turn")),
            undefined,
            usage,
          ),
        )
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)

        yield* session.selectThread(selected.id, 1)
        yield* Deferred.await(readStarted)
        yield* session.submit("send now")
        yield* Deferred.await(submissionStarted)

        yield* Deferred.succeed(releaseRead, undefined)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("uses current Relay replay without rewriting a persisted checkpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = thread("priced")
        const repository = yield* ThreadRepository.makeMemory([selected])
        const target: Turn.Turn = {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("turn-priced"),
          threadId: selected.id,
          prompt: "priced",
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          status: "completed",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        }
        const turns = yield* TurnRepository.makeMemory([target])
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        yield* storeProjection(
          transcripts,
          target,
          { ...TranscriptProjection.Projection.empty(target.id, target.prompt), costUsd: 15 },
          {
            consumed: { [String(target.id)]: { cursor: "", sequence: -1, status: "completed" } },
            projectionVersion: 3,
          },
        )
        let inspections = 0
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) => {
            inspections += 1
            return Effect.succeed(
              executionId === target.id
                ? {
                    turnId: executionId,
                    status: "completed" as const,
                    waits: [],
                    pendingTools: [],
                    children: [],
                  }
                : undefined,
            )
          },
          replay: (executionId) => Effect.succeed({ turnId: executionId, status: "completed" as const, events: [] }),
        })
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
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
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
        const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

        yield* session.selectThread(selected.id, 1)
        let loaded = yield* Queue.take(events)
        while (loaded._tag !== "SelectionLoaded") loaded = yield* Queue.take(events)

        expect(loaded.threadCostUsd).toBeUndefined()
        expect(loaded.globalCostUsd).toBeUndefined()
        expect(inspections).toBeGreaterThan(0)
        expect(yield* transcripts.get(target.id)).toMatchObject({
          costUsd: 15,
        })

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("prevents an obsolete selection epoch from committing after its replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = thread("selection-a")
        const second = thread("selection-b")
        const firstTurn: Turn.Turn = {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("selection-a-turn"),
          threadId: first.id,
          prompt: "a",
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
          status: "running",
          stopIntent: "none",
          createdAt: 1,
          updatedAt: 1,
        }
        const secondTurn: Turn.Turn = {
          ...firstTurn,
          id: Turn.TurnId.make("selection-b-turn"),
          threadId: second.id,
          prompt: "b",
        }
        const repository = yield* ThreadRepository.makeMemory([first, second])
        const turns = yield* TurnRepository.makeMemory([firstTurn, secondTurn])
        const firstPageRead = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        let selectingFirst = false
        const selectionTurns: TurnRepository.Interface = {
          ...turns,
          page: (threadId, options) => {
            const block = selectingFirst && threadId === first.id
            return turns.page(threadId, options).pipe(
              Effect.tap(() => (block ? Deferred.succeed(firstPageRead, undefined) : Effect.void)),
              Effect.tap(() => (block ? Deferred.await(releaseFirst) : Effect.void)),
            )
          },
        }
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "running" as const,
              waits: [],
              pendingTools: [],
              children: [],
            }),
          replay: (executionId) => Effect.succeed({ turnId: executionId, status: "running" as const, events: [] }),
        })
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const context = yield* Layer.build(interactiveLayer(repository, selectionTurns, backend, registration))
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events: Array<Operation.InteractiveEvent> = []
        const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))

        selectingFirst = true
        const firstSelection = yield* Effect.forkChild(session.selectThread(first.id, 1))
        yield* Deferred.await(firstPageRead)
        selectingFirst = false
        const secondSelection = yield* Effect.forkChild(session.selectThread(second.id, 2))
        yield* Fiber.join(secondSelection)
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(firstSelection)
        for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow

        expect(events.filter((event) => event._tag === "SelectionLoaded").map((event) => event.thread.id)).toEqual([
          second.id,
        ])
        expect(events.some((event) => event._tag === "SelectionLoaded" && event.thread.id === first.id)).toBe(false)

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("loads one thread with its child cost and the data-root global total", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = thread("first")
        const second = thread("second")
        const repository = yield* ThreadRepository.makeMemory([first, second])
        const turns = yield* TurnRepository.makeMemory([
          {
            _tag: "AgentExecution",
            id: Turn.TurnId.make("turn-first"),
            threadId: first.id,
            prompt: "first",
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            status: "completed",
            stopIntent: "none",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            _tag: "AgentExecution",
            id: Turn.TurnId.make("turn-second"),
            threadId: second.id,
            prompt: "second",
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            status: "completed",
            stopIntent: "none",
            createdAt: 2,
            updatedAt: 2,
          },
        ])
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        for (const turnId of ["turn-first", "turn-second"] as const) {
          const target = (yield* turns.get(Turn.TurnId.make(turnId)))!
          if (!ThreadResult.TurnResult.isAgentExecution(target)) return yield* Effect.die(`Expected agent execution turn ${turnId}`)
          yield* storeProjection(
            transcripts,
            target,
            TranscriptProjection.Projection.project(target.id, target.prompt, [
              {
                cursor: `${turnId}-completed`,
                sequence: 1,
                type: "execution.completed",
                createdAt: 1,
              },
            ]),
            {
              consumed: {
                [String(target.id)]: { cursor: `${turnId}-completed`, sequence: 1, status: "completed" },
              },
              projectionVersion: 3,
            },
          )
        }
        const usageContext = yield* Layer.build(UsageRepository.memoryLayer)
        const usage = Context.get(usageContext, UsageRepository.Service)
        const firstFold = UsageCost.serialize(UsageCost.empty)
        const secondFold = UsageCost.serialize(UsageCost.empty)
        yield* usage.admitSource("turn-first", "turn-first", String(first.id))
        yield* usage.commitSource("turn-first", "turn-first", 0, firstFold, {
          costNanoUsd: 5_000_000_000,
          tokens: 50,
          activeMillis: 500,
          activeIntervals: [{ start: 0, end: 500 }],
          pricedAttempts: 2,
          unpricedAttempts: 0,
          countedAttempts: 2,
          uncountedAttempts: 0,
          sourceComplete: true,
        })
        yield* usage.admitSource("turn-second", "turn-second", String(second.id))
        yield* usage.commitSource("turn-second", "turn-second", 0, secondFold, {
          costNanoUsd: 8_000_000_000,
          tokens: 80,
          activeMillis: 800,
          activeIntervals: [{ start: 500, end: 1_300 }],
          pricedAttempts: 1,
          unpricedAttempts: 0,
          countedAttempts: 1,
          uncountedAttempts: 0,
          sourceComplete: true,
        })
        let backendReads = 0
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: () => {
            backendReads += 1
            return Effect.void.pipe(Effect.as(undefined))
          },
          replay: (turnId) => {
            backendReads += 1
            return Effect.succeed({ turnId, status: "completed" as const, events: [] })
          },
        })
        const context = yield* Layer.build(
          interactiveLayer(
            repository,
            turns,
            backend,
            registration,
            Effect.die("unused"),
            Effect.die("unused"),
            transcripts,
            usage,
          ),
        )
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
        const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

        yield* session.selectThread(first.id, 1)
        let loaded = yield* Queue.take(events)
        while (loaded._tag !== "SelectionLoaded") loaded = yield* Queue.take(events)

        expect(loaded.threadCostUsd).toBeUndefined()
        expect(loaded.globalCostUsd).toBeUndefined()
        const transcriptRepairReads = backendReads
        let refreshed = yield* Queue.take(events)
        while (refreshed._tag !== "ThreadUsageUpdated" || refreshed.threadId !== first.id)
          refreshed = yield* Queue.take(events)
        expect(refreshed).toMatchObject({
          cost: { _tag: "Available", usd: 5 },
          tokens: { _tag: "Available", total: 50 },
          time: { _tag: "Available", accumulatedMillis: 500 },
        })
        expect(backendReads).toBe(transcriptRepairReads)
        expect(yield* usage.readGlobal).toMatchObject({ costNanoUsd: 13_000_000_000 })

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("rejects an inspected child with no durable parent tool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = thread("synth")
        const repository = yield* ThreadRepository.makeMemory([selected])
        const turns = yield* TurnRepository.makeMemory([
          {
            _tag: "AgentExecution",
            id: Turn.TurnId.make("turn-synth"),
            threadId: selected.id,
            prompt: "synth",
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            status: "completed",
            stopIntent: "none",
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        const childId = "turn-synth-child"
        const rootEvents: ReadonlyArray<ExecutionEvent.Event> = [
          {
            executionId: "turn-synth",
            cursor: "root-answer",
            sequence: 0,
            type: "model.output.completed",
            createdAt: 1,
            text: "Delegated.",
          },
        ]
        const childEvents: ReadonlyArray<ExecutionEvent.Event> = [
          {
            executionId: childId,
            cursor: "child-read",
            sequence: 0,
            type: "tool.call.requested",
            createdAt: 2,
            data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
          },
          {
            executionId: childId,
            cursor: "child-answer",
            sequence: 1,
            type: "model.output.completed",
            createdAt: 3,
            text: "Child finished.",
          },
        ]
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) => {
            if (executionId === "turn-synth") {
              return Effect.succeed({
                turnId: executionId,
                status: "completed" as const,
                waits: [],
                pendingTools: [],
                children: [{ executionId: childId, status: "completed" as const }],
              })
            }
            if (executionId === childId) {
              return Effect.succeed({
                turnId: executionId,
                status: "completed" as const,
                waits: [],
                pendingTools: [],
                children: [],
              })
            }
            return Effect.void.pipe(Effect.as(undefined))
          },
          replay: (executionId) => {
            let events: ReadonlyArray<ExecutionEvent.Event> = []
            if (executionId === "turn-synth") events = rootEvents
            else if (executionId === childId) events = childEvents
            return Effect.succeed({ turnId: executionId, status: "completed" as const, events })
          },
        })
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
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events: Array<Operation.InteractiveEvent> = []
        const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))

        yield* session.selectThread(selected.id, 1)
        for (let attempt = 0; attempt < 500 && !events.some((event) => event._tag === "ExecutionFailed"); attempt += 1)
          yield* Effect.yieldNow

        expect(events.some((event) => event._tag === "ExecutionFailed")).toBe(true)
        expect(yield* transcripts.get(Turn.TurnId.make("turn-synth"))).toBeUndefined()

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("creates and adopts a fresh selected thread before the next submission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const previous = thread("previous")
        const repository = yield* ThreadRepository.makeMemory([previous])
        const turns = yield* TurnRepository.makeMemory([
          {
            _tag: "AgentExecution",
            id: Turn.TurnId.make("queued"),
            threadId: previous.id,
            prompt: "queued",
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
            status: "queued",
            stopIntent: "none",
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const starts = yield* Ref.make<ReadonlyArray<ExecutionRequest.StartInput>>([])
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) =>
            Ref.update(starts, (values) => [...values, input]).pipe(
              Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
            ),
        })
        const layer = interactiveLayer(
          repository,
          turns,
          backend,
          registration,
          Effect.succeed(Thread.ThreadId.make("fresh")),
          Effect.succeed(Turn.TurnId.make("fresh-turn")),
        )
        const context = yield* Layer.build(layer)
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
        const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

        yield* session.selectThread(previous.id, 4)
        let selected = yield* Queue.take(events)
        while (selected._tag !== "SelectionLoaded") selected = yield* Queue.take(events)
        yield* executeInteractiveCommand(session, { _tag: "NewThread" })
        let fresh = yield* Queue.take(events)
        while (fresh._tag !== "SelectionLoaded" || fresh.thread.id !== "fresh") fresh = yield* Queue.take(events)

        expect(fresh).toMatchObject({
          selectionEpoch: 5,
          thread: { id: "fresh", title: "New thread" },
          entries: [],
          hasOlder: false,
          queueRevision: 0,
          queuedCount: 0,
          queue: [],
        })
        expect(yield* repository.get(Thread.ThreadId.make("fresh"))).toMatchObject({ title: "New thread" })

        yield* session.submit("lands here")
        while ((yield* Ref.get(starts)).length === 0) yield* Effect.yieldNow
        expect((yield* Ref.get(starts))[0]).toMatchObject({ threadId: "fresh", turnId: "fresh-turn" })
        expect(yield* turns.readQueue(previous.id)).toMatchObject({ queuedCount: 1 })
        expect(yield* turns.readQueue(Thread.ThreadId.make("fresh"))).toMatchObject({ queuedCount: 0, turns: [] })

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("forwards child and nested child events once under normalized execution ids", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.makeMemory()
        const turns = yield* TurnRepository.makeMemory()
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const followed = yield* Ref.make<ReadonlyArray<string>>([])
        const startEventScopes = yield* Ref.make<ReadonlyArray<ExecutionRequest.EventScope | undefined>>([])
        const childCallId = "agent"
        const childId = `child:execution%3Aparent-turn:${childCallId}`
        const nestedCallId = "worker"
        const nestedId = `child:${encodeURIComponent(childId)}:${nestedCallId}`
        const childEvents: ReadonlyArray<ExecutionEvent.Event> = [
          {
            executionId: childId,
            cursor: "child-started",
            sequence: 0,
            type: "execution.started",
            createdAt: 2,
            timestampSource: "server",
          },
          {
            executionId: childId,
            cursor: "child-tool",
            sequence: 1,
            type: "tool.call.requested",
            createdAt: 3,
            data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
          },
          {
            executionId: childId,
            cursor: "child-delegate",
            sequence: 2,
            type: "tool.call.requested",
            createdAt: 4,
            data: { tool_call_id: nestedCallId, tool_name: "task", input: { prompt: "run checks" } },
          },
          {
            executionId: childId,
            cursor: "nested-spawn",
            sequence: 3,
            type: "child_run.spawned",
            createdAt: 4,
            data: { tool_call_id: nestedCallId, child_execution_id: nestedId },
          },
          providerCostEvent(childId, "child-usage", 2, 4),
          {
            executionId: childId,
            cursor: "child-response",
            sequence: 5,
            type: "model.output.completed",
            createdAt: 5,
            text: "## Child complete\n\n**Projection preserved.**",
          },
          {
            executionId: childId,
            cursor: "child-done",
            sequence: 6,
            type: "execution.completed",
            createdAt: 5,
            timestampSource: "server",
          },
        ]
        const nestedEvents: ReadonlyArray<ExecutionEvent.Event> = [
          {
            executionId: nestedId,
            cursor: "nested-started",
            sequence: 0,
            type: "execution.started",
            createdAt: 5,
            timestampSource: "server",
          },
          {
            executionId: nestedId,
            cursor: "nested-tool",
            sequence: 1,
            type: "tool.call.requested",
            createdAt: 6,
            data: { tool_call_id: "bash", tool_name: "bash", input: { command: "bun test" } },
          },
          {
            executionId: nestedId,
            cursor: "nested-response",
            sequence: 2,
            type: "model.output.completed",
            createdAt: 7,
            text: "Nested checks passed.",
          },
          providerCostEvent(nestedId, "nested-usage", 4, 3),
          {
            executionId: nestedId,
            cursor: "nested-done",
            sequence: 4,
            type: "execution.completed",
            createdAt: 7,
            timestampSource: "server",
          },
        ]
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) => {
            const parentEvents: ReadonlyArray<ExecutionEvent.Event> = [
              {
                executionId: input.turnId,
                cursor: "parent-started",
                sequence: 0,
                type: "execution.started",
                createdAt: 0,
                timestampSource: "server",
              },
              {
                executionId: input.turnId,
                cursor: "parent-tool",
                sequence: 1,
                type: "tool.call.requested",
                createdAt: 1,
                data: { tool_call_id: childCallId, tool_name: "oracle", input: { prompt: "inspect" } },
              },
              {
                executionId: input.turnId,
                cursor: "child-spawn",
                sequence: 2,
                type: "child_run.spawned",
                createdAt: 2,
                data: { child_execution_id: childId },
              },
              providerCostEvent(String(input.turnId), "parent-usage", 1, 3),
              {
                executionId: input.turnId,
                cursor: "parent-done",
                sequence: 4,
                type: "execution.completed",
                createdAt: 8,
                timestampSource: "server",
              },
            ]
            return Ref.update(startEventScopes, (values) => [...values, input.eventScope]).pipe(
              Effect.andThen(Effect.yieldNow),
              Effect.tap(() =>
                Effect.sync(() => {
                  for (const event of parentEvents) input.onEvent?.(event)
                }),
              ),
              Effect.as({ turnId: input.turnId, status: "completed" as const, events: parentEvents }),
            )
          },
          follow: (executionId, _afterCursor, onEvent) => {
            if (executionId === "parent-turn")
              return Effect.succeed({ turnId: executionId, status: "running" as const, events: [] })
            const events = executionId === childId ? childEvents : nestedEvents
            return Ref.update(followed, (values) => [...values, executionId]).pipe(
              Effect.tap(() => Effect.sync(() => events.forEach((event) => onEvent?.(event)))),
              Effect.as({ turnId: executionId, status: "completed" as const, events }),
            )
          },
          replay: (executionId) => {
            let events: ReadonlyArray<ExecutionEvent.Event> = []
            if (executionId === childId) events = childEvents
            else if (executionId === nestedId) events = nestedEvents
            return Effect.succeed({ turnId: executionId, status: "completed" as const, events })
          },
          inspect: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "completed" as const,
              waits: [],
              pendingTools: [],
              children: [],
            }),
        })
        const layer = interactiveLayer(
          repository,
          turns,
          backend,
          registration,
          Effect.succeed(Thread.ThreadId.make("thread")),
          Effect.succeed(Turn.TurnId.make("parent-turn")),
        )
        const context = yield* Layer.build(layer)
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events: Array<Operation.InteractiveEvent> = []
        const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))
        yield* Effect.yieldNow

        yield* session.submit("delegate")
        while (
          !events.some(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.executionId === nestedId &&
              event.origin.cursor === "nested-done",
          )
        )
          yield* Effect.yieldNow

        expect((yield* Ref.get(followed)).toSorted()).toEqual([childId, nestedId].toSorted())
        expect(yield* Ref.get(startEventScopes)).toEqual(["execution"])
        const patched = events.flatMap((event) =>
          event._tag === "TranscriptProjectionPatched" && event.origin._tag === "Event"
            ? [`${event.origin.executionId} ${event.origin.cursor}`]
            : [],
        )
        expect(patched.toSorted()).toEqual(
          [
            "parent-turn parent-started",
            "parent-turn parent-tool",
            "parent-turn child-spawn",
            "parent-turn parent-usage",
            "parent-turn parent-done",
            `${childId} child-started`,
            `${childId} child-tool`,
            `${childId} child-delegate`,
            `${childId} nested-spawn`,
            `${childId} child-usage`,
            `${childId} child-response`,
            `${childId} child-done`,
            `${nestedId} nested-started`,
            `${nestedId} nested-tool`,
            `${nestedId} nested-response`,
            `${nestedId} nested-usage`,
            `${nestedId} nested-done`,
          ].toSorted(),
        )
        expect(
          events.find(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.cursor === "parent-usage",
          ),
        ).toMatchObject({
          rootTurnId: "parent-turn",
          delta: { upsert: expect.any(Array), remove: expect.any(Array) },
        })
        expect(
          events.find(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.cursor === "child-usage",
          ),
        ).toMatchObject({
          rootTurnId: "parent-turn",
        })
        expect(
          events.find(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.cursor === "nested-usage",
          ),
        ).toMatchObject({
          rootTurnId: "parent-turn",
        })
        events.length = 0
        yield* session.selectThread(Thread.ThreadId.make("thread"), 1)
        while (!events.some((event) => event._tag === "SelectionLoaded")) yield* Effect.yieldNow
        const loaded = events.find((event) => event._tag === "SelectionLoaded")
        const loadedEntries = loaded?._tag === "SelectionLoaded" ? loaded.entries : []
        expect(
          loadedEntries.some(
            (entry) =>
              entry.unit.turnId === childId &&
              entry.unit.parentId === TranscriptIdentity.scopedIdentity("parent-turn", childCallId),
          ),
        ).toBe(true)
        expect(
          loadedEntries.some(
            (entry) =>
              entry.unit.turnId === nestedId &&
              entry.unit.parentId === TranscriptIdentity.scopedIdentity(childId, nestedCallId),
          ),
        ).toBe(true)
        expect(
          loadedEntries.some(
            (entry) =>
              entry.unit.parentId === TranscriptIdentity.scopedIdentity("parent-turn", childCallId) &&
              entry.unit.content._tag === "Entry" &&
              entry.unit.content.role === "assistant" &&
              entry.unit.content.text === "## Child complete\n\n**Projection preserved.**",
          ),
        ).toBe(true)

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("follows every discovered child without waiting for earlier children", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.makeMemory()
        const turns = yield* TurnRepository.makeMemory()
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const releaseChildren = yield* Deferred.make<void>()
        const allChildrenStarted = yield* Deferred.make<void>()
        const followed = yield* Ref.make<ReadonlyArray<string>>([])
        const childIds = Array.from({ length: 12 }, (_, index) => `child:execution%3Aparent-turn:worker-${index}`)
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) =>
            Effect.sync(() => {
              for (const [sequence, childId] of childIds.entries())
                input.onEvent?.({
                  executionId: input.turnId,
                  cursor: `spawn-${sequence}`,
                  sequence,
                  type: "child_run.spawned",
                  createdAt: sequence,
                  data: { child_execution_id: childId },
                })
              return { turnId: input.turnId, status: "running" as const, events: [] }
            }),
          follow: (executionId, _afterCursor, onEvent) => {
            if (executionId === "parent-turn")
              return Effect.succeed({ turnId: executionId, status: "running" as const, events: [] })
            return Ref.updateAndGet(followed, (values) => [...values, executionId]).pipe(
              Effect.tap((values) =>
                Effect.sync(() =>
                  onEvent?.({
                    executionId,
                    cursor: "started",
                    sequence: 0,
                    type: "model.output.delta",
                    createdAt: 1,
                    text: "started",
                  }),
                ).pipe(
                  Effect.andThen(
                    values.length === childIds.length ? Deferred.succeed(allChildrenStarted, undefined) : Effect.void,
                  ),
                ),
              ),
              Effect.andThen(Deferred.await(releaseChildren)),
              Effect.as({ turnId: executionId, status: "running" as const, events: [] }),
            )
          },
        })
        const context = yield* Layer.build(
          interactiveLayer(
            repository,
            turns,
            backend,
            registration,
            Effect.succeed(Thread.ThreadId.make("thread")),
            Effect.succeed(Turn.TurnId.make("parent-turn")),
          ),
        )
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events: Array<Operation.InteractiveEvent> = []
        const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))
        yield* Effect.yieldNow

        yield* session.submit("delegate broadly")
        yield* Deferred.await(allChildrenStarted)

        expect(new Set(yield* Ref.get(followed))).toEqual(new Set(childIds))
        const startedChildren = () =>
          events.flatMap((event) =>
            event._tag === "TranscriptProjectionPatched" &&
            event.origin._tag === "Event" &&
            event.origin.type === "model.output.delta"
              ? [event.origin.executionId]
              : [],
          )
        while (startedChildren().length < childIds.length) yield* Effect.yieldNow
        expect(new Set(startedChildren())).toEqual(new Set(childIds))
        expect(startedChildren()).toHaveLength(childIds.length)

        yield* Deferred.succeed(releaseChildren, undefined)
        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("resumes a child after an actionable wait from its exact last cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.makeMemory()
        const turns = yield* TurnRepository.makeMemory()
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const childId = "child:execution%3Aparent-turn:worker"
        const childFollows = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const childFollowCount = yield* Ref.make(0)
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) =>
            Effect.sync(() => {
              input.onEvent?.({
                executionId: input.turnId,
                cursor: "spawn",
                sequence: 0,
                type: "child_run.spawned",
                createdAt: 1,
                data: { child_execution_id: childId },
              })
              return {
                turnId: input.turnId,
                status: "running" as const,
                events: [],
              }
            }),
          follow: (executionId, afterCursor, onEvent) => {
            const cursor = typeof afterCursor === "string" ? afterCursor : afterCursor?.cursor
            if (executionId === "parent-turn")
              return Effect.succeed({ turnId: executionId, status: "running" as const, events: [] })
            const waiting: ExecutionEvent.Event = {
              executionId,
              cursor: "wait",
              sequence: 1,
              type: "wait.created",
              createdAt: 2,
              timestampSource: "server",
              data: { wait_id: "wait-child", mode: "external_input" },
            }
            const completed: ReadonlyArray<ExecutionEvent.Event> = [
              {
                executionId,
                cursor: "wake",
                sequence: 2,
                type: "wait.woken",
                createdAt: 3,
                timestampSource: "server",
              },
              {
                executionId,
                cursor: "answer",
                sequence: 3,
                type: "model.output.delta",
                createdAt: 4,
                text: "resumed",
              },
              {
                executionId,
                cursor: "done",
                sequence: 4,
                type: "execution.completed",
                createdAt: 5,
                timestampSource: "server",
              },
            ]
            return Ref.update(childFollows, (cursors) => [...cursors, cursor]).pipe(
              Effect.andThen(Ref.getAndUpdate(childFollowCount, (count) => count + 1)),
              Effect.flatMap((count) => {
                const events =
                  count === 0
                    ? [
                        {
                          executionId,
                          cursor: "started",
                          sequence: 0,
                          type: "execution.started" as const,
                          createdAt: 1,
                          timestampSource: "server",
                        },
                        waiting,
                      ]
                    : completed
                return Effect.sync(() => events.forEach((event) => onEvent?.(event))).pipe(
                  Effect.as({
                    turnId: executionId,
                    status: count === 0 ? ("waiting" as const) : ("completed" as const),
                    events,
                  }),
                )
              }),
            )
          },
          inspect: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "running" as const,
              waits: [],
              pendingTools: [],
              children: executionId === "parent-turn" ? [{ executionId: childId, status: "running" as const }] : [],
            }),
        })
        const layer = interactiveLayer(
          repository,
          turns,
          backend,
          registration,
          Effect.succeed(Thread.ThreadId.make("thread")),
          Effect.succeed(Turn.TurnId.make("parent-turn")),
        )
        const context = yield* Layer.build(layer)
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events: Array<Operation.InteractiveEvent> = []
        const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))
        yield* Effect.yieldNow

        yield* session.submit("delegate")
        while (
          !events.some(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.cursor === "wait",
          )
        )
          yield* Effect.yieldNow
        while (
          !events.some(
            (event) =>
              event._tag === "TranscriptProjectionPatched" &&
              event.origin._tag === "Event" &&
              event.origin.cursor === "done",
          )
        )
          yield* Effect.yieldNow

        expect(yield* Ref.get(childFollows)).toEqual([undefined, "wait"])
        const childCursors = events.flatMap((event) =>
          event._tag === "TranscriptProjectionPatched" &&
          event.origin._tag === "Event" &&
          event.origin.executionId === childId
            ? [event.origin.cursor]
            : [],
        )
        expect(childCursors).toEqual(["started", "wait", "wake", "answer", "done"])

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect(
    "stops child follows on cancel and shutdown but keeps them across selection and session close",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const first = thread("first")
          const second = thread("second")
          const repository = yield* ThreadRepository.makeMemory([first, second])
          const turns = yield* TurnRepository.makeMemory()
          const registration = yield* Deferred.make<Operation.InteractiveSession>()
          const followed = yield* Queue.unbounded<{ readonly executionId: string; readonly afterCursor?: string }>()
          const stopped = yield* Queue.unbounded<string>()
          const cancelled = yield* Ref.make<ReadonlyArray<string>>([])
          const turnSequence = yield* Ref.make(0)
          const backend = ExecutionBackend.Service.of({
            ...baseBackend,
            start: (input) => {
              const childId = `${input.turnId}:child:worker`
              return Effect.sync(() => {
                input.onEvent?.({
                  executionId: input.turnId,
                  cursor: "spawn",
                  sequence: 0,
                  type: "child_run.spawned",
                  createdAt: 1,
                  data: { child_execution_id: childId },
                })
                return {
                  turnId: input.turnId,
                  status: "running" as const,
                  events: [],
                }
              })
            },
            follow: (executionId, afterCursor, onEvent) =>
              executionId.includes(":child:")
                ? Queue.offer(followed, {
                    executionId,
                    ...(afterCursor === undefined
                      ? {}
                      : { afterCursor: typeof afterCursor === "string" ? afterCursor : afterCursor.cursor }),
                  }).pipe(
                    Effect.tap(() =>
                      afterCursor === undefined
                        ? Effect.sync(() =>
                            onEvent?.({
                              executionId,
                              cursor: "working",
                              sequence: 0,
                              type: "model.output.delta",
                              createdAt: 2,
                              text: "working",
                            }),
                          )
                        : Effect.void,
                    ),
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Queue.offer(stopped, executionId)),
                  )
                : Effect.succeed({ turnId: executionId, status: "running" as const, events: [] }),
            inspect: (turnId) =>
              Ref.get(cancelled).pipe(
                Effect.map((values) => {
                  const childId = `${turnId}:child:worker`
                  const rootId = turnId.split(":child:")[0]!
                  const terminal = values.includes(turnId) || values.includes(rootId)
                  return {
                    turnId,
                    status: terminal ? ("cancelled" as const) : ("running" as const),
                    waits: [],
                    pendingTools: [],
                    children: turnId.includes(":child:")
                      ? []
                      : [
                          {
                            executionId: childId,
                            status:
                              terminal || values.includes(childId) ? ("cancelled" as const) : ("running" as const),
                          },
                        ],
                  }
                }),
              ),
            cancel: (turnId) => {
              const events: ReadonlyArray<ExecutionEvent.Event> = turnId.includes(":child:")
                ? [
                    {
                      executionId: turnId,
                      cursor: "working",
                      sequence: 0,
                      type: "model.output.delta",
                      createdAt: 2,
                      text: "working",
                    },
                    {
                      executionId: turnId,
                      cursor: "stopped",
                      sequence: 1,
                      type: "execution.cancelled",
                      createdAt: 3,
                    },
                  ]
                : []
              return Ref.update(cancelled, (values) => [...values, turnId]).pipe(
                Effect.as({ turnId, status: "cancelled" as const, events }),
              )
            },
          })
          const layer = interactiveLayer(
            repository,
            turns,
            backend,
            registration,
            Effect.die("unused"),
            Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
              Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
            ),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(layer)
              const operation = Context.get(context, Operation.Service)
              const operationFiber = yield* Effect.forkChild(
                operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
              )
              const session = yield* Deferred.await(registration)
              const events: Array<Operation.InteractiveEvent> = []
              const feed = yield* Effect.forkChild(session.events((event) => events.push(event)))
              yield* session.selectThread(first.id, 1)

              yield* session.submit("cancelled")
              expect(yield* Queue.take(followed)).toEqual({ executionId: "turn-1:child:worker" })
              yield* session.cancel
              expect(yield* Queue.take(stopped)).toBe("turn-1:child:worker")
              expect(new Set(yield* Ref.get(cancelled))).toEqual(new Set(["turn-1"]))
              expect(
                events.flatMap((event) =>
                  event._tag === "TranscriptProjectionPatched" &&
                  event.origin._tag === "Event" &&
                  event.origin.executionId === "turn-1:child:worker"
                    ? [event.origin.cursor]
                    : [],
                ),
              ).toEqual(["working"])

              yield* session.submit("selected away")
              expect(yield* Queue.take(followed)).toEqual({ executionId: "turn-2:child:worker" })
              yield* session.selectThread(second.id, 2)
              yield* settle()
              expect(yield* Queue.size(stopped)).toBe(0)
              expect(yield* Queue.size(followed)).toBe(0)

              yield* Fiber.interrupt(feed)
              yield* Fiber.interrupt(operationFiber)
              yield* settle()
              expect(yield* Queue.size(stopped)).toBe(0)
            }),
          )

          expect(yield* awaitCondition(Effect.map(Queue.size(stopped), (size) => size > 0))).toBe(true)
          expect(new Set(yield* Queue.clear(stopped))).toEqual(new Set(["turn-2:child:worker"]))
        }),
      ),
    120_000,
  )
})
