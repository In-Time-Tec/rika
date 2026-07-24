import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Operation } from "@rika/app"
import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import { Config, Console, Effect, Exit, FileSystem, Layer, Logger, Path, Ref, Schema, Scope } from "effect"
import { serve } from "../../src/resident-host-transport"
import * as ResidentProcessStartup from "../../src/resident-process-startup"

let activeWork = 0

const program = Effect.gen(function* () {
  const dataRoot = yield* Config.string("RIKA_TEST_RESIDENT_DATA_ROOT")
  const grace = yield* Config.string("RIKA_TEST_RESIDENT_GRACE").pipe(Config.withDefault("500"))
  const startupHold = yield* Config.string("RIKA_TEST_RESIDENT_STARTUP_HOLD").pipe(Config.withDefault("0"))
  const finalizerDelay = Number(
    yield* Config.string("RIKA_TEST_RESIDENT_FINALIZER_DELAY").pipe(Config.withDefault("0")),
  )
  const ownerStartupDelay = Number(
    yield* Config.string("RIKA_TEST_RESIDENT_OWNER_STARTUP_DELAY").pipe(Config.withDefault("0")),
  )
  const delayedWork = (yield* Config.string("RIKA_TEST_RESIDENT_DELAYED_WORK").pipe(Config.withDefault("0"))) === "1"
  const activeWorkMilliseconds = Number(
    yield* Config.string("RIKA_TEST_RESIDENT_ACTIVE_WORK_MILLIS").pipe(Config.withDefault("0")),
  )
  const uninterruptibleOwner =
    (yield* Config.string("RIKA_TEST_RESIDENT_UNINTERRUPTIBLE_OWNER").pipe(Config.withDefault("0"))) === "1"
  const outboundCapacity = yield* Config.int("RIKA_TEST_RESIDENT_OUTBOUND_CAPACITY").pipe(Config.withDefault(1_024))
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
    startupHoldMilliseconds: Number(startupHold),
    outboundCapacity,
    onReady: ResidentProcessStartup.signalReady,
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
        return Operation.Service.of({
          hasActiveExecutionWork: Effect.sync(() => activeWork > 0),
          authorizeResidentReplacement: Effect.sync(() => (activeWork > 0 ? "defer" : "supersede")),
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
                Operation.OperationUnavailable.make({
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
                      selectionEpoch: 0,
                      message: "x".repeat(20_000_000),
                    }),
                  ).pipe(Effect.andThen(Effect.never))
                if (kind === "large-event-a" || kind === "large-event-b")
                  return Effect.sync(() =>
                    dispatch({
                      _tag: "ExecutionFailed",
                      selectionEpoch: 0,
                      message: kind.at(-1)!.repeat(8_000_000),
                    }),
                  ).pipe(Effect.andThen(Effect.never))
                if (kind === "slow-consumer-events")
                  return Effect.gen(function* () {
                    const emitPatch = (index: number) =>
                      Effect.sync(() =>
                        dispatch({
                          _tag: "TranscriptPatched",
                          selectionEpoch: 0,
                          threadId: Thread.ThreadId.make("slow-consumer-thread"),
                          turnId: Turn.TurnId.make("slow-consumer-turn"),
                          event: {
                            cursor: `slow-consumer-${index}`,
                            sequence: index,
                            type: "model.output.delta",
                            createdAt: index,
                            text: String(index),
                          },
                          revision: index,
                        }),
                      )
                    yield* Effect.forEach(
                      Array.from({ length: outboundCapacity }, (_, index) => index),
                      emitPatch,
                      { discard: true },
                    )
                    yield* Effect.sleep("250 millis")
                    yield* emitPatch(outboundCapacity)
                    yield* Effect.sync(() =>
                      dispatch({
                        _tag: "TranscriptPatched",
                        selectionEpoch: 0,
                        threadId: Thread.ThreadId.make("slow-consumer-thread"),
                        turnId: Turn.TurnId.make("slow-consumer-turn"),
                        event: {
                          cursor: "slow-consumer-completed",
                          sequence: outboundCapacity + 1,
                          type: "execution.completed",
                          createdAt: outboundCapacity + 1,
                        },
                        revision: outboundCapacity + 1,
                      }),
                    )
                    return yield* Effect.never
                  })
                if (kind === "timed-tool-events")
                  return Effect.gen(function* () {
                    const threadId = Thread.ThreadId.make("timed-tool-thread")
                    const turnId = Turn.TurnId.make("timed-tool-turn")
                    const patch = (
                      sequence: number,
                      type: "tool.call.requested" | "tool.result.received",
                      callId: string,
                    ) =>
                      Effect.sync(() =>
                        dispatch({
                          _tag: "TranscriptPatched",
                          selectionEpoch: 0,
                          threadId,
                          turnId,
                          event: {
                            cursor: `timed-tool-${sequence}`,
                            sequence,
                            type,
                            createdAt: sequence * 200,
                            data:
                              type === "tool.call.requested"
                                ? {
                                    tool_call_id: callId,
                                    tool_name: "read",
                                    input: { path: `${callId}.ts` },
                                  }
                                : { tool_call_id: callId, output: callId },
                          },
                          revision: sequence,
                        }),
                      )
                    yield* patch(0, "tool.call.requested", "first")
                    yield* patch(1, "tool.call.requested", "second")
                    yield* Effect.sleep("200 millis")
                    yield* patch(2, "tool.result.received", "first")
                    yield* Effect.sleep("200 millis")
                    yield* patch(3, "tool.result.received", "second")
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
                    const childTurnId = Turn.TurnId.make("parent-turn:child:oracle")
                    dispatch({
                      _tag: "TranscriptPatched",
                      selectionEpoch: 0,
                      threadId,
                      turnId: parentTurnId,
                      event: {
                        cursor: "child-spawned",
                        sequence: 1,
                        type: "child_run.spawned",
                        createdAt: 1,
                        data: {
                          tool_call_id: "oracle",
                          child_execution_id: "execution:parent-turn:child:oracle",
                        },
                      },
                      revision: 1,
                    })
                    dispatch({
                      _tag: "TranscriptPatched",
                      selectionEpoch: 0,
                      threadId,
                      turnId: childTurnId,
                      event: {
                        cursor: "child-tool",
                        sequence: 0,
                        type: "tool.call.requested",
                        createdAt: 2,
                        data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
                      },
                      revision: 0,
                    })
                    dispatch({
                      _tag: "TranscriptPatched",
                      selectionEpoch: 0,
                      threadId,
                      turnId: childTurnId,
                      event: {
                        cursor: "child-response",
                        sequence: 1,
                        type: "model.output.completed",
                        createdAt: 3,
                        text: "## Review complete",
                      },
                      revision: 1,
                    })
                    return true
                  }
                  let count = 1
                  if (kind === "burst-events") count = 1_000
                  else if (kind === "overflow-events" || kind === "queue-overflow-events") count = 10
                  for (let index = 0; index < count; index += 1) {
                    if (kind === "overflow-events")
                      dispatch({
                        _tag: "TranscriptPatched",
                        selectionEpoch: 0,
                        threadId: Thread.ThreadId.make("overflow-thread"),
                        turnId: Turn.TurnId.make("overflow-turn"),
                        event: {
                          cursor: `overflow-${index}`,
                          sequence: index,
                          type: "model.output.delta",
                          createdAt: index,
                          text: String(index),
                        },
                        revision: index,
                      })
                    else if (kind === "queue-overflow-events")
                      dispatch({
                        _tag: "QueueUpdated",
                        selectionEpoch: 0,
                        threadId: Thread.ThreadId.make("queue-overflow-thread"),
                        revision: index + 1,
                        queuedCount: index + 1,
                        change: {
                          _tag: "Added",
                          item: {
                            id: Turn.TurnId.make(`queue-overflow-turn-${index}`),
                            prompt: `queued ${index}`,
                          },
                        },
                      })
                    else if (kind === "oversized-event")
                      dispatch({
                        _tag: "ExecutionFailed",
                        selectionEpoch: 0,
                        message: "x".repeat(1_100_000),
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
                      for (let index = 0; index < 10; index += 1)
                        dispatch({
                          _tag: "TranscriptPatched",
                          selectionEpoch: 0,
                          threadId: Thread.ThreadId.make("overflow-thread"),
                          turnId: Turn.TurnId.make("overflow-turn"),
                          event: {
                            cursor: `watch-overflow-${index}`,
                            sequence: index,
                            type: "model.output.delta",
                            createdAt: index,
                            text: String(index),
                          },
                          revision: index,
                        })
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
              newThread: Effect.void,
              resolvePermission: () => Effect.void,
              selectThread: () => Effect.void,
              readQueue: () => Effect.void,
              loadOlder: Effect.void,
              previewThread: () => Effect.void,
              reopenThread: () => Effect.void,
              replay: () => Effect.void,
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
