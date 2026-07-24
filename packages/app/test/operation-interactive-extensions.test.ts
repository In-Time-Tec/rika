import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Operation } from "../src/index"
import { executeInteractiveCommand } from "../src/operation-contract"

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
  listApprovals: () => Effect.succeed([]),
  resolveToolApproval: () => Effect.void,
  resolvePermission: () => Effect.void,
})

const thread = (id: string): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: "/work",
  title: id,
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
})

const providerCostEvent = (
  executionId: string,
  cursor: string,
  amount: number,
  sequence = 0,
): ExecutionBackend.Event => ({
  id: `${cursor}-id`,
  executionId,
  cursor,
  sequence,
  type: "model.attempt.completed",
  createdAt: 1,
  data: { model_attempt_id: `${cursor}-attempt`, cost: { amount, currency: "USD" } },
})

const estimatedCostEvent = (executionId: string, cursor: string, amount: number): ExecutionBackend.Event => ({
  id: `${cursor}-id`,
  executionId,
  cursor,
  sequence: 0,
  type: "model.usage.reported",
  createdAt: 1,
  data: {
    model_attempt_id: `${cursor}-attempt`,
    provider: "openai",
    model: "gpt-5.6-sol",
    input_tokens: amount * 200_000,
    input_tokens_uncached: amount * 200_000,
    input_tokens_cache_read: 0,
    input_tokens_cache_write: 0,
    output_tokens: 0,
  },
})

const interactiveLayer = (
  repository: ThreadRepository.Interface,
  turns: TurnRepository.Interface,
  backend: ExecutionBackend.Interface,
  registration: Deferred.Deferred<Operation.InteractiveSession>,
  makeThreadId: Effect.Effect<Thread.ThreadId> = Effect.die("unused"),
  makeTurnId: Effect.Effect<Turn.TurnId> = Effect.die("unused"),
  transcripts?: TranscriptRepository.Interface,
) =>
  Operation.productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    ...(transcripts === undefined
      ? {}
      : { transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts) }),
    backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
    defaultWorkspace: "/work",
    makeThreadId,
    makeTurnId,
    interactive: (_, session) => Deferred.succeed(registration, session).pipe(Effect.andThen(Effect.never)),
  })

const terminalTransitionScenario = (
  inspectedStatus: "failed" | "cancelled",
  deferred: boolean,
  overlapOlder: boolean = false,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const selected = thread(`terminal-${inspectedStatus}-${deferred ? "deferred" : "initial"}`)
      const target: Turn.Turn = {
        id: Turn.TurnId.make(`turn-${selected.id}`),
        threadId: selected.id,
        prompt: "terminal transition",
        executionRoute: Turn.testExecutionRoute(),
        status: "completed",
        lastCursor: "terminal-cursor",
        createdAt: 1,
        updatedAt: 1,
      }
      const historical: Turn.Turn = {
        ...target,
        id: Turn.TurnId.make(`historical-${selected.id}`),
        prompt: "historical",
        status: "queued",
        createdAt: 0,
        updatedAt: 0,
      }
      const repository = yield* ThreadRepository.makeMemory([selected])
      const turns = yield* TurnRepository.makeMemory(overlapOlder ? [historical, target] : [target])
      const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
      const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
      const stale = Transcript.project(target.id, target.prompt, [
        {
          cursor: "terminal-cursor",
          sequence: 1,
          type: "execution.completed",
          createdAt: 1,
        },
      ])
      yield* transcripts.replace(target, stale)
      if (overlapOlder)
        yield* transcripts.replace(historical, {
          ...Transcript.empty(historical.id, historical.prompt),
          units: Array.from(
            { length: 220 },
            (_, index): Transcript.Unit => ({
              key: `historical-nested-${index}`,
              turnId: historical.id,
              order: { sequence: index + 1, part: 0 },
              revision: index + 1,
              parentId: "historical-child",
              content: {
                _tag: "Block",
                block: { _tag: "Notification", title: String(index), detail: "x".repeat(40_000) },
              },
            }),
          ),
          revision: 220,
        })
      const pageCount = deferred ? 34 : 1
      const replayEvents: ReadonlyArray<ExecutionBackend.Event> = Array.from({ length: pageCount }, (_, index) => {
        const terminal = index === pageCount - 1
        return {
          cursor: terminal ? "terminal-cursor" : `cursor-${index}`,
          sequence: index + 1,
          type: terminal ? (`execution.${inspectedStatus}` as const) : "execution.started",
          createdAt: index + 1,
          ...(terminal && inspectedStatus === "failed" ? { text: "durable failure" } : {}),
        }
      })
      const terminalPageRequested = yield* Deferred.make<void>()
      const releaseTerminalPage = yield* Deferred.make<void>()
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
        pageEvents: (executionId, _direction, cursor) => {
          const index = cursor === undefined ? 0 : replayEvents.findIndex((event) => event.cursor === cursor) + 1
          const event = replayEvents[index]
          const page = {
            events: event === undefined ? [] : [event],
            hasMore: index < replayEvents.length - 1,
            ...(event === undefined ? {} : { oldestCursor: event.cursor, newestCursor: event.cursor }),
          }
          return overlapOlder && index === replayEvents.length - 1
            ? Deferred.succeed(terminalPageRequested, undefined).pipe(
                Effect.andThen(Deferred.await(releaseTerminalPage)),
                Effect.as(page),
              )
            : Effect.succeed(page)
        },
      })
      const olderPageRequested = yield* Deferred.make<void>()
      const releaseOlderPage = yield* Deferred.make<void>()
      let blockOlderPage = false
      const selectionTranscripts: TranscriptRepository.Interface = {
        ...transcripts,
        page: (threadId, options) =>
          overlapOlder && blockOlderPage && options?.before !== undefined
            ? Deferred.succeed(olderPageRequested, undefined).pipe(
                Effect.andThen(Deferred.await(releaseOlderPage)),
                Effect.andThen(transcripts.page(threadId, options)),
              )
            : transcripts.page(threadId, options),
      }
      const registration = yield* Deferred.make<Operation.InteractiveSession>()
      const context = yield* Layer.build(
        interactiveLayer(
          repository,
          turns,
          backend,
          registration,
          Effect.die("unused"),
          Effect.die("unused"),
          selectionTranscripts,
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
      let selectedEvent = yield* Queue.take(events)
      while (selectedEvent._tag !== "SelectionLoaded") selectedEvent = yield* Queue.take(events)
      let deliveredEntries: ReadonlyArray<TranscriptRepository.Entry>
      if (!deferred) {
        expect(selectedEvent.entries).not.toHaveLength(0)
        expect(selectedEvent.entries.every((entry) => entry.turn.status === inspectedStatus)).toBe(true)
        expect(selectedEvent.entries.every((entry) => entry.turn.lastCursor === "terminal-cursor")).toBe(true)
        deliveredEntries = selectedEvent.entries
      } else if (!overlapOlder) {
        let replacement = yield* Queue.take(events)
        while (replacement._tag !== "TranscriptReplaced") replacement = yield* Queue.take(events)
        expect(replacement.entries).not.toHaveLength(0)
        expect(replacement.entries.every((entry) => entry.turn.status === inspectedStatus)).toBe(true)
        expect(replacement.entries.every((entry) => entry.turn.lastCursor === "terminal-cursor")).toBe(true)
        deliveredEntries = replacement.entries
      } else {
        expect(selectedEvent.hasOlder).toBe(true)
        blockOlderPage = true
        yield* Deferred.await(terminalPageRequested)
        const olderFiber = yield* Effect.forkChild(session.loadOlder)
        yield* Deferred.await(olderPageRequested)
        yield* Deferred.succeed(releaseTerminalPage, undefined)
        for (let attempt = 0; attempt < 100; attempt += 1) yield* Effect.yieldNow
        expect((yield* Queue.takeAll(events)).some((event) => event._tag === "TranscriptReplaced")).toBe(false)
        yield* Deferred.succeed(releaseOlderPage, undefined)
        yield* Fiber.join(olderFiber)
        for (let attempt = 0; attempt < 400; attempt += 1) yield* Effect.yieldNow
        const ordered = yield* Queue.takeAll(events)
        const tags = ordered.map((event) => event._tag)
        expect(tags).toContain("TranscriptPagePrepended")
        expect(tags).toContain("TranscriptReplaced")
        expect(tags).not.toContain("ExecutionFailed")
        expect(ordered.findIndex((event) => event._tag === "TranscriptPagePrepended")).toBeLessThan(
          ordered.findIndex((event) => event._tag === "TranscriptReplaced"),
        )
        const replacement = ordered.find((event) => event._tag === "TranscriptReplaced")
        if (replacement?._tag !== "TranscriptReplaced") return yield* Effect.die("Missing replacement")
        deliveredEntries = replacement.entries
      }
      expect(deliveredEntries.some((entry) => entry.unit.executionOutcome?.status === inspectedStatus)).toBe(true)
      expect(deliveredEntries.some((entry) => entry.unit.executionOutcome?.status === "complete")).toBe(false)
      const stored = yield* transcripts.get(target.id)
      expect(stored?.units.some((unit) => unit.executionOutcome?.status === inspectedStatus)).toBe(true)
      expect(stored?.units.some((unit) => unit.executionOutcome?.status === "complete")).toBe(false)

      yield* Fiber.interrupt(feed)
      yield* Fiber.interrupt(operationFiber)
    }),
  )

describe("interactive session extensions", () => {
  it.effect("adopts completed to failed and cancelled transitions in SelectionLoaded", () =>
    Effect.forEach(["failed", "cancelled"] as const, (status) => terminalTransitionScenario(status, false), {
      discard: true,
    }),
  )

  it.effect("adopts completed to failed and cancelled transitions in deferred replacements", () =>
    Effect.forEach(["failed", "cancelled"] as const, (status) => terminalTransitionScenario(status, true), {
      discard: true,
    }),
  )

  it.effect("serializes a deferred replacement behind an in-flight older page", () =>
    terminalTransitionScenario("failed", true, true),
  )

  it.effect("submits while historical cost reconciliation is still running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = thread("cost-reconciliation")
        const historical: Turn.Turn = {
          id: Turn.TurnId.make("historical-turn"),
          threadId: selected.id,
          prompt: "historical",
          executionRoute: Turn.testExecutionRoute(),
          status: "completed",
          createdAt: 1,
          updatedAt: 1,
        }
        const repository = yield* ThreadRepository.makeMemory([selected])
        const turns = yield* TurnRepository.makeMemory([historical])
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        yield* transcripts.replace(historical, Transcript.empty(historical.id, historical.prompt))
        const reconciliationStarted = yield* Deferred.make<void>()
        const releaseReconciliation = yield* Deferred.make<void>()
        const submissionStarted = yield* Deferred.make<void>()
        let inspectionCount = 0
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) => {
            inspectionCount += 1
            return executionId === historical.id && inspectionCount > 3
              ? Deferred.succeed(reconciliationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseReconciliation)),
                  Effect.as({
                    turnId: executionId,
                    status: "completed" as const,
                    waits: [],
                    pendingTools: [],
                    children: [],
                  }),
                )
              : Effect.succeed({
                  turnId: executionId,
                  status: "completed" as const,
                  waits: [],
                  pendingTools: [],
                  children: [],
                })
          },
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
            transcripts,
          ),
        )
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)

        yield* session.selectThread(selected.id, 1)
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        yield* Deferred.await(reconciliationStarted)
        yield* session.submit("send now")
        yield* Deferred.await(submissionStarted)

        yield* Deferred.succeed(releaseReconciliation, undefined)
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
          id: Turn.TurnId.make("turn-priced"),
          threadId: selected.id,
          prompt: "priced",
          executionRoute: Turn.testExecutionRoute(),
          status: "completed",
          createdAt: 1,
          updatedAt: 1,
        }
        const turns = yield* TurnRepository.makeMemory([target])
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        yield* transcripts.replace(target, { ...Transcript.empty(target.id, target.prompt), costUsd: 15 })
        const usage = { ...estimatedCostEvent(String(target.id), "corrected-usage", 5), sequence: 1 }
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
          replay: (executionId) =>
            Effect.succeed({ turnId: executionId, status: "completed" as const, events: [usage] }),
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
        yield* TestClock.adjust("1 second")
        let refreshed = yield* Queue.take(events)
        while (refreshed._tag !== "TitleCostUpdated" || refreshed.turnId !== target.id)
          refreshed = yield* Queue.take(events)
        expect(refreshed).toMatchObject({ threadCostUsd: 10, globalCostUsd: 10 })

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("does not commit a stale inspected status over a newer persisted cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = thread("selection-commit-race")
        const target: Turn.Turn = {
          id: Turn.TurnId.make("selection-commit-race-turn"),
          threadId: selected.id,
          prompt: "race",
          executionRoute: Turn.testExecutionRoute(),
          status: "running",
          lastCursor: "cursor-old",
          createdAt: 1,
          updatedAt: 1,
        }
        const repository = yield* ThreadRepository.makeMemory([selected])
        const turns = yield* TurnRepository.makeMemory([target])
        const turnPageRead = yield* Deferred.make<void>()
        let selectionRequested = false
        const selectionTurns: TurnRepository.Interface = {
          ...turns,
          page: (threadId, options) =>
            turns
              .page(threadId, options)
              .pipe(Effect.tap(() => (selectionRequested ? Deferred.succeed(turnPageRead, undefined) : Effect.void))),
        }
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        yield* transcripts.replace(
          target,
          Transcript.project(target.id, target.prompt, [
            {
              cursor: "cursor-old",
              sequence: 0,
              type: "model.output.completed",
              createdAt: 1,
              text: "old",
            },
          ]),
        )
        const inspectionStarted = yield* Deferred.make<void>()
        const releaseInspection = yield* Deferred.make<void>()
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) =>
            Effect.gen(function* () {
              const inspection = {
                turnId: executionId,
                status: "running" as const,
                lastCursor: "cursor-old",
                waits: [],
                pendingTools: [],
                children: [],
              }
              if (!(yield* Deferred.isDone(turnPageRead))) return inspection
              yield* Deferred.succeed(inspectionStarted, undefined)
              yield* Deferred.await(releaseInspection)
              return inspection
            }),
          replay: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "running" as const,
              lastCursor: "cursor-old",
              events: [],
            }),
        })
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const context = yield* Layer.build(
          interactiveLayer(
            repository,
            selectionTurns,
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

        selectionRequested = true
        const selectionFiber = yield* Effect.forkChild(session.selectThread(selected.id, 1))
        yield* Deferred.await(turnPageRead)
        yield* Deferred.await(inspectionStarted)
        yield* turns.setStatus(target.id, "running", "cursor-new", 2)
        yield* Deferred.succeed(releaseInspection, undefined)
        yield* Fiber.join(selectionFiber)
        let loaded = yield* Queue.take(events)
        while (loaded._tag !== "SelectionLoaded") loaded = yield* Queue.take(events)

        const entries = loaded.entries.filter((entry) => entry.turn.id === target.id)
        expect(entries.every((entry) => entry.turn.status === "running")).toBe(true)
        expect(entries.every((entry) => entry.turn.lastCursor === "cursor-new")).toBe(true)
        let replaced = yield* Queue.take(events)
        while (replaced._tag !== "TranscriptReplaced") replaced = yield* Queue.take(events)
        expect(replaced.entries.length).toBeGreaterThan(0)
        expect(replaced.entries.every((entry) => entry.turn.status === "running")).toBe(true)
        expect(replaced.entries.every((entry) => entry.turn.lastCursor === "cursor-new")).toBe(true)

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
          id: Turn.TurnId.make("selection-a-turn"),
          threadId: first.id,
          prompt: "a",
          executionRoute: Turn.testExecutionRoute(),
          status: "running",
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
        expect(
          events.some(
            (event) =>
              (event._tag === "SelectionLoaded" && event.thread.id === first.id) ||
              (event._tag === "TranscriptReplaced" && event.threadId === first.id),
          ),
        ).toBe(false)

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
            id: Turn.TurnId.make("turn-first"),
            threadId: first.id,
            prompt: "first",
            executionRoute: Turn.testExecutionRoute(),
            status: "completed",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: Turn.TurnId.make("turn-second"),
            threadId: second.id,
            prompt: "second",
            executionRoute: Turn.testExecutionRoute(),
            status: "completed",
            createdAt: 2,
            updatedAt: 2,
          },
        ])
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const executionEvents = new Map<string, ReadonlyArray<ExecutionBackend.Event>>([
          ["turn-first", [estimatedCostEvent("turn-first", "first-usage", 1)]],
          ["turn-first-child", [estimatedCostEvent("turn-first-child", "first-child-usage", 2)]],
          ["turn-second", [estimatedCostEvent("turn-second", "second-usage", 4)]],
        ])
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) =>
            Effect.succeed(
              executionEvents.has(executionId)
                ? {
                    turnId: executionId,
                    status: "completed" as const,
                    waits: [],
                    pendingTools: [],
                    children:
                      executionId === "turn-first"
                        ? [{ executionId: "turn-first-child", status: "completed" as const }]
                        : [],
                  }
                : undefined,
            ),
          replay: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "completed" as const,
              events: executionEvents.get(executionId) ?? [],
            }),
        })
        const context = yield* Layer.build(interactiveLayer(repository, turns, backend, registration))
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
        expect(new Set(loaded.entries.map((entry) => entry.projectionCostUsd))).toEqual(new Set([1]))
        yield* TestClock.adjust("1 second")
        let refreshed = yield* Queue.take(events)
        while (refreshed._tag !== "TitleCostUpdated" || refreshed.threadId !== first.id)
          refreshed = yield* Queue.take(events)
        expect(refreshed).toMatchObject({ threadCostUsd: 5, globalCostUsd: 13 })

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("attaches an inspected child with no projected parent tool under a synthesized subagent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = thread("synth")
        const repository = yield* ThreadRepository.makeMemory([selected])
        const turns = yield* TurnRepository.makeMemory([
          {
            id: Turn.TurnId.make("turn-synth"),
            threadId: selected.id,
            prompt: "synth",
            executionRoute: Turn.testExecutionRoute(),
            status: "completed",
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        const childId = "turn-synth-child"
        const rootEvents: ReadonlyArray<ExecutionBackend.Event> = [
          { cursor: "root-answer", sequence: 0, type: "model.output.completed", createdAt: 1, text: "Delegated." },
        ]
        const childEvents: ReadonlyArray<ExecutionBackend.Event> = [
          {
            cursor: "child-read",
            sequence: 0,
            type: "tool.call.requested",
            createdAt: 2,
            data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
          },
          {
            cursor: "child-answer",
            sequence: 1,
            type: "model.output.completed",
            createdAt: 3,
            text: "Child finished.",
          },
        ]
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
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
            let events: ReadonlyArray<ExecutionBackend.Event> = []
            if (executionId === "turn-synth") events = rootEvents
            else if (executionId === childId) events = childEvents
            return Effect.succeed({ turnId: executionId, status: "completed" as const, events })
          },
        })
        const context = yield* Layer.build(interactiveLayer(repository, turns, backend, registration))
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

        expect(
          loaded.entries.some(
            (entry) =>
              entry.unit.content._tag === "Block" &&
              entry.unit.content.block._tag === "ToolCall" &&
              entry.unit.content.block.id === childId,
          ),
        ).toBe(true)
        expect(
          loaded.entries.some(
            (entry) =>
              entry.unit.parentId === childId &&
              entry.unit.content._tag === "Block" &&
              entry.unit.content.block._tag === "ToolCall" &&
              entry.unit.content.block.id === `${childId}:read`,
          ),
        ).toBe(true)

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
            id: Turn.TurnId.make("queued"),
            threadId: previous.id,
            prompt: "queued",
            executionRoute: Turn.testExecutionRoute(),
            status: "queued",
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const starts = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
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
        const startEventScopes = yield* Ref.make<ReadonlyArray<ExecutionBackend.EventScope | undefined>>([])
        const childCallId = "agent"
        const childId = `child:execution%3Aparent-turn:${childCallId}`
        const nestedCallId = "worker"
        const nestedId = `child:${encodeURIComponent(childId)}:${nestedCallId}`
        const childEvents: ReadonlyArray<ExecutionBackend.Event> = [
          {
            cursor: "child-tool",
            sequence: 0,
            type: "tool.call.requested",
            createdAt: 3,
            data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
          },
          {
            cursor: "child-delegate",
            sequence: 1,
            type: "tool.call.requested",
            createdAt: 4,
            data: { tool_call_id: nestedCallId, tool_name: "task", input: { prompt: "run checks" } },
          },
          {
            cursor: "nested-spawn",
            sequence: 2,
            type: "child_run.spawned",
            createdAt: 4,
            data: { tool_call_id: nestedCallId, child_execution_id: nestedId },
          },
          providerCostEvent(childId, "child-usage", 2, 3),
          {
            cursor: "child-response",
            sequence: 4,
            type: "model.output.completed",
            createdAt: 5,
            text: "## Child complete\n\n**Projection preserved.**",
          },
          { cursor: "child-done", sequence: 5, type: "execution.completed", createdAt: 5 },
        ]
        const nestedEvents: ReadonlyArray<ExecutionBackend.Event> = [
          {
            cursor: "nested-tool",
            sequence: 0,
            type: "tool.call.requested",
            createdAt: 6,
            data: { tool_call_id: "bash", tool_name: "bash", input: { command: "bun test" } },
          },
          {
            cursor: "nested-response",
            sequence: 1,
            type: "model.output.completed",
            createdAt: 7,
            text: "Nested checks passed.",
          },
          providerCostEvent(nestedId, "nested-usage", 4, 2),
          { cursor: "nested-done", sequence: 3, type: "execution.completed", createdAt: 7 },
        ]
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) => {
            const parentEvents: ReadonlyArray<ExecutionBackend.Event> = [
              {
                cursor: "parent-tool",
                sequence: 0,
                type: "tool.call.requested",
                createdAt: 1,
                data: { tool_call_id: childCallId, tool_name: "oracle", input: { prompt: "inspect" } },
              },
              {
                cursor: "child-spawn",
                sequence: 1,
                type: "child_run.spawned",
                createdAt: 2,
                data: { child_execution_id: childId },
              },
              providerCostEvent(String(input.turnId), "parent-usage", 1, 2),
              { cursor: "parent-done", sequence: 3, type: "execution.completed", createdAt: 8 },
            ]
            return Ref.update(startEventScopes, (values) => [...values, input.eventScope]).pipe(
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
            let events: ReadonlyArray<ExecutionBackend.Event> = []
            if (executionId === childId) events = childEvents
            else if (executionId === nestedId) events = nestedEvents
            return Effect.succeed({ turnId: executionId, status: "completed" as const, events })
          },
          inspect: (executionId) => {
            let children: ReadonlyArray<{ readonly executionId: string; readonly status: "completed" }> = []
            if (executionId === "parent-turn") {
              children = [{ executionId: childId, status: "completed" }]
            } else if (executionId === childId) {
              children = [{ executionId: nestedId, status: "completed" }]
            }
            return Effect.succeed({
              turnId: executionId,
              status: "completed" as const,
              waits: [],
              pendingTools: [],
              children,
            })
          },
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
              event._tag === "TranscriptPatched" && event.turnId === nestedId && event.event.cursor === "nested-done",
          )
        )
          yield* Effect.yieldNow

        expect(yield* Ref.get(followed)).toEqual([childId, nestedId])
        expect(yield* Ref.get(startEventScopes)).toEqual(["execution"])
        const patches = events.filter((event) => event._tag === "TranscriptPatched")
        expect(patches.map((event) => [event.turnId, event.event.cursor])).toEqual([
          ["parent-turn", "parent-tool"],
          ["parent-turn", "child-spawn"],
          ["parent-turn", "parent-usage"],
          ["parent-turn", "parent-done"],
          [childId, "child-tool"],
          [childId, "child-delegate"],
          [childId, "nested-spawn"],
          [childId, "child-usage"],
          [childId, "child-response"],
          [childId, "child-done"],
          [nestedId, "nested-tool"],
          [nestedId, "nested-response"],
          [nestedId, "nested-usage"],
          [nestedId, "nested-done"],
        ])
        expect(patches.find((event) => event.event.cursor === "parent-usage")).toMatchObject({
          rootTurnId: "parent-turn",
        })
        expect(patches.find((event) => event.event.cursor === "child-usage")).toMatchObject({
          rootTurnId: "parent-turn",
        })
        expect(patches.find((event) => event.event.cursor === "nested-usage")).toMatchObject({
          rootTurnId: "parent-turn",
        })
        events.length = 0
        yield* session.selectThread(Thread.ThreadId.make("thread"), 1)
        while (!events.some((event) => event._tag === "SelectionLoaded")) yield* Effect.yieldNow
        const loaded = events.find((event) => event._tag === "SelectionLoaded")
        const loadedEntries = loaded?._tag === "SelectionLoaded" ? loaded.entries : []
        expect(
          loadedEntries.some(
            (entry) => entry.unit.turnId === childId && entry.unit.parentId === `parent-turn:${childCallId}`,
          ),
        ).toBe(true)
        expect(
          loadedEntries.some(
            (entry) => entry.unit.turnId === nestedId && entry.unit.parentId === `${childId}:${nestedCallId}`,
          ),
        ).toBe(true)
        expect(
          loadedEntries.some(
            (entry) =>
              entry.unit.parentId === `parent-turn:${childCallId}` &&
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
                    cursor: `${executionId}:started`,
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
        const startedCursors = () =>
          events.flatMap((event) =>
            event._tag === "TranscriptPatched" && event.event.type === "model.output.delta" ? [event.event.cursor] : [],
          )
        while (startedCursors().length < childIds.length) yield* Effect.yieldNow
        expect(startedCursors()).toEqual(expect.arrayContaining(childIds.map((childId) => `${childId}:started`)))
        expect(startedCursors()).toHaveLength(childIds.length)

        yield* Deferred.succeed(releaseChildren, undefined)
        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("resumes a waiting child from its last cursor after permission resolution", () =>
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
            if (executionId === "parent-turn")
              return Effect.succeed({ turnId: executionId, status: "running" as const, events: [] })
            const waiting: ExecutionBackend.Event = {
              cursor: "wait",
              sequence: 0,
              type: "permission.ask.requested",
              createdAt: 2,
              data: { wait_id: "wait-child", tool_call_id: "read", tool_name: "read" },
            }
            const completed: ReadonlyArray<ExecutionBackend.Event> = [
              { cursor: "answer", sequence: 1, type: "model.output.delta", createdAt: 3, text: "resumed" },
              { cursor: "done", sequence: 2, type: "execution.completed", createdAt: 4 },
            ]
            return Ref.update(childFollows, (cursors) => [...cursors, afterCursor]).pipe(
              Effect.andThen(Ref.getAndUpdate(childFollowCount, (count) => count + 1)),
              Effect.flatMap((count) => {
                const events = count === 0 ? [waiting] : completed
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
          resolvePermission: () => Effect.void,
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
        while (!events.some((event) => event._tag === "TranscriptPatched" && event.event.cursor === "wait"))
          yield* Effect.yieldNow
        yield* session.resolvePermission("wait-child", "permission", "allow")
        while (!events.some((event) => event._tag === "TranscriptPatched" && event.event.cursor === "done"))
          yield* Effect.yieldNow

        expect(yield* Ref.get(childFollows)).toEqual([undefined, "wait"])
        const childCursors = events.flatMap((event) =>
          event._tag === "TranscriptPatched" && event.turnId === childId ? [event.event.cursor] : [],
        )
        expect(childCursors).toEqual(["wait", "answer", "done"])

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("interrupts child followers on cancel, selection change, and session close", () =>
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
                cursor: `spawn-${input.turnId}`,
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
              ? Queue.offer(followed, { executionId, ...(afterCursor === undefined ? {} : { afterCursor }) }).pipe(
                  Effect.tap(() =>
                    afterCursor === undefined
                      ? Effect.sync(() =>
                          onEvent?.({
                            cursor: `${executionId}:cursor`,
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
                return {
                  turnId,
                  status: values.includes(turnId) ? ("cancelled" as const) : ("running" as const),
                  waits: [],
                  pendingTools: [],
                  children: turnId.includes(":child:")
                    ? []
                    : [
                        {
                          executionId: childId,
                          status: values.includes(childId) ? ("cancelled" as const) : ("running" as const),
                        },
                      ],
                }
              }),
            ),
          cancel: (turnId) => {
            const events: ReadonlyArray<ExecutionBackend.Event> = turnId.includes(":child:")
              ? [
                  {
                    cursor: `${turnId}:cursor`,
                    sequence: 0,
                    type: "model.output.delta",
                    createdAt: 2,
                    text: "working",
                  },
                  {
                    cursor: `${turnId}:cancelled`,
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
        expect(new Set(yield* Ref.get(cancelled))).toEqual(new Set(["turn-1:child:worker", "turn-1"]))
        while (
          !events.some(
            (event) => event._tag === "TranscriptPatched" && event.event.cursor === "turn-1:child:worker:cancelled",
          )
        )
          yield* Effect.yieldNow
        expect(
          events.flatMap((event) =>
            event._tag === "TranscriptPatched" && event.turnId === "turn-1:child:worker" ? [event.event.cursor] : [],
          ),
        ).toEqual(["turn-1:child:worker:cursor", "turn-1:child:worker:cancelled"])

        yield* session.submit("selected away")
        expect(yield* Queue.take(followed)).toEqual({ executionId: "turn-2:child:worker" })
        yield* session.selectThread(second.id, 2)
        expect(yield* Queue.take(stopped)).toBe("turn-2:child:worker")
        yield* session.selectThread(first.id, 3)
        expect(yield* Queue.take(followed)).toEqual({
          executionId: "turn-2:child:worker",
          afterCursor: "turn-2:child:worker:cursor",
        })
        yield* session.selectThread(second.id, 4)
        expect(yield* Queue.take(stopped)).toBe("turn-2:child:worker")

        yield* session.submit("closed")
        expect(yield* Queue.take(followed)).toEqual({ executionId: "turn-3:child:worker" })
        yield* Fiber.interrupt(operationFiber)
        expect(yield* Queue.take(stopped)).toBe("turn-3:child:worker")
        yield* Fiber.interrupt(feed)
      }),
    ),
  )
})
