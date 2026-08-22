import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Service } from "@rika/product/product-operation-service"
import { productLayer } from "@rika/product/product-operation-service"
import * as RuntimeContract from "@rika/coding-tools/coding-tool-runtime"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/postgres-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as ThreadSummaryRepository from "@rika/product-store/postgres-thread-summary-repository"
import * as TranscriptRepository from "@rika/product-store/postgres-transcript-repository"
import * as TurnRepository from "@rika/product-store/postgres-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { Context, Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { executionSessionLifecycleLayerTest } from "../support/operation-layer-harness"

const backend = ExecutionGateway.Service.of({
  startTurn: () => Effect.die("unused"),
  cancelTurn: () => Effect.die("unused"),
  steerTurn: () => Effect.die("unused"),
  approveTurn: () => Effect.void,
  denyTurn: () => Effect.void,
  watchTurn: () => Stream.die("unused"),
  inspectTurn: () => Effect.succeed({ status: "unavailable" }),
})

interface HarnessOptions {
  readonly runTool: ToolRuntime.Interface["run"]
  readonly transcriptService?: (base: TranscriptRepository.Interface) => TranscriptRepository.Interface
  readonly turnService?: (
    base: import("@rika/product/turn-repository").Interface,
  ) => import("@rika/product/turn-repository").Interface
  readonly ensureSummary?: ThreadSummaryRepository.Interface["ensureTurn"]
  readonly makeTurnId?: Effect.Effect<Turn.TurnId>
}

const makeHarness = Effect.fn("RecordedShellSessionTest.makeHarness")(function* (options: HarnessOptions) {
  const threadId = Thread.ThreadId.make("recorded-shell-thread")
  const turnId = Turn.TurnId.make("recorded-shell-turn")
  const threads = yield* ThreadRepository.makeMemory()
  const baseTurns = yield* TurnRepository.makeMemory()
  const turns = TurnRepository.Service.of(options.turnService?.(baseTurns) ?? baseTurns)
  const transcripts = yield* TranscriptRepository.makeMemory({ turns })
  const sessionReady = yield* Deferred.make<InteractiveSession>()
  const releaseSession = yield* Deferred.make<void>()
  const events: Array<InteractiveEvent> = []
  const summaries = ThreadSummaryRepository.Service.of({
    list: () => Effect.succeed([]),
    ensureTurn: options.ensureSummary ?? (() => Effect.void),
    replaceTurn: () => Effect.void,
    markRead: () => Effect.void,
    listRepairCandidates: () => Effect.succeed([]),
  })
  const layer = productLayer({
    executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
    repositoryLayer: Layer.succeed(ThreadRepository.Service, threads),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    threadSummaryRepositoryLayer: Layer.succeed(ThreadSummaryRepository.Service, summaries),
    transcriptRepositoryLayer: Layer.succeed(
      TranscriptRepository.Service,
      TranscriptRepository.Service.of(options.transcriptService?.(transcripts) ?? transcripts),
    ),
    backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
    toolRuntimeLayer: () => ToolRuntime.testLayer(options.runTool),
    defaultWorkspace: "/work",
    makeThreadId: Effect.succeed(threadId),
    makeTurnId: options.makeTurnId ?? Effect.succeed(turnId),
    interactive: (_, session) =>
      Deferred.succeed(sessionReady, session).pipe(Effect.andThen(Deferred.await(releaseSession))),
  })
  const operation = Context.get(yield* Layer.build(layer), Service)
  const operationFiber = yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
  const session = yield* Deferred.await(sessionReady)
  yield* Effect.forkChild(session.events((event) => events.push(event)))
  yield* Effect.yieldNow
  const waitForEvent = (predicate: (event: InteractiveEvent) => boolean) =>
    Effect.gen(function* () {
      while (!events.some(predicate)) yield* Effect.yieldNow
    })
  const close = Deferred.succeed(releaseSession, undefined).pipe(
    Effect.andThen(Fiber.join(operationFiber)),
    Effect.asVoid,
  )
  return { close, events, session, threadId, threads, transcripts, turnId, turns, waitForEvent }
})

describe("recorded shell session", () => {
  it.effect("keeps completion and persistence bound to the launch thread after selection changes", () =>
    Effect.gen(function* () {
      let turnSequence = 0
      const processStarted = yield* Deferred.make<void>()
      const finishProcess = yield* Deferred.make<void>()
      const harness = yield* makeHarness({
        makeTurnId: Effect.sync(() => Turn.TurnId.make(`recorded-shell-turn-${turnSequence++}`)),
        runTool: (request) =>
          request._tag === "Shell"
            ? Deferred.succeed(processStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishProcess)),
                Effect.as({
                  text: `finished:${request.args.join(" ")}`,
                  truncated: false,
                  running: false,
                  exitCode: 0,
                }),
              )
            : Effect.die("unexpected tool request"),
      })
      const launchThread = harness.threadId
      const otherThread = Thread.ThreadId.make("other-shell-thread")
      yield* harness.session.newThread
      yield* harness.threads.create({
        id: otherThread,
        workspace: "/work",
        title: "Other thread",
        now: 1,
      })

      yield* harness.session.shell(launchThread, "stay with launch thread", false)
      yield* Deferred.await(processStarted)
      expect(yield* harness.turns.list(launchThread)).toEqual([
        expect.objectContaining({
          _tag: "RecordedShell",
          threadId: launchThread,
          command: "stay with launch thread",
          status: "running",
        }),
      ])

      yield* harness.session.selectThread(otherThread)
      yield* Deferred.succeed(finishProcess, undefined)
      yield* harness.waitForEvent(
        (event) => event._tag === "ShellCompleted" && event.command === "stay with launch thread",
      )
      const completion = harness.events.find(
        (event) => event._tag === "ShellCompleted" && event.command === "stay with launch thread",
      )
      expect(completion).toMatchObject({
        threadId: launchThread,
        incognito: false,
        status: "completed",
      })
      expect(yield* harness.turns.list(otherThread)).toEqual([])
      const launchTurns = yield* harness.turns.list(launchThread)
      expect(launchTurns).toEqual([
        expect.objectContaining({
          _tag: "RecordedShell",
          threadId: launchThread,
          command: "stay with launch thread",
          status: "completed",
        }),
      ])
      expect(yield* harness.transcripts.get(launchTurns[0]!.id)).toMatchObject({
        turn: { threadId: launchThread, command: "stay with launch thread", status: "completed" },
      })
      yield* harness.session.selectThread(launchThread)
      yield* harness.close
    }),
  )

  it.effect("does not launch a process when the atomic running write fails", () =>
    Effect.gen(function* () {
      const launches = yield* Ref.make(0)
      const harness = yield* makeHarness({
        runTool: () =>
          Ref.update(launches, (count) => count + 1).pipe(
            Effect.as({ text: "unreachable", truncated: false, running: false, exitCode: 0 }),
          ),
        turnService: (base) => ({
          ...base,
          createRecordedShell: () =>
            Effect.fail(TurnRepository.RepositoryError.make({ message: "forced running write failure" })),
        }),
      })

      yield* harness.session.shell(undefined, "must not run", false)
      yield* harness.waitForEvent((event) => event._tag === "ExecutionFailed")

      expect(yield* Ref.get(launches)).toBe(0)
      expect(yield* harness.turns.get(harness.turnId)).toBeUndefined()
      expect(yield* harness.transcripts.get(harness.turnId)).toBeUndefined()
      expect(harness.events.some((event) => event._tag === "ShellCompleted")).toBe(false)
      yield* harness.close
    }),
  )

  it.effect("does not publish terminal completion when the atomic settlement fails", () =>
    Effect.gen(function* () {
      const launches = yield* Ref.make(0)
      const harness = yield* makeHarness({
        runTool: () =>
          Ref.update(launches, (count) => count + 1).pipe(
            Effect.as({ text: "finished", truncated: false, running: false, exitCode: 0 }),
          ),
        turnService: (base) => ({
          ...base,
          settleRecordedShell: () =>
            Effect.fail(TurnRepository.RepositoryError.make({ message: "forced settlement failure" })),
        }),
      })

      yield* harness.session.shell(undefined, "finish without publication", false)
      yield* harness.waitForEvent((event) => event._tag === "ExecutionFailed")

      expect(yield* Ref.get(launches)).toBe(1)
      expect(yield* harness.turns.get(harness.turnId)).toMatchObject({
        _tag: "RecordedShell",
        status: "running",
      })
      expect(yield* harness.transcripts.get(harness.turnId)).toMatchObject({
        turn: { _tag: "RecordedShell", status: "running" },
        revision: 0,
        checkpointGeneration: 0,
      })
      expect(harness.events.some((event) => event._tag === "ShellCompleted")).toBe(false)
      yield* harness.close
    }),
  )

  it.effect("cancels an interrupted process and atomically persists the cancelled terminal projection", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const cancelled = yield* Deferred.make<void>()
      const harness = yield* makeHarness({
        runTool: (request) =>
          request._tag === "Shell"
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
              )
            : Effect.die("unexpected tool request"),
      })

      yield* harness.session.shell(undefined, "wait forever", false)
      yield* Deferred.await(started)
      expect(yield* harness.turns.get(harness.turnId)).toMatchObject({
        _tag: "RecordedShell",
        status: "running",
      })

      yield* harness.close
      yield* Deferred.await(cancelled)

      expect(yield* harness.turns.get(harness.turnId)).toMatchObject({
        _tag: "RecordedShell",
        status: "cancelled",
        result: { text: "Shell command cancelled", truncated: false },
      })
      expect(yield* harness.transcripts.get(harness.turnId)).toMatchObject({
        turn: {
          _tag: "RecordedShell",
          status: "cancelled",
          result: { text: "Shell command cancelled", truncated: false },
        },
        revision: 1,
        checkpointGeneration: 1,
        units: [
          {
            revision: 1,
            content: {
              _tag: "Block",
              block: {
                _tag: "ToolCall",
                status: "cancelled",
                output: "Shell command cancelled",
                process: { truncated: false },
              },
            },
          },
        ],
      })
    }),
  )

  it.effect("settles cancellation without launching when interrupted after the running write", () =>
    Effect.gen(function* () {
      const summaryEntered = yield* Deferred.make<void>()
      const launches = yield* Ref.make(0)
      const harness = yield* makeHarness({
        ensureSummary: () => Deferred.succeed(summaryEntered, undefined).pipe(Effect.andThen(Effect.never)),
        runTool: () =>
          Ref.update(launches, (count) => count + 1).pipe(
            Effect.as({ text: "unreachable", truncated: false, running: false, exitCode: 0 }),
          ),
      })

      yield* harness.session.shell(undefined, "interrupt before launch", false)
      yield* Deferred.await(summaryEntered)
      expect(yield* harness.turns.get(harness.turnId)).toMatchObject({
        _tag: "RecordedShell",
        status: "running",
      })

      yield* harness.close

      expect(yield* Ref.get(launches)).toBe(0)
      expect(yield* harness.turns.get(harness.turnId)).toMatchObject({
        _tag: "RecordedShell",
        status: "cancelled",
        result: { text: "Shell command cancelled", truncated: false },
      })
      expect(yield* harness.transcripts.get(harness.turnId)).toMatchObject({
        turn: { _tag: "RecordedShell", status: "cancelled" },
        revision: 1,
        checkpointGeneration: 1,
      })
    }),
  )

  it.effect("persists a canonical failed projection when process launch fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        runTool: () =>
          Effect.fail(
            RuntimeContract.ToolError.make({
              tool: "shell",
              message: "process launch failed",
              kind: "operation",
              category: "dependency_unavailable",
              outcome: "known",
              recovery: "after_change",
              nextAction: "Restore the shell runtime",
            }),
          ),
      })

      yield* harness.session.shell(undefined, "unavailable command", false)
      yield* harness.waitForEvent((event) => event._tag === "ShellCompleted")

      const turn = yield* harness.turns.get(harness.turnId)
      expect(turn).toMatchObject({
        _tag: "RecordedShell",
        status: "failed",
        result: { text: expect.stringContaining("process launch failed"), truncated: false },
      })
      expect(turn?._tag === "RecordedShell" && turn.status !== "running" ? turn.result : {}).not.toHaveProperty(
        "exitCode",
      )
      expect(yield* harness.transcripts.get(harness.turnId)).toMatchObject({
        turn: { _tag: "RecordedShell", status: "failed" },
        revision: 1,
        checkpointGeneration: 1,
        units: [
          {
            content: {
              _tag: "Block",
              block: {
                _tag: "ToolCall",
                status: "failed",
                output: expect.stringContaining("process launch failed"),
                process: { truncated: false },
              },
            },
          },
        ],
      })
      yield* harness.close
    }),
  )

  it.effect("persists raw nonzero output once and records the exit code separately", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        runTool: (request) =>
          request._tag === "Shell"
            ? Effect.succeed({ text: "failed output\n", truncated: false, running: false, exitCode: 7 })
            : Effect.die("unexpected tool request"),
      })

      yield* harness.session.shell(undefined, "exit 7", false)
      yield* harness.waitForEvent((event) => event._tag === "ShellCompleted")

      expect(yield* harness.turns.get(harness.turnId)).toMatchObject({
        _tag: "RecordedShell",
        status: "failed",
        result: { text: "failed output\n", truncated: false, exitCode: 7 },
      })
      expect(yield* harness.transcripts.get(harness.turnId)).toMatchObject({
        turn: {
          _tag: "RecordedShell",
          status: "failed",
          result: { text: "failed output\n", truncated: false, exitCode: 7 },
        },
        units: [
          {
            revision: 1,
            content: {
              _tag: "Block",
              block: {
                _tag: "ToolCall",
                output: "failed output\n",
                process: { truncated: false, exitCode: 7 },
              },
            },
          },
        ],
        projectionVersion: ExecutionProjection.projectionVersion,
      })
      expect(harness.events.find((event) => event._tag === "ShellCompleted")).toMatchObject({
        command: "exit 7",
        text: "failed output\n",
        incognito: false,
        status: "failed",
      })
      yield* harness.close
    }),
  )
})
