import * as InteractiveEvent from "@rika/product/interactive-event"
import * as ProductOperation from "@rika/product/product-operation"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Service } from "@rika/product/product-operation-service"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ThreadView from "@rika/product/thread-view"
import * as ExecutionProjection from "@rika/product/execution-projection"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Config, Console, Effect, Exit, FileSystem, Layer, Logger, Path, Ref, Schema, Scope } from "effect"
import { serve } from "@rika/server/server-host-transport"
import * as ServerProcessStartup from "@rika/server/server-process-launch"

let activeWork = 0

const fixtureTurn = (threadId: Thread.ThreadId, turnId: Turn.TurnId, prompt: string): Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: turnId,
  threadId,
  prompt,
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  status: "running",
  createdAt: 0,
  updatedAt: 0,
})

const fixtureThread = (threadId: Thread.ThreadId): Thread.Thread => ({
  id: threadId,
  workspace: "/fixture",
  title: "Fixture thread",
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 0,
  updatedAt: 0,
})

const makeFixtureView = (
  dispatch: (event: InteractiveEvent) => void,
  threadId: Thread.ThreadId,
  turnId: Turn.TurnId,
  prompt: string,
) => {
  const turn = fixtureTurn(threadId, turnId, prompt)
  let viewRevision = 0
  let projectionRevision = 0
  dispatch({
    _tag: "ThreadViewSnapshot",
    snapshot: {
      thread: fixtureThread(threadId),
      source: { projectionVersion: 1 },
      turns: [
        {
          turn: ThreadView.turnRecord(turn),
          units: [],
          projectionRevision,
          usage: ExecutionProjection.emptyUsageState(),
        },
      ],
      pending: [],
      hasOlder: false,
      hasNewer: false,
      usage: { state: ExecutionProjection.emptyUsageState() },
      revision: viewRevision,
    },
  })
  const emit = (upsert: ReadonlyArray<TranscriptUnit.Unit>, remove: ReadonlyArray<string> = []) => {
    const baseRevision = viewRevision
    viewRevision += 1
    projectionRevision += 1
    dispatch({
      _tag: "ThreadViewPatch",
      patch: {
        threadId,
        baseRevision,
        revision: viewRevision,
        upsert,
        remove,
        turnChanges: [
          {
            _tag: "UpsertTurn",
            turn: ThreadView.turnRecord(turn),
            projectionRevision,
            usage: ExecutionProjection.emptyUsageState(),
          },
        ],
        header: {
          thread: fixtureThread(threadId),
          source: { projectionVersion: 1 },
          pending: [],
          hasOlder: false,
          hasNewer: false,
          usage: { state: ExecutionProjection.emptyUsageState() },
        },
      },
    })
  }
  const entry = (text: string): TranscriptUnit.Unit => ({
    key: `fixture-entry:${turnId}`,
    turnId: String(turnId),
    order: [{ sequence: 1, part: 0, key: `fixture-entry:${turnId}` }],
    revision: projectionRevision + 1,
    content: { _tag: "Entry", role: "assistant", text },
  })
  const tool = (id: string, status: "running" | "complete"): TranscriptUnit.Unit => ({
    key: `fixture-tool:${turnId}:${id}`,
    turnId: String(turnId),
    order: [{ sequence: id === "first" ? 1 : 2, part: 0, key: `fixture-tool:${turnId}:${id}` }],
    revision: projectionRevision + 1,
    content: {
      _tag: "Block",
      block: {
        _tag: "ToolCall",
        id: `fixture-tool-${id}`,
        name: "read",
        input: JSON.stringify({ path: `${id}.ts` }),
        status,
        presentation: {
          family: "explore",
          action: "read",
          activeLabel: "Reading",
          completeLabel: "Read",
          outputDisplay: "inline",
        },
        detail: `${id}.ts`,
        ...(status === "complete" ? { output: id } : {}),
        files: [],
      },
    },
  })
  return { emit, entry, tool }
}

const program = Effect.gen(function* () {
  const dataRoot = yield* Config.string("RIKA_TEST_SERVER_DATA_ROOT")
  const grace = yield* Config.string("RIKA_TEST_SERVER_GRACE").pipe(Config.withDefault("500"))
  const startupHold = yield* Config.string("RIKA_TEST_SERVER_STARTUP_HOLD").pipe(Config.withDefault("0"))
  const finalizerDelay = Number(yield* Config.string("RIKA_TEST_SERVER_FINALIZER_DELAY").pipe(Config.withDefault("0")))
  const ownerStartupDelay = Number(
    yield* Config.string("RIKA_TEST_SERVER_OWNER_STARTUP_DELAY").pipe(Config.withDefault("0")),
  )
  const delayedWork = (yield* Config.string("RIKA_TEST_SERVER_DELAYED_WORK").pipe(Config.withDefault("0"))) === "1"
  const activeWorkMilliseconds = Number(
    yield* Config.string("RIKA_TEST_SERVER_ACTIVE_WORK_MILLIS").pipe(Config.withDefault("0")),
  )
  const uninterruptibleOwner =
    (yield* Config.string("RIKA_TEST_SERVER_UNINTERRUPTIBLE_OWNER").pipe(Config.withDefault("0"))) === "1"
  const outboundCapacity = yield* Config.int("RIKA_TEST_SERVER_OUTBOUND_CAPACITY").pipe(Config.withDefault(1_024))
  const abandonMilliseconds = Number(yield* Config.string("RIKA_TEST_SERVER_ABANDON").pipe(Config.withDefault("5000")))
  activeWork = Number(yield* Config.string("RIKA_TEST_SERVER_INITIAL_ACTIVE_WORK").pipe(Config.withDefault("0")))
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const interactiveAdmissionActive = yield* Ref.make(0)
  const interactiveAdmissionMaximum = yield* Ref.make(0)
  const interactiveAdmissions = yield* Ref.make<ReadonlyArray<number>>([])
  const interactiveActive = yield* Ref.make(0)
  const interactiveMaximum = yield* Ref.make(0)
  const interactiveCompletions = yield* Ref.make<ReadonlyArray<number>>([])
  const interactiveExecutionScope = yield* Scope.make()
  const append = (name: string, value: string) =>
    fs.writeFileString(path.join(dataRoot, name), value, { flag: "a" }).pipe(Effect.orDie)
  return yield* serve({
    profile: "default",
    dataRoot,
    graceMilliseconds: Number(grace),
    abandonMilliseconds,
    startupHoldMilliseconds: Number(startupHold),
    outboundCapacity,
    onReady: ServerProcessStartup.signalReady,
    owner: (interactive) =>
      Effect.gen(function* () {
        yield* append("owner-acquisitions.log", `${process.pid}\n`)
        yield* Effect.sleep(ownerStartupDelay)
        yield* Effect.addFinalizer(() =>
          append("owner-finalizer-starts.log", `${process.pid}:${activeWork}\n`).pipe(
            Effect.andThen(
              uninterruptibleOwner
                ? Effect.never.pipe(Effect.uninterruptible)
                : Effect.sleep(finalizerDelay).pipe(
                    Effect.andThen(append("owner-finalizations.log", `${process.pid}\n`)),
                    Effect.andThen(Scope.close(interactiveExecutionScope, Exit.void)),
                  ),
            ),
          ),
        )
        return Service.of({
          hasActiveExecutionWork: Effect.sync(() => activeWork > 0),
          authorizeServerReplacement: Effect.sync(() => (activeWork > 0 ? "defer" : "supersede")),
          stopActiveExecutionWork: Effect.sync(() => {
            activeWork = 0
          }).pipe(Effect.andThen(append("stop-work.log", `${process.pid}\n`))),
          run: (input) => {
            if (input._tag !== "Interactive")
              return Effect.suspend(() => {
                if (input._tag === "Run" && input.prompt[0] === "oversized-output")
                  return Console.log("x".repeat(1_100_000))
                if (!delayedWork || input._tag !== "Run")
                  return Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)({ hostPid: process.pid }).pipe(
                    Effect.flatMap(Console.log),
                    Effect.orDie,
                  )
                const delegated = input.prompt[0] === "active-root-with-child"
                return Effect.sync(() => {
                  activeWork += delegated ? 2 : 1
                }).pipe(
                  Effect.andThen(append("delayed-work-starts.log", `${process.pid}\n`)),
                  Effect.andThen(
                    delegated
                      ? append("active-executions.log", `${process.pid}:root\n${process.pid}:child\n`)
                      : Effect.void,
                  ),
                  Effect.andThen(
                    delegated && activeWorkMilliseconds > 0 ? Effect.sleep(activeWorkMilliseconds) : Effect.never,
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      activeWork -= delegated ? 2 : 1
                    }).pipe(Effect.andThen(append("delayed-work-finalizations.log", `${process.pid}\n`))),
                  ),
                )
              })
            if (input.prompt[0] === "reject-before-start")
              return Effect.fail(
                ProductOperation.OperationUnavailable.make({
                  operation: "Interactive",
                  message: "Interactive setup rejected",
                }),
              )
            return interactive(input, {
              events: (dispatch) => {
                const kind = input.prompt[0]
                if (kind === "wire-limit-event")
                  return Effect.sync(() =>
                    dispatch({
                      _tag: "ExecutionFailed",
                      failure: {
                        tag: "TestFailure",
                        message: "x".repeat(20_000_000),
                        category: "operation",
                        retryable: false,
                        retry: "none",
                        actor: "environment",
                      },
                    }),
                  ).pipe(Effect.andThen(Effect.never))
                if (kind === "large-event-a" || kind === "large-event-b")
                  return Effect.sync(() =>
                    dispatch({
                      _tag: "ExecutionFailed",
                      failure: {
                        tag: "TestFailure",
                        message: kind.at(-1)!.repeat(8_000_000),
                        category: "operation",
                        retryable: false,
                        retry: "none",
                        actor: "environment",
                      },
                    }),
                  ).pipe(Effect.andThen(Effect.never))
                if (kind === "slow-consumer-events")
                  return Effect.gen(function* () {
                    const view = makeFixtureView(
                      dispatch,
                      Thread.ThreadId.make("slow-consumer-thread"),
                      Turn.TurnId.make("slow-consumer-turn"),
                      "slow consumer",
                    )
                    const emitPatch = (index: number) => Effect.sync(() => view.emit([view.entry(String(index))]))
                    yield* Effect.forEach(
                      Array.from({ length: outboundCapacity }, (_, index) => index),
                      emitPatch,
                      { discard: true },
                    )
                    yield* Effect.sleep("250 millis")
                    yield* emitPatch(outboundCapacity)
                    yield* Effect.sync(() => view.emit([view.entry("completed")]))
                    return yield* Effect.never
                  })
                if (kind === "timed-tool-events")
                  return Effect.gen(function* () {
                    const threadId = Thread.ThreadId.make("timed-tool-thread")
                    const turnId = Turn.TurnId.make("timed-tool-turn")
                    const view = makeFixtureView(dispatch, threadId, turnId, "timed tools")
                    const patch = (callId: string, status: "running" | "complete") =>
                      Effect.sync(() => view.emit([view.tool(callId, status)]))
                    yield* patch("first", "running")
                    yield* patch("second", "running")
                    yield* Effect.sleep("200 millis")
                    yield* patch("first", "complete")
                    yield* Effect.sleep("200 millis")
                    yield* patch("second", "complete")
                    return yield* Effect.never
                  })
                return Effect.sync(() => {
                  if (kind === "feed-takeover") {
                    dispatch({ _tag: "ThreadsListed", threads: [] })
                    return true
                  }
                  if (kind === "child-execution-events") {
                    const threadId = Thread.ThreadId.make("child-feed-thread")
                    const parentTurnId = Turn.TurnId.make("parent-turn")
                    const view = makeFixtureView(dispatch, threadId, parentTurnId, "parent turn")
                    view.emit([view.entry("Child started")])
                    view.emit([view.entry("Child read src/a.ts")])
                    view.emit([view.entry("Child review complete")])
                    return true
                  }
                  if (kind === "overflow-events") {
                    const view = makeFixtureView(
                      dispatch,
                      Thread.ThreadId.make("overflow-thread"),
                      Turn.TurnId.make("overflow-turn"),
                      "overflow",
                    )
                    for (let index = 0; index < 10; index += 1) view.emit([view.entry(String(index))])
                    return true
                  }
                  if (kind === "queue-overflow-events") {
                    const view = makeFixtureView(
                      dispatch,
                      Thread.ThreadId.make("queue-overflow-thread"),
                      Turn.TurnId.make("queue-overflow-turn"),
                      "queue overflow",
                    )
                    for (let index = 0; index < 10; index += 1) view.emit([view.entry(String(index))])
                    return true
                  }
                  const count = kind === "burst-events" ? 1_000 : 1
                  for (let index = 0; index < count; index += 1) {
                    if (kind === "oversized-event")
                      dispatch({
                        _tag: "ExecutionFailed",
                        failure: {
                          tag: "TestFailure",
                          message: "x".repeat(1_100_000),
                          category: "operation",
                          retryable: false,
                          retry: "none",
                          actor: "environment",
                        },
                      })
                    else dispatch({ _tag: "ThreadsListed", threads: [] })
                  }
                  return true
                }).pipe(
                  Effect.flatMap((started) => {
                    if (!started) return Effect.never
                    if (input.prompt[0] === "feed-takeover")
                      return Effect.sleep("100 millis").pipe(
                        Effect.andThen(Effect.sync(() => dispatch({ _tag: "ThreadsListed", threads: [] }))),
                        Effect.andThen(Effect.never),
                      )
                    if (input.prompt[0] !== "overflow-watch") return Effect.never
                    return Effect.sync(() => {
                      const view = makeFixtureView(
                        dispatch,
                        Thread.ThreadId.make("overflow-thread"),
                        Turn.TurnId.make("overflow-turn"),
                        "overflow watch",
                      )
                      for (let index = 0; index < 10; index += 1) view.emit([view.entry(String(index))])
                    }).pipe(
                      Effect.andThen(Effect.sleep("50 millis")),
                      Effect.andThen(Effect.sync(() => dispatch({ _tag: "ThreadsListed", threads: [] }))),
                      Effect.andThen(Effect.never),
                    )
                  }),
                )
              },
              submit: (prompt, _mode, parts) => {
                if (prompt === "ambiguous")
                  return append("mutation-attempts.log", `${process.pid}\n`).pipe(
                    Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGKILL"))),
                    Effect.asVoid,
                  )
                if (prompt === "oversized-submit")
                  return Effect.suspend(() => {
                    const image = parts?.find((part) => part.type === "image")
                    return fs
                      .writeFileString(
                        path.join(dataRoot, "oversized-submit.json"),
                        String(image !== undefined && image.type === "image" ? image.data.length : 0),
                      )
                      .pipe(Effect.orDie, Effect.asVoid)
                  })
                if (prompt.startsWith("serialized-"))
                  return Effect.gen(function* () {
                    const index = Number(prompt.slice("serialized-".length))
                    const admissionActive = yield* Ref.updateAndGet(interactiveAdmissionActive, (value) => value + 1)
                    yield* Ref.update(interactiveAdmissionMaximum, (value) => Math.max(value, admissionActive))
                    yield* Ref.update(interactiveAdmissions, (values) => [...values, index])
                    const execution = Effect.gen(function* () {
                      const active = yield* Ref.updateAndGet(interactiveActive, (value) => value + 1)
                      yield* Ref.update(interactiveMaximum, (value) => Math.max(value, active))
                      yield* Effect.sleep(`${1 + ((99 - index) % 10)} millis`)
                      const completions = yield* Ref.updateAndGet(interactiveCompletions, (values) => [
                        ...values,
                        index,
                      ])
                      if (completions.length === 4) {
                        const admissionMaximum = yield* Ref.get(interactiveAdmissionMaximum)
                        const admissions = yield* Ref.get(interactiveAdmissions)
                        const executionMaximum = yield* Ref.get(interactiveMaximum)
                        const encoded = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)({
                          admissionMaximum,
                          admissions,
                          executionMaximum,
                          completions,
                        })
                        yield* fs
                          .writeFileString(path.join(dataRoot, "interactive-serialization.json"), encoded)
                          .pipe(Effect.orDie)
                      }
                    }).pipe(Effect.ensuring(Ref.update(interactiveActive, (value) => value - 1)))
                    yield* Effect.forkIn(execution, interactiveExecutionScope)
                  }).pipe(Effect.ensuring(Ref.update(interactiveAdmissionActive, (value) => value - 1)))
                return Effect.void
              },
              shell: () => Effect.void,
              editQueued: () => Effect.void,
              dequeue: () => Effect.void,
              steerQueued: () => Effect.void,
              steer: () => Effect.void,
              interruptAndSend: () => Effect.void,
              cancel: Effect.void,
              quit: Effect.sync(() => {
                activeWork = 0
              }).pipe(Effect.andThen(append("quit-commands.log", `${process.pid}\n`))),
              newThread: Effect.void,
              selectThread: () => Effect.void,
              readQueue: () => Effect.void,
              loadOlder: () => Effect.void,
              loadNewer: () => Effect.void,
              previewThread: () => Effect.void,
              reopenThread: () => Effect.void,
            })
          },
        })
      }),
  })
})

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.mergeAll(BunServices.layer, BunCrypto.layer, Logger.layer([])))
      yield* Effect.provide(program, context)
    }),
  ),
)
