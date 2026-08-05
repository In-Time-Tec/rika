import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Clock, Deferred, Duration, Effect, Fiber, Layer, Queue, Scope, Stream } from "effect"
import type { Part, TuiAppLane, ToolCallPart, TurnStep } from "./tui-app-model"

type Event = ExecutionEvent.Event
type Message = { readonly _tag: "Event"; readonly event: Event } | { readonly _tag: "Done" }

interface Execution {
  readonly runId: string
  readonly threadId: string
  readonly turnId: string
  readonly messages: Queue.Queue<Message>
  readonly history: Array<Event>
  readonly watching: Deferred.Deferred<void>
  wake: Deferred.Deferred<void>
  readonly steeringTexts: Array<string>
  steeringSequence: number
  steeringScheduled: boolean
  scheduleSteering?: (text: string) => Effect.Effect<void>
  status: "running" | "completed" | "failed" | "cancelled"
  fiber?: Fiber.RuntimeFiber<void, never>
}

interface Options {
  readonly lanes: ReadonlyArray<TuiAppLane>
  readonly toolRuntime: ToolRuntime.Interface
  readonly scope: Scope.Scope
  readonly holdChildEvents?: Deferred.Deferred<void>
  readonly modelRequested: () => void
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}

const string = (value: unknown): string => (typeof value === "string" ? value : "")

const number = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined)

const toolRequest = (part: ToolCallPart): ToolRuntime.Request | undefined => {
  const params = record(part.params)
  switch (part.name) {
    case "read":
      return { _tag: "Read", path: string(params.path) }
    case "bash":
      return {
        _tag: "Bash",
        command: string(params.command),
        ...(typeof params.workdir === "string" ? { workdir: params.workdir } : {}),
        ...(number(params.timeout_ms) === undefined ? {} : { timeoutMillis: number(params.timeout_ms)! }),
      }
    case "shell_command_status":
      return {
        _tag: "ShellCommandStatus",
        processId: string(params.processId),
        ...(number(params.waitMillis) === undefined ? {} : { waitMillis: number(params.waitMillis)! }),
      }
    default:
      return undefined
  }
}

export const layer = (options: Options): Layer.Layer<ExecutionGateway.Service> => {
  const laneOffsets = options.lanes.map(() => 0)
  const executions = new Map<string, Execution>()
  let nextChild = 0

  const selectLane = (prompt: string) => {
    const index = Math.max(
      0,
      options.lanes.findIndex((lane) => lane.when?.(prompt) === true),
    )
    return { index, lane: options.lanes[index]! }
  }

  return ExecutionGateway.layerTest({
    startTurn: (input) =>
      Effect.gen(function* () {
        const runId = `tui-run-${input.turnId}`
        const execution: Execution = {
          runId,
          threadId: input.threadId,
          turnId: input.turnId,
          messages: yield* Queue.unbounded<Message>(),
          history: [],
          watching: yield* Deferred.make<void>(),
          wake: yield* Deferred.make<void>(),
          steeringTexts: [],
          steeringSequence: 0,
          steeringScheduled: false,
          status: "running",
        }
        executions.set(runId, execution)

        const sequenceByExecution = new Map<string, number>()
        const event = Effect.fn("TuiApp.gatewayEvent")(function* (
          executionId: string,
          type: string,
          fields: Partial<Pick<Event, "text" | "content" | "data">> = {},
          isChild: boolean = false,
        ) {
          const sequence = (sequenceByExecution.get(executionId) ?? 0) + 1
          sequenceByExecution.set(executionId, sequence)
          const createdAt = yield* Clock.currentTimeMillis
          return {
            executionId,
            ...(isChild ? { childExecutionId: executionId } : {}),
            cursor: `${executionId}:${sequence}`,
            sequence,
            type,
            createdAt,
            timestampSource: "baton",
            ...fields,
          } satisfies Event
        })
        const emit = (emitted: Event) =>
          Effect.sync(() => execution.history.push(emitted)).pipe(
            Effect.andThen(Queue.offer(execution.messages, { _tag: "Event", event: emitted })),
            Effect.asVoid,
          )
        const wallDelay = (value: Duration.Input) => Effect.promise(() => Bun.sleep(Duration.toMillis(value)))
        const delay = (value: string | undefined) =>
          value === undefined
            ? Effect.void
            : Effect.raceFirst(wallDelay(value), Deferred.await(execution.wake)).pipe(Effect.asVoid)
        execution.scheduleSteering = (text) =>
          Effect.gen(function* () {
            execution.steeringTexts.push(text)
            if (execution.steeringScheduled) return
            execution.steeringScheduled = true
            yield* Effect.forkIn(
              wallDelay("500 millis").pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    const texts = execution.steeringTexts.splice(0)
                    const messageSequences = texts.map(() => execution.steeringSequence++)
                    execution.steeringScheduled = false
                    yield* emit(
                      yield* event(runId, "steering.delivered", {
                        text: texts.join(""),
                        content: texts.map((steeringText) => ({ type: "text", text: steeringText })),
                        data: {
                          kind: "steering",
                          drain_id: `${runId}:steering:${messageSequences.at(0) ?? 0}`,
                          message_sequences: messageSequences,
                          message_count: texts.length,
                        },
                      }),
                    )
                    yield* Deferred.succeed(execution.wake, undefined)
                    execution.wake = yield* Deferred.make<void>()
                  }),
                ),
              ),
              options.scope,
            )
          })
        const runTool = (part: ToolCallPart) => {
          const request = toolRequest(part)
          return request === undefined
            ? Effect.succeed({ text: "", truncated: false })
            : options.toolRuntime
                .run(request)
                .pipe(
                  Effect.catch((failure) => Effect.succeed({ ...failure, text: failure.message, truncated: false })),
                )
        }
        const heldDeliveries: Array<Effect.Effect<void>> = []

        const runLane = (
          executionId: string,
          prompt: string,
          child: boolean,
        ): Effect.Effect<
          {
            readonly status: "completed" | "failed"
          },
          never
        > =>
          Effect.gen(function* () {
            const selected = selectLane(prompt)
            const childEvents: Array<Event> = []
            const publish = (emitted: Event) =>
              child && options.holdChildEvents !== undefined
                ? Effect.sync(() => childEvents.push(emitted))
                : emit(emitted)
            yield* publish(yield* event(executionId, "execution.accepted", {}, child))
            yield* publish(yield* event(executionId, "execution.started", {}, child))
            const childFibers: Array<Fiber.RuntimeFiber<void, never>> = []
            let terminalText = ""
            let failed: string | undefined
            for (;;) {
              const offset = laneOffsets[selected.index] ?? 0
              const step = selected.lane.script[offset]
              laneOffsets[selected.index] = offset + 1
              if (step === undefined) break
              yield* publish(yield* event(executionId, "model.input.prepared", { data: { turn: offset + 1 } }, child))
              options.modelRequested()
              const turn: TurnStep | undefined = step._tag === "Turn" ? step : undefined
              yield* delay(turn?.delay)
              let parts: ReadonlyArray<Part>
              if (turn !== undefined) parts = turn.parts
              else if (step._tag === "Failure") parts = []
              else parts = [step]
              const hasTools = parts.some((part) => part._tag === "ToolCall")
              for (const part of parts) {
                if (part._tag === "Text") {
                  terminalText += part.text
                  yield* publish(
                    yield* event(
                      executionId,
                      hasTools ? "model.output.delta" : "model.output.completed",
                      { text: part.text, content: [{ type: "text", text: part.text }] },
                      child,
                    ),
                  )
                  continue
                }
                if (part._tag === "Reasoning") {
                  yield* publish(yield* event(executionId, "model.reasoning.delta", { text: part.text }, child))
                  yield* publish(yield* event(executionId, "model.reasoning.completed", {}, child))
                  continue
                }
                const toolId = part.id ?? `${executionId}:tool:${sequenceByExecution.get(executionId) ?? 0}`
                yield* publish(
                  yield* event(
                    executionId,
                    "tool.call.requested",
                    { data: { tool_call_id: toolId, tool_name: part.name, input: part.params } },
                    child,
                  ),
                )
                if (part.name === "task" || part.name === "oracle") {
                  const childId = `${execution.runId}-child-${nextChild++}`
                  yield* publish(
                    yield* event(
                      executionId,
                      "child_run.spawned",
                      { data: { child_execution_id: childId, invocation_id: toolId } },
                      child,
                    ),
                  )
                  yield* publish(
                    yield* event(
                      executionId,
                      "tool.result.received",
                      {
                        data: {
                          tool_call_id: toolId,
                          tool_name: part.name,
                          output: { _tag: "Spawned", status: "running", childRunId: childId },
                          is_failure: false,
                        },
                      },
                      child,
                    ),
                  )
                  const childPrompt = string(record(part.params).prompt)
                  childFibers.push(
                    yield* Effect.forkIn(runLane(childId, childPrompt, true).pipe(Effect.asVoid), options.scope),
                  )
                  continue
                }
                if (part.name === "await_subagents") {
                  yield* Effect.forEach(childFibers, Fiber.await, { discard: true })
                  yield* publish(
                    yield* event(
                      executionId,
                      "tool.result.received",
                      { data: { tool_call_id: toolId, tool_name: part.name, output: "", is_failure: false } },
                      child,
                    ),
                  )
                  continue
                }
                const result = yield* runTool(part)
                yield* publish(
                  yield* event(
                    executionId,
                    "tool.result.received",
                    {
                      data: {
                        tool_call_id: toolId,
                        tool_name: part.name,
                        output: result,
                        is_failure: "_tag" in result && result._tag === "ToolError",
                      },
                    },
                    child,
                  ),
                )
              }
              const attemptIdentity = {
                model_call_id: `${executionId}-call-${offset}`,
                model_attempt_id: `${executionId}-attempt-${offset}`,
                attempt: 1,
              }
              if (step._tag === "Failure") {
                yield* publish(
                  yield* event(
                    executionId,
                    "model.attempt.failed",
                    { data: { ...attemptIdentity, category: "fixture", classification: "fixture" } },
                    child,
                  ),
                )
                failed = step.error.message
                break
              }
              yield* publish(
                yield* event(
                  executionId,
                  "model.attempt.completed",
                  {
                    data: {
                      ...attemptIdentity,
                      input_tokens: 0,
                      output_tokens: 0,
                      finish_reason: hasTools ? "tool-calls" : "stop",
                      model: "scripted",
                    },
                  },
                  child,
                ),
              )
              if (!hasTools) break
            }
            yield* Effect.forEach(childFibers, Fiber.await, { discard: true })
            if (!child && heldDeliveries.length > 0) {
              yield* Effect.forEach(heldDeliveries, (delivery) => delivery, { discard: true })
              heldDeliveries.length = 0
            }
            if (failed === undefined) yield* publish(yield* event(executionId, "execution.completed", {}, child))
            else
              yield* publish(
                yield* event(executionId, "execution.failed", { text: failed, data: { message: failed } }, child),
              )

            if (child && options.holdChildEvents !== undefined)
              heldDeliveries.push(
                Deferred.await(options.holdChildEvents).pipe(
                  Effect.andThen(Effect.forEach(childEvents, emit, { discard: true })),
                ),
              )
            return { status: failed === undefined ? "completed" : "failed" }
          })

        const program = Deferred.await(execution.watching).pipe(
          Effect.andThen(runLane(runId, input.prompt, false)),
          Effect.flatMap((result) => {
            const delivered = Effect.forEach(heldDeliveries, (delivery) => delivery, { discard: true })
            return delivered.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  execution.status = result.status
                }),
              ),
            )
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (execution.status === "cancelled") yield* emit(yield* event(runId, "execution.cancelled"))
            }),
          ),
          Effect.ensuring(Queue.offer(execution.messages, { _tag: "Done" }).pipe(Effect.asVoid)),
          Effect.asVoid,
        )
        execution.fiber = yield* Effect.forkIn(program, options.scope)
        return { runId, turnId: input.turnId, threadId: input.threadId }
      }),
    cancelTurn: (link) =>
      Effect.gen(function* () {
        const execution = executions.get(link.runId)
        if (execution === undefined)
          return yield* ExecutionGateway.CancelTurnFailure.make({ message: `Run ${link.runId} has not started` })
        execution.status = "cancelled"
        if (execution.fiber !== undefined) yield* Fiber.interrupt(execution.fiber)
      }),
    steerTurn: (link, steering) =>
      Effect.gen(function* () {
        const execution = executions.get(link.runId)
        if (execution === undefined)
          return yield* ExecutionGateway.SteeringFailure.make({ message: `Run ${link.runId} has not started` })
        if (execution.scheduleSteering === undefined)
          return yield* ExecutionGateway.SteeringFailure.make({ message: `Run ${link.runId} cannot accept steering` })
        yield* execution.scheduleSteering(steering.text)
      }),
    watchTurn: (link, cursor) => {
      const execution = executions.get(link.runId)
      if (execution === undefined)
        return Stream.fail(ExecutionGateway.WatchTurnFailure.make({ message: `Run ${link.runId} has not started` }))
      const cursorIndex = cursor === undefined ? -1 : execution.history.findIndex((event) => event.cursor === cursor)
      if (execution.status !== "running") return Stream.fromIterable(execution.history.slice(cursorIndex + 1))
      const live = Stream.fromQueue(execution.messages).pipe(
        Stream.takeUntil((message) => message._tag === "Done"),
        Stream.filterMap((message) =>
          message._tag === "Event" ? { _tag: "Some" as const, value: message.event } : { _tag: "None" as const },
        ),
      )
      return Stream.concat(Stream.fromEffect(Deferred.succeed(execution.watching, undefined)).pipe(Stream.drain), live)
    },
    inspectTurn: (link) =>
      Effect.sync(() => {
        const execution = executions.get(link.runId)
        return execution === undefined ? { status: "unavailable" as const } : { status: execution.status }
      }),
  })
}
