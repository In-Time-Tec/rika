import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Provider, Router, Tokens } from "@rika/llm"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Exit, Fiber, Layer, Queue, Schema, Scope, Stream } from "effect"
import { AiError, Prompt, Tool } from "effect/unstable/ai"
import {
  AgentLoop,
  ContextResolver,
  PermissionPolicy,
  SkillRegistry,
  SkillToolProvider,
  ThreadMemoryIndexer,
  ThreadService,
  ToolExecutor,
  ToolRegistry,
} from "../src/index"

const threadId = Ids.ThreadId.make("thread_agent_loop")
const workspaceId = Ids.WorkspaceId.make("workspace_agent_loop")
const userId = Ids.UserId.make("user_agent_loop")

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-test",
  data_dir: "/workspace/rika-test/.rika",
  default_mode: "rush",
})

const defaultToolLayer = ToolExecutor.fakeLayer({
  fake_echo: (call) => Effect.succeed({ echoed: call.input }),
})

const mixedToolLayer = ToolExecutor.fakeLayer({
  read: (call) => Effect.succeed({ path: call.input, content: "read output" }),
  shell_command: (call) => Effect.succeed({ ran: call.input }),
})

const registryFromProviderLayer = (providerLayer: Layer.Layer<Provider.Service>) =>
  Provider.registryLayerFromService.pipe(Layer.provide(providerLayer))

const providerServiceOf = (
  implementation: Omit<Provider.Interface, "completeStructured"> &
    Partial<Pick<Provider.Interface, "completeStructured">>,
) =>
  Provider.Service.of({
    ...implementation,
    completeStructured:
      implementation.completeStructured ?? (() => Effect.die(new Error("structured completion not configured"))),
  })

const toolkitToolNames = async (request: Provider.GenerateRequest | undefined): Promise<ReadonlyArray<string>> => {
  const toolkit = request?.toolkit
  if (toolkit === undefined) return []
  const prepared = Effect.isEffect(toolkit) ? await Effect.runPromise(toolkit) : toolkit
  return Object.keys(prepared.tools).toSorted()
}

const makeLayer = (
  responses: ReadonlyArray<Provider.FakeResponse>,
  toolLayer = defaultToolLayer,
  skillLayer = SkillRegistry.emptyLayer,
  providerLayer: Layer.Layer<Provider.Registry> = Provider.fakeRegistryLayer([
    { name: "openai", responses },
    { name: "anthropic", responses },
  ]),
  diagnosticsLayer = Diagnostics.memoryLayer([]),
  activeConfigLayer = configLayer,
  skillToolProviderLayer = SkillToolProvider.emptyLayer,
) => {
  const redactorLayer = SecretRedactor.layer
  const configuredDiagnosticsLayer = diagnosticsLayer.pipe(Layer.provideMerge(redactorLayer))
  const configuredToolLayer = toolLayer.pipe(Layer.provideMerge(configuredDiagnosticsLayer))
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(activeConfigLayer),
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(configuredDiagnosticsLayer),
  )
  const services = Layer.mergeAll(
    activeConfigLayer,
    Database.memoryLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(Common.TimestampMillis.make(1_900_000_000_000)),
    IdGenerator.sequenceLayer(1),
    redactorLayer,
    configuredDiagnosticsLayer,
    ContextResolver.fakeLayer({
      entries: [
        {
          kind: "guidance",
          source: "test",
          reason: "agent loop test",
          trusted: false,
          path: "AGENTS.md",
          content: "Test guidance",
        },
      ],
      rendered: "<rika_context>Test guidance</rika_context>",
      total_chars: 41,
    }),
    skillLayer,
    skillToolProviderLayer,
    configuredToolLayer,
    llmLayer,
  )

  const threadLayer = ThreadService.layer.pipe(
    Layer.provideMerge(services),
    Layer.provideMerge(configuredDiagnosticsLayer),
  )

  return AgentLoop.layer.pipe(Layer.provideMerge(threadLayer), Layer.provideMerge(services))
}

describe("AgentLoop", () => {
  test("runs a fake model requested fake tool in one persisted turn", async () => {
    const layer = makeLayer([
      { type: "tool-call", id: "call_fake_echo_1", name: "fake_echo", input: { text: "hello" } },
      "tool saw hello",
    ])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: threadId,
          workspace_id: workspaceId,
          content: "please echo hello",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: threadId })
        const summary = yield* ThreadProjection.getThread(threadId)
        return { turn, events, summary }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "tool.call.input.started",
      "tool.call.input.delta",
      "tool.call.input.ended",
      "tool.call.requested",
      "tool.call.completed",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(result.events.find((event) => event.type === "context.resolved")).toMatchObject({
      data: { rendered: "<rika_context>Test guidance</rika_context>" },
    })
    expect(result.events.find((event) => event.type === "tool.call.completed")).toMatchObject({
      data: { result: { status: "success", output: { echoed: { text: "hello" } } } },
    })
    const requestedIndex = result.events.findIndex((event) => event.type === "tool.call.requested")
    const completedIndex = result.events.findIndex((event) => event.type === "tool.call.completed")
    const assistantBetween = result.events
      .slice(requestedIndex + 1, completedIndex)
      .some((event) => event.type === "message.added" && event.data.message.role === "assistant")
    expect(requestedIndex).toBeGreaterThan(-1)
    expect(completedIndex).toBeGreaterThan(requestedIndex)
    expect(assistantBetween).toBe(false)
    expect(result.summary).toMatchObject({
      thread_id: threadId,
      latest_message_text: "tool saw hello",
      active_turn_status: "completed",
    })
  })

  test("stamps user attribution on turn and user message events", async () => {
    const layer = makeLayer(["attributed response"])
    const attributedThreadId = Ids.ThreadId.make("thread_agent_user_attribution")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* AgentLoop.runTurn({
          thread_id: attributedThreadId,
          workspace_id: workspaceId,
          user_id: userId,
          content: "attribute me",
        })
        return yield* ThreadEventLog.readThread({ thread_id: attributedThreadId })
      }).pipe(Effect.provide(layer)),
    )

    const started = result.find((event): event is Event.TurnStarted => event.type === "turn.started")
    const message = result.find(
      (event): event is Event.MessageAdded => event.type === "message.added" && event.data.message.role === "user",
    )

    expect(started).toMatchObject({ data: { user_id: userId } })
    expect(message?.data.message.metadata).toEqual({ user_id: userId })
  })

  test("indexes completed turns through the detached memory hook", async () => {
    const indexedTurns = Effect.runSync(Queue.unbounded<ThreadMemoryIndexer.IndexTurnInput>())
    const memoryThread = Ids.ThreadId.make("thread_agent_memory_hook")
    const layer = makeLayer(["remembered"]).pipe(
      Layer.provideMerge(
        ThreadMemoryIndexer.fakeLayer({
          indexTurn: (input) =>
            Queue.offer(indexedTurns, input).pipe(
              Effect.as({
                status: "skipped" as const,
                reason: "already_indexed" as const,
                thread_id: input.thread_id,
                turn_id: input.turn_id,
              }),
            ),
        }),
      ),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: memoryThread,
          workspace_id: workspaceId,
          content: "remember this turn",
        })
        const indexed = yield* Queue.take(indexedTurns).pipe(Effect.timeoutOption("1 second"))
        return { turn, indexed }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.indexed._tag).toBe("Some")
    if (result.indexed._tag === "Some") {
      expect(result.indexed.value).toMatchObject({ thread_id: memoryThread, turn_id: result.turn.turn_id })
    }
  })

  test("default turns expose the full tool descriptor list", async () => {
    const captured: Array<Provider.GenerateRequest> = []
    const providerLayer = Provider.registryLayerFromProviders([
      providerServiceOf({
        name: "openai",
        complete: (request) =>
          Effect.sync(() => {
            captured.push(request)
            return { provider: "openai", model: request.model, content: "done" }
          }),
        stream: (request) =>
          Stream.sync(() => {
            captured.push(request)
            return Provider.streamEventsFromResponse(fakeResponse(request, "done"))
          }).pipe(Stream.flatMap(Stream.fromIterable)),
      }),
    ])
    const layer = makeLayer([], mixedToolLayer, SkillRegistry.emptyLayer, providerLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_full_tools"),
          workspace_id: workspaceId,
          content: "list full tools",
        })
      }).pipe(Effect.provide(layer)),
    )

    const promptText = JSON.stringify(captured[0]?.messages)
    const toolNames = await toolkitToolNames(captured[0])
    expect(promptText).toContain("read")
    expect(promptText).toContain("shell_command")
    expect(toolNames).toContain("read")
    expect(toolNames).toContain("shell_command")
  })

  test("read-only turns hide write tools from the model and record tool access on turn.started", async () => {
    const captured: Array<Provider.GenerateRequest> = []
    const providerLayer = Provider.registryLayerFromProviders([
      providerServiceOf({
        name: "openai",
        complete: (request) =>
          Effect.sync(() => {
            captured.push(request)
            return { provider: "openai", model: request.model, content: "done" }
          }),
        stream: (request) =>
          Stream.sync(() => {
            captured.push(request)
            return Provider.streamEventsFromResponse(fakeResponse(request, "done"))
          }).pipe(Stream.flatMap(Stream.fromIterable)),
      }),
    ])
    const layer = makeLayer([], mixedToolLayer, SkillRegistry.emptyLayer, providerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_read_only_tools"),
          workspace_id: workspaceId,
          content: "list read-only tools",
          tool_access: "read-only",
        })
        return yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_read_only_tools") })
      }).pipe(Effect.provide(layer)),
    )

    const promptText = JSON.stringify(captured[0]?.messages)
    const toolNames = await toolkitToolNames(captured[0])
    expect(promptText).toContain("read")
    expect(promptText).not.toContain("shell_command")
    expect(toolNames).toContain("read")
    expect(toolNames).not.toContain("shell_command")
    expect(result.find((event) => event.type === "turn.started")).toMatchObject({
      data: { tool_access: "read-only" },
    })
  })

  test("read-only turns reject forced write tool calls from the model stream", async () => {
    let shellExecuted = false
    const toolLayer = ToolExecutor.fakeLayer({
      read: (call) => Effect.succeed({ path: call.input, content: "read output" }),
      shell_command: (call) =>
        Effect.sync(() => {
          shellExecuted = true
          return { ran: call.input }
        }),
    })
    let streamCount = 0
    const providerLayer = Provider.registryLayerFromProviders([
      providerServiceOf({
        name: "openai",
        complete: (request) => Effect.succeed(fakeResponse(request, "unexpected complete")),
        stream: (request) =>
          Stream.sync(() => {
            streamCount += 1
            return streamCount === 1
              ? [
                  { type: "response.started" as const, provider: "openai", model: request.model },
                  {
                    type: "tool.call" as const,
                    id: "call_shell_read_only",
                    name: "shell_command",
                    input: { command: "printf nope" },
                  },
                  {
                    type: "response.completed" as const,
                    response: {
                      provider: "openai",
                      model: request.model,
                      content: "",
                      finish_reason: "tool-call" as const,
                    },
                  },
                ]
              : Provider.streamEventsFromResponse(fakeResponse(request, "done after blocked shell"))
          }).pipe(Stream.flatMap(Stream.fromIterable)),
      }),
    ])
    const layer = makeLayer([], toolLayer, SkillRegistry.emptyLayer, providerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_read_only_forced_shell"),
          workspace_id: workspaceId,
          content: "force a write tool",
          tool_access: "read-only",
        })
        const events = yield* ThreadEventLog.readThread({
          thread_id: Ids.ThreadId.make("thread_agent_read_only_forced_shell"),
        })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    const completed = result.events.find((event) => event.type === "tool.call.completed")
    expect(shellExecuted).toBe(false)
    expect(result.turn.status).toBe("completed")
    expect(completed).toMatchObject({
      data: {
        result: {
          name: "shell_command",
          status: "error",
          error: {
            kind: "permission",
            code: "shell_command",
            message: "Tool shell_command is not available during read-only turns",
          },
          metadata: { permission_action: "reject-and-continue", tool_access: "read-only" },
        },
      },
    })
  })

  test("loops through multiple tool calls before emitting the final answer", async () => {
    const multiToolThread = Ids.ThreadId.make("thread_agent_multi_tool")
    const layer = makeLayer([
      { type: "tool-call", id: "call_fake_echo_1", name: "fake_echo", input: { text: "first" } },
      { type: "tool-call", id: "call_fake_echo_2", name: "fake_echo", input: { text: "second" } },
      {
        provider: "openai",
        model: "gpt-5.5",
        content: "done after two tools",
        finish_reason: "stop",
        usage: { input_tokens: 777, output_tokens: 12, total_tokens: 789 },
      },
    ])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: multiToolThread,
          workspace_id: workspaceId,
          content: "use two tools then answer",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: multiToolThread })
        const summary = yield* ThreadProjection.getThread(multiToolThread)
        return { turn, events, summary }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "tool.call.input.started",
      "tool.call.input.delta",
      "tool.call.input.ended",
      "tool.call.requested",
      "tool.call.completed",
      "tool.call.input.started",
      "tool.call.input.delta",
      "tool.call.input.ended",
      "tool.call.requested",
      "tool.call.completed",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(result.events.filter((event) => event.type === "tool.call.requested")).toHaveLength(2)
    expect(result.events.filter((event) => event.type === "tool.call.completed")).toHaveLength(2)
    expect(result.events.filter((event) => event.type === "message.added")).toHaveLength(2)
    expect(result.events.at(-1)).toMatchObject({
      type: "turn.completed",
      data: { usage: { input_tokens: 777, output_tokens: 12, total_tokens: 789 } },
    })
    expect(result.events.findLast((event) => event.type === "message.added")).toMatchObject({
      data: { message: { role: "assistant" } },
    })
    expect(result.summary).toMatchObject({
      latest_message_text: "done after two tools",
      active_turn_status: "completed",
    })
  })

  test("emits the same persisted events as a stream for UI consumers", async () => {
    const layer = makeLayer(["streamed response"])

    const eventTypes = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const events = yield* AgentLoop.streamTurn({
          thread_id: Ids.ThreadId.make("thread_agent_stream"),
          workspace_id: workspaceId,
          content: "stream it",
        }).pipe(Stream.runCollect)
        return Array.from(events).map((event) => event.type)
      }).pipe(Effect.provide(layer)),
    )

    expect(eventTypes).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
  })

  test("projects context window for usage-only final responses", async () => {
    const usageOnlyThread = Ids.ThreadId.make("thread_agent_usage_only")
    const layer = makeLayer([
      { provider: "openai", model: "gpt-5.5", content: "", finish_reason: "stop" },
      { provider: "openai", model: "gpt-5.5", content: "", finish_reason: "stop" },
      {
        provider: "openai",
        model: "gpt-5.5",
        content: "",
        finish_reason: "stop",
        usage: { input_tokens: 9_000, output_tokens: 0, total_tokens: 9_000 },
      },
    ])

    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* AgentLoop.runTurn({
          thread_id: usageOnlyThread,
          workspace_id: workspaceId,
          content: "answer tersely",
        })
        return yield* ThreadService.list({})
      }).pipe(Effect.provide(layer)),
    )

    expect(summary[0]).toMatchObject({
      thread_id: usageOnlyThread,
      context_tokens: 9_000,
      context_window: 400_000,
    })
  })

  test("coalesces bursty model deltas before persistence and replay", async () => {
    const burstThread = Ids.ThreadId.make("thread_agent_bursty_model")
    const chunkCount = 512
    const chunkText = "x"
    const content = chunkText.repeat(chunkCount)
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: Effect.fn("AgentLoop.test.bursty.complete")(function* (request: Provider.GenerateRequest) {
          return fakeResponse(request, content)
        }),
        stream: (request: Provider.GenerateRequest) =>
          Stream.fromIterable<Provider.StreamEvent>([
            {
              type: "response.started",
              provider: request.provider,
              model: request.model,
            },
          ]).pipe(
            Stream.concat(
              Stream.range(1, chunkCount).pipe(
                Stream.map((): Provider.StreamEvent => ({ type: "content.delta", text: chunkText })),
              ),
            ),
            Stream.concat(
              Stream.fromIterable<Provider.StreamEvent>([
                {
                  type: "response.completed",
                  response: fakeResponse(request, content),
                },
              ]),
            ),
          ),
      }),
    )
    const layer = makeLayer([], defaultToolLayer, SkillRegistry.emptyLayer, registryFromProviderLayer(providerLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: burstThread,
          workspace_id: workspaceId,
          content: "stream many chunks",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: burstThread })
        const summary = yield* ThreadProjection.getThread(burstThread)
        return { turn, events, summary }
      }).pipe(Effect.provide(layer)),
    )

    const modelChunks = result.events.filter((event) => event.type === "model.stream.chunk")
    expect(result.turn.status).toBe("completed")
    expect(modelChunks.length).toBeLessThan(20)
    expect(modelChunks.map((event) => (event.type === "model.stream.chunk" ? event.data.text : "")).join("")).toBe(
      content,
    )
    expect(result.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: result.events.length }, (_, index) => index + 1),
    )
    expect(result.summary).toMatchObject({ latest_message_text: content })
  })

  test("coalesces bursty tool input deltas before persistence and replay", async () => {
    const burstThread = Ids.ThreadId.make("thread_agent_bursty_tool_input")
    const chunkCount = 512
    const chunkText = "x"
    const inputText = chunkText.repeat(chunkCount)
    const toolCallId = "call_bursty_tool_input"
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: Effect.fn("AgentLoop.test.burstyToolInput.complete")(function* (request: Provider.GenerateRequest) {
          return fakeResponse(request, "done")
        }),
        stream: (request: Provider.GenerateRequest) =>
          Stream.fromIterable<Provider.StreamEvent>([
            {
              type: "response.started",
              provider: request.provider,
              model: request.model,
            },
            {
              type: "tool.input.started",
              id: toolCallId,
              name: "write",
            },
          ]).pipe(
            Stream.concat(
              Stream.range(1, chunkCount).pipe(
                Stream.map((): Provider.StreamEvent => ({ type: "tool.input.delta", id: toolCallId, text: chunkText })),
              ),
            ),
            Stream.concat(
              Stream.fromIterable<Provider.StreamEvent>([
                {
                  type: "tool.input.ended",
                  id: toolCallId,
                  name: "write",
                  input_text: inputText,
                },
                {
                  type: "response.completed",
                  response: fakeResponse(request, "done"),
                },
              ]),
            ),
          ),
      }),
    )
    const layer = makeLayer([], defaultToolLayer, SkillRegistry.emptyLayer, registryFromProviderLayer(providerLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* AgentLoop.runTurn({
          thread_id: burstThread,
          workspace_id: workspaceId,
          content: "stream many tool input chunks",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: burstThread })
        return { events }
      }).pipe(Effect.provide(layer)),
    )

    const inputDeltas = result.events.filter((event) => event.type === "tool.call.input.delta")
    expect(inputDeltas.length).toBeLessThan(20)
    expect(inputDeltas.map((event) => (event.type === "tool.call.input.delta" ? event.data.text : "")).join("")).toBe(
      inputText,
    )
    expect(result.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: result.events.length }, (_, index) => index + 1),
    )
  })

  test("emits redacted session diagnostics for appended turn events", async () => {
    const diagnostics: Array<Diagnostics.Entry> = []
    const diagnosticsThread = Ids.ThreadId.make("thread_agent_diagnostics")
    const layer = makeLayer(
      ["diagnostic response"],
      defaultToolLayer,
      SkillRegistry.emptyLayer,
      Provider.fakeRegistryLayer([
        { name: "openai", responses: ["diagnostic response"] },
        { name: "anthropic", responses: ["diagnostic response"] },
      ]),
      Diagnostics.memoryLayer(diagnostics),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* AgentLoop.runTurn({
          thread_id: diagnosticsThread,
          workspace_id: workspaceId,
          content: "record diagnostics",
        })
      }).pipe(Effect.provide(layer)),
    )

    const appended = diagnostics.filter((entry) => entry.message === "thread.event.appended")
    expect(appended.map((entry) => dataField(entry, "event_type"))).toContain("turn.started")
    expect(appended.map((entry) => dataField(entry, "thread_id"))).toEqual(appended.map(() => diagnosticsThread))
    expect(JSON.stringify(appended)).not.toContain("diagnostic response")
    expect(JSON.stringify(appended)).not.toContain("record diagnostics")
  })

  test("preserves image turn parts in the user message and model prompt", async () => {
    const captured: Array<Provider.GenerateRequest> = []
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: Effect.fn("AgentLoop.test.image.complete")(function* (request: Provider.GenerateRequest) {
          captured.push(request)
          return fakeResponse(request, "saw image")
        }),
        stream: (request: Provider.GenerateRequest) => {
          captured.push(request)
          return Stream.fromIterable(Provider.streamEventsFromResponse(fakeResponse(request, "saw image")))
        },
      }),
    )
    const layer = makeLayer([], defaultToolLayer, SkillRegistry.emptyLayer, registryFromProviderLayer(providerLayer))
    const imagePart = Message.image({
      media_type: "image/png",
      data: "cG5nLWJ5dGVz",
      filename: ".rika/pasted/test.png",
      metadata: { label: "[Image 1]" },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_image"),
          workspace_id: workspaceId,
          content: "In this image [Image 1] you can see it",
          content_parts: [Message.text("In this image "), imagePart, Message.text(" you can see it")],
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_image") })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    const userMessage = result.events.find((event) => event.type === "message.added")
    expect(userMessage).toMatchObject({
      data: { message: { content: [Message.text("In this image "), imagePart, Message.text(" you can see it")] } },
    })
    expect(
      Message.displayText(userMessage?.type === "message.added" ? userMessage.data.message : { content: [] }),
    ).toBe("In this image [Image 1] you can see it")
    const prompt = captured[0]?.prompt
    const promptMessages: ReadonlyArray<Prompt.MessageEncoded> = Array.isArray(prompt) ? prompt : []
    const promptMessage = promptMessages.findLast((message) => message.role === "user")
    expect(promptMessage).toEqual({
      role: "user",
      content: [
        { type: "text", text: "In this image " },
        {
          type: "file",
          mediaType: "image/png",
          fileName: ".rika/pasted/test.png",
          data: Buffer.from("png-bytes"),
        },
        { type: "text", text: " you can see it" },
      ],
    })
  })

  test("builds the next model request from a compacted summary plus tail", async () => {
    const compactedThreadId = Ids.ThreadId.make("thread_agent_compacted_next_turn")
    const compactedWorkspaceId = Ids.WorkspaceId.make("workspace_agent_compacted_next_turn")
    const priorTurnId = Ids.TurnId.make("turn_agent_compacted_prior")
    const tailTurnId = Ids.TurnId.make("turn_agent_compacted_tail")
    const captured: Array<Provider.GenerateRequest> = []
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: Effect.fn("AgentLoop.test.compacted.complete")(function* (request: Provider.GenerateRequest) {
          captured.push(request)
          return fakeResponse(request, "after compact")
        }),
        stream: (request: Provider.GenerateRequest) => {
          captured.push(request)
          return Stream.fromIterable(Provider.streamEventsFromResponse(fakeResponse(request, "after compact")))
        },
      }),
    )
    const layer = makeLayer([], defaultToolLayer, SkillRegistry.emptyLayer, registryFromProviderLayer(providerLayer))
    const seed: ReadonlyArray<Event.Event> = [
      {
        id: Ids.EventId.make("event_agent_compacted_thread_created"),
        thread_id: compactedThreadId,
        sequence: 1,
        version: 1,
        created_at: Common.TimestampMillis.make(1_900_000_000_000),
        type: "thread.created",
        data: {
          workspace_id: compactedWorkspaceId,
        },
      },
      {
        id: Ids.EventId.make("event_agent_compacted_prior_started"),
        thread_id: compactedThreadId,
        turn_id: priorTurnId,
        sequence: 2,
        version: 1,
        created_at: Common.TimestampMillis.make(1_900_000_000_000),
        type: "turn.started",
        data: {},
      },
      {
        id: Ids.EventId.make("event_agent_compacted_old_message"),
        thread_id: compactedThreadId,
        turn_id: priorTurnId,
        sequence: 3,
        version: 1,
        created_at: Common.TimestampMillis.make(1_900_000_000_000),
        type: "message.added",
        data: {
          message: Message.user({
            id: Ids.MessageId.make("message_agent_compacted_old"),
            thread_id: compactedThreadId,
            turn_id: priorTurnId,
            content: "old message must be folded",
            created_at: Common.TimestampMillis.make(1_900_000_000_000),
          }),
        },
      },
      {
        id: Ids.EventId.make("event_agent_compacted_prior_completed"),
        thread_id: compactedThreadId,
        turn_id: priorTurnId,
        sequence: 4,
        version: 1,
        created_at: Common.TimestampMillis.make(1_900_000_000_000),
        type: "turn.completed",
        data: {
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
      {
        id: Ids.EventId.make("event_agent_compacted_context"),
        thread_id: compactedThreadId,
        sequence: 5,
        version: 1,
        created_at: Common.TimestampMillis.make(1_900_000_000_000),
        type: "context.compacted",
        data: {
          summary: "keep the anchored summary",
          tail_start_sequence: 6,
          trigger: "manual",
          tokens_before: 10,
          model: "gpt-5.5",
        },
      },
      {
        id: Ids.EventId.make("event_agent_compacted_tail_started"),
        thread_id: compactedThreadId,
        turn_id: tailTurnId,
        sequence: 6,
        version: 1,
        created_at: Common.TimestampMillis.make(1_900_000_000_000),
        type: "turn.started",
        data: {},
      },
      {
        id: Ids.EventId.make("event_agent_compacted_tail_message"),
        thread_id: compactedThreadId,
        turn_id: tailTurnId,
        sequence: 7,
        version: 1,
        created_at: Common.TimestampMillis.make(1_900_000_000_000),
        type: "message.added",
        data: {
          message: Message.user({
            id: Ids.MessageId.make("message_agent_compacted_tail"),
            thread_id: compactedThreadId,
            turn_id: tailTurnId,
            content: "tail message must remain",
            created_at: Common.TimestampMillis.make(1_900_000_000_000),
          }),
        },
      },
      {
        id: Ids.EventId.make("event_agent_compacted_tail_completed"),
        thread_id: compactedThreadId,
        turn_id: tailTurnId,
        sequence: 8,
        version: 1,
        created_at: Common.TimestampMillis.make(1_900_000_000_000),
        type: "turn.completed",
        data: {
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of seed) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* AgentLoop.runTurn({
          thread_id: compactedThreadId,
          workspace_id: compactedWorkspaceId,
          content: "new request after compaction",
          mode: "rush",
        })
      }).pipe(Effect.provide(layer)),
    )

    const requestText = JSON.stringify(captured[0]?.messages)
    const promptText = JSON.stringify(captured[0]?.prompt)
    expect(result.status).toBe("completed")
    expect(requestText).toContain("[Conversation summary")
    expect(requestText).toContain("keep the anchored summary")
    expect(requestText).toContain("tail message must remain")
    expect(requestText).toContain("new request after compaction")
    expect(requestText).not.toContain("old message must be folded")
    expect(promptText).toContain("[Conversation summary")
    expect(promptText).toContain("keep the anchored summary")
    expect(promptText).toContain("tail message must remain")
    expect(promptText).toContain("new request after compaction")
    expect(promptText).not.toContain("old message must be folded")
  })

  test("auto-compacts before the model call when prior usage reaches the usable budget", async () => {
    const diagnostics: Array<Diagnostics.Entry> = []
    const compactingThread = Ids.ThreadId.make("thread_agent_pre_turn_auto_compact")
    const compactingWorkspace = Ids.WorkspaceId.make("workspace_agent_pre_turn_auto_compact")
    const captured: Array<Provider.GenerateRequest> = []
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: Effect.fn("AgentLoop.test.preTurnAuto.complete")(function* (request: Provider.GenerateRequest) {
          return fakeResponse(request, "pre-turn summary")
        }),
        stream: (request: Provider.GenerateRequest) => {
          captured.push(request)
          return Stream.fromIterable(Provider.streamEventsFromResponse(fakeResponse(request, "after auto compaction")))
        },
      }),
    )
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.emptyLayer,
      registryFromProviderLayer(providerLayer),
      Diagnostics.memoryLayer(diagnostics),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* appendSeed(
          usageSeed({
            prefix: "pre_turn_auto",
            threadId: compactingThread,
            workspaceId: compactingWorkspace,
            inputTokens: 380_000,
          }),
        )
        const turn = yield* AgentLoop.runTurn({
          thread_id: compactingThread,
          workspace_id: compactingWorkspace,
          content: "continue after automatic compaction",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: compactingThread })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    const currentRunTypes = result.turn.events.map((event) => event.type)
    const requestText = JSON.stringify(captured[0]?.messages)
    expect(result.turn.status).toBe("completed")
    expect(currentRunTypes).toEqual([
      "turn.started",
      "message.added",
      "context.resolved",
      "context.compacted",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(result.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: result.events.length }, (_, index) => index + 1),
    )
    expect(result.events[7]).toMatchObject({
      type: "context.compacted",
      data: { trigger: "auto", summary: "pre-turn summary" },
    })
    expect(result.events[8]).toMatchObject({ type: "model.stream.chunk" })
    expect(requestText).toContain("[Conversation summary")
    expect(requestText).toContain("pre-turn summary")
    expect(requestText).toContain("continue after automatic compaction")
    const compactionDiagnostic = diagnostics.find((entry) => entry.message === "context.compacted")
    if (compactionDiagnostic === undefined) throw new Error("missing compaction diagnostic")
    expect(typeof dataField(compactionDiagnostic, "tokens_before")).toBe("number")
    expect(typeof dataField(compactionDiagnostic, "tokens_after")).toBe("number")
  })

  test("prunes old tool output before current turn assembly and before pre-turn compaction", async () => {
    const pruneThread = Ids.ThreadId.make("thread_agent_pre_turn_prune")
    const pruneWorkspace = Ids.WorkspaceId.make("workspace_agent_pre_turn_prune")
    const captured: Array<Provider.GenerateRequest> = []
    const oldOutput = { content: "OLD_TOOL_OUTPUT ".repeat(16) }
    const protectedOutput = { content: "PROTECTED_TOOL_OUTPUT ".repeat(16) }
    const oldTokens = outputTokens(oldOutput)
    let completeCalls = 0
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: Effect.fn("AgentLoop.test.preTurnPrune.complete")(function* (request: Provider.GenerateRequest) {
          completeCalls += 1
          return fakeResponse(request, "unexpected compaction")
        }),
        stream: (request: Provider.GenerateRequest) => {
          captured.push(request)
          return Stream.fromIterable(Provider.streamEventsFromResponse(fakeResponse(request, "after prune")))
        },
      }),
    )
    const pruningConfigLayer = Config.layerFromValues({
      workspace_root: "/workspace/rika-test",
      data_dir: "/workspace/rika-test/.rika",
      default_mode: "rush",
      compaction_prune_protect: outputTokens(protectedOutput),
      compaction_prune_minimum: oldTokens,
    })
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.emptyLayer,
      registryFromProviderLayer(providerLayer),
      Diagnostics.memoryLayer([]),
      pruningConfigLayer,
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* appendSeed(
          pruneSeed({
            threadId: pruneThread,
            workspaceId: pruneWorkspace,
            oldOutput,
            protectedOutput,
          }),
        )
        const turn = yield* AgentLoop.runTurn({
          thread_id: pruneThread,
          workspace_id: pruneWorkspace,
          content: "continue after pruning",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: pruneThread })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    const requestText = JSON.stringify(captured[0]?.messages)
    const promptText = JSON.stringify(captured[0]?.prompt)
    expect(result.turn.status).toBe("completed")
    expect(completeCalls).toBe(0)
    expect(result.turn.events.map((event) => event.type)).toEqual([
      "context.pruned",
      "turn.started",
      "message.added",
      "context.resolved",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(result.turn.events[0]).toMatchObject({
      type: "context.pruned",
      data: {
        tool_call_ids: [Ids.ToolCallId.make("tool_pre_turn_prune_old")],
        estimated_tokens_freed: oldTokens,
      },
    })
    expect(requestText).toContain("output elided to save context")
    expect(requestText).toContain("PROTECTED_TOOL_OUTPUT")
    expect(requestText).toContain("RECENT_TOOL_OUTPUT")
    expect(requestText).not.toContain("OLD_TOOL_OUTPUT")
    expect(promptText).toContain("output elided to save context")
    expect(promptText).not.toContain("OLD_TOOL_OUTPUT")
  })

  test("does not auto-compact when compaction auto is disabled", async () => {
    const disabledThread = Ids.ThreadId.make("thread_agent_pre_turn_auto_disabled")
    const disabledWorkspace = Ids.WorkspaceId.make("workspace_agent_pre_turn_auto_disabled")
    const captured: Array<Provider.GenerateRequest> = []
    let completeCalls = 0
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: Effect.fn("AgentLoop.test.preTurnDisabled.complete")(function* (request: Provider.GenerateRequest) {
          completeCalls += 1
          return fakeResponse(request, "unexpected summary")
        }),
        stream: (request: Provider.GenerateRequest) => {
          captured.push(request)
          return Stream.fromIterable(Provider.streamEventsFromResponse(fakeResponse(request, "without compaction")))
        },
      }),
    )
    const disabledConfigLayer = Config.layerFromValues({
      workspace_root: "/workspace/rika-test",
      data_dir: "/workspace/rika-test/.rika",
      default_mode: "rush",
      compaction_auto: false,
    })
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.emptyLayer,
      registryFromProviderLayer(providerLayer),
      Diagnostics.memoryLayer([]),
      disabledConfigLayer,
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* appendSeed(
          usageSeed({
            prefix: "pre_turn_disabled",
            threadId: disabledThread,
            workspaceId: disabledWorkspace,
            inputTokens: 380_000,
          }),
        )
        const turn = yield* AgentLoop.runTurn({
          thread_id: disabledThread,
          workspace_id: disabledWorkspace,
          content: "continue without automatic compaction",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: disabledThread })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(completeCalls).toBe(0)
    expect(result.turn.events.map((event) => event.type)).toEqual([
      "turn.started",
      "message.added",
      "context.resolved",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(result.events.map((event) => event.type)).not.toContain("context.compacted")
    expect(JSON.stringify(captured[0]?.messages)).toContain("old pre_turn_disabled context")
  })

  test("uses the reserved compaction buffer when deciding pre-model auto-compaction", async () => {
    const reservedThread = Ids.ThreadId.make("thread_agent_pre_turn_reserved")
    const reservedWorkspace = Ids.WorkspaceId.make("workspace_agent_pre_turn_reserved")
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: Effect.fn("AgentLoop.test.preTurnReserved.complete")(function* (request: Provider.GenerateRequest) {
          return fakeResponse(request, "reserved summary")
        }),
        stream: (request: Provider.GenerateRequest) =>
          Stream.fromIterable(Provider.streamEventsFromResponse(fakeResponse(request, "reserved answer"))),
      }),
    )
    const reservedConfigLayer = Config.layerFromValues({
      workspace_root: "/workspace/rika-test",
      data_dir: "/workspace/rika-test/.rika",
      default_mode: "rush",
      compaction_reserved: 50_000,
    })
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.emptyLayer,
      registryFromProviderLayer(providerLayer),
      Diagnostics.memoryLayer([]),
      reservedConfigLayer,
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* appendSeed(
          usageSeed({
            prefix: "pre_turn_reserved",
            threadId: reservedThread,
            workspaceId: reservedWorkspace,
            inputTokens: 360_000,
          }),
        )
        const turn = yield* AgentLoop.runTurn({
          thread_id: reservedThread,
          workspace_id: reservedWorkspace,
          content: "continue with reserved budget",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: reservedThread })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.find((event) => event.type === "context.compacted")).toMatchObject({
      data: { trigger: "auto", summary: "reserved summary" },
    })
  })

  test("auto-compacts mid-turn and rebuilds the next request with pending tool results", async () => {
    const midThread = Ids.ThreadId.make("thread_agent_mid_turn_auto_compact")
    const captured: Array<Provider.GenerateRequest> = []
    const providerLayer = midTurnCompactingProviderLayer(captured)
    const largeToolLayer = ToolExecutor.fakeLayer({
      fake_echo: () => Effect.succeed({ echoed: `PENDING_TOOL_OUTPUT ${"x".repeat(24_000)}` }),
    })
    const layer = makeLayer([], largeToolLayer, SkillRegistry.emptyLayer, registryFromProviderLayer(providerLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: midThread,
          workspace_id: workspaceId,
          content: "call the tool and continue after compaction",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: midThread })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    const types = result.events.map((event) => event.type)
    const compactedIndex = types.indexOf("context.compacted")
    const toolCompletedIndex = types.indexOf("tool.call.completed")
    const secondPromptText = JSON.stringify(captured[1]?.prompt)
    expect(result.turn.status).toBe("completed")
    expect(compactedIndex).toBeGreaterThan(toolCompletedIndex)
    expect(result.events[compactedIndex]).toMatchObject({
      type: "context.compacted",
      data: { trigger: "auto", summary: "mid-turn summary" },
    })
    expect(secondPromptText).toContain("[Conversation summary")
    expect(secondPromptText).toContain("mid-turn summary")
    expect(secondPromptText).not.toContain("SUMMARY_INCLUDED_PENDING_TOOL_RESULT")
    expect(secondPromptText).toContain("assistant prefix")
    expect(secondPromptText).toContain('"type":"tool-call"')
    expect(secondPromptText).toContain('"type":"tool-result"')
    expect(secondPromptText).toContain("echoed")
    expect(secondPromptText.match(/PENDING_TOOL_OUTPUT/g)).toHaveLength(1)
    expect(secondPromptText.match(/call_mid_turn_compact/g)).toHaveLength(2)
  })

  test("compacts and retries once on context overflow without appending model error", async () => {
    const overflowThread = Ids.ThreadId.make("thread_agent_overflow_retry")
    const captured: Array<Provider.GenerateRequest> = []
    const providerLayer = overflowRecoveringProviderLayer(captured, false)
    const layer = makeLayer([], defaultToolLayer, SkillRegistry.emptyLayer, registryFromProviderLayer(providerLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: overflowThread,
          workspace_id: workspaceId,
          content: "recover from context overflow",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: overflowThread })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    const types = result.events.map((event) => event.type)
    expect(result.turn.status).toBe("completed")
    expect(types).toContain("context.compacted")
    expect(result.events.find((event) => event.type === "context.compacted")).toMatchObject({
      data: { trigger: "overflow", summary: "overflow summary" },
    })
    expect(JSON.stringify(captured[0]?.messages)).toContain("overflow summary")
    expect(JSON.stringify(captured[0]?.messages)).not.toContain("model.error")
    expect(JSON.stringify(captured[0]?.prompt)).not.toContain("model.error")
  })

  test("fails cleanly when context overflow repeats after compaction", async () => {
    const overflowThread = Ids.ThreadId.make("thread_agent_overflow_double")
    const providerLayer = overflowRecoveringProviderLayer([], true)
    const layer = makeLayer([], defaultToolLayer, SkillRegistry.emptyLayer, registryFromProviderLayer(providerLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: overflowThread,
          workspace_id: workspaceId,
          content: "fail after repeated context overflow",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: overflowThread })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("failed")
    expect(result.events.filter((event) => event.type === "context.compacted")).toHaveLength(1)
    expect(result.events.at(-1)).toMatchObject({
      type: "turn.failed",
      data: { error: { message: "context window exceeded; compaction insufficient" } },
    })
  })

  test("records permission-blocked tool calls as structured tool results", async () => {
    const toolLayer = ToolExecutor.layer.pipe(
      Layer.provideMerge(ToolRegistry.fakeLayer({ fake_echo: (call) => Effect.succeed({ echoed: call.input }) })),
      Layer.provideMerge(PermissionPolicy.rejectLayer("policy denied fake_echo")),
    )
    const layer = makeLayer(
      [
        { type: "tool-call", id: "call_fake_echo_blocked", name: "fake_echo", input: { text: "blocked" } },
        "continued after block",
      ],
      toolLayer,
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_blocked_tool"),
          workspace_id: workspaceId,
          content: "please call a blocked tool",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_blocked_tool") })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.find((event) => event.type === "tool.call.completed")).toMatchObject({
      data: { result: { status: "error", error: { kind: "permission", message: "policy denied fake_echo" } } },
    })
    expect(result.events.at(-1)).toMatchObject({ type: "turn.completed" })
  })

  test("persists compact subagent summaries returned by the task tool", async () => {
    const toolLayer = ToolExecutor.fakeLayer({
      task: () =>
        Effect.succeed({
          type: "subagent.batch",
          runs: [
            {
              subagent_id: "subagent_test_1",
              name: "searcher",
              status: "completed",
              summary: "Found the file that owns the behavior.",
              evidence: ["packages/agent/src/agent-loop.ts"],
              tool_access: "read-only",
              tool_names: ["semantic_search"],
              started_at: 1_900_000_000_000,
              completed_at: 1_900_000_000_000,
            },
          ],
        }),
    })
    const layer = makeLayer(
      [
        { type: "tool-call", id: "call_task_1", name: "task", input: { agents: [{ prompt: "find behavior" }] } },
        "merged",
      ],
      toolLayer,
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_subagents"),
          workspace_id: workspaceId,
          content: "launch two subagents",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_subagents") })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "tool.call.input.started",
      "tool.call.input.delta",
      "tool.call.input.ended",
      "tool.call.requested",
      "tool.call.completed",
      "subagent.completed",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(result.events.find((event) => event.type === "subagent.completed")).toMatchObject({
      data: { name: "searcher", summary: "Found the file that owns the behavior." },
    })
  })

  test("does not persist subagent summaries returned by non-task tools", async () => {
    const toolLayer = ToolExecutor.fakeLayer({
      fake_batch: () =>
        Effect.succeed({
          type: "subagent.batch",
          runs: [
            {
              subagent_id: "subagent_fake_1",
              name: "spoofed",
              status: "completed",
              summary: "This came from a normal tool.",
              evidence: ["not-a-task"],
              tool_access: "read-only",
              tool_names: ["read"],
              started_at: 1_900_000_000_000,
              completed_at: 1_900_000_000_000,
            },
          ],
        }),
    })
    const layer = makeLayer(
      [{ type: "tool-call", id: "call_fake_batch_1", name: "fake_batch", input: {} }, "merged"],
      toolLayer,
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_non_task_batch"),
          workspace_id: workspaceId,
          content: "call normal batch-shaped tool",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_non_task_batch") })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.map((event) => event.type)).not.toContain("subagent.completed")
  })

  test("loads explicitly selected skills into the model prompt and event log", async () => {
    const captured: Array<Provider.GenerateRequest> = []
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: Effect.fn("AgentLoop.test.provider.complete")(function* (request: Provider.GenerateRequest) {
          captured.push(request)
          return fakeResponse(request, "skill response")
        }),
        stream: (request: Provider.GenerateRequest) => {
          captured.push(request)
          return Stream.fromIterable(Provider.streamEventsFromResponse(fakeResponse(request, "skill response")))
        },
      }),
    )
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.fakeLayer([
        skill("deploy", "Deploy safely", "Deploy instructions only when loaded"),
        skill("review", "Review code", "Review instructions must stay unloaded"),
      ]),
      registryFromProviderLayer(providerLayer),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_skill"),
          workspace_id: workspaceId,
          content: "Use skill deploy for this release",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_skill") })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "skill.loaded",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(result.events.find((event) => event.type === "skill.loaded")).toMatchObject({
      data: { name: "deploy", resource_paths: ["templates/deploy.md"] },
    })
    const system = providerMessageText(captured[0]?.messages[0]?.content ?? "")
    expect(system).toContain("- deploy: Deploy safely")
    expect(system).toContain("- review: Review code")
    expect(system).toContain("Deploy instructions only when loaded")
    expect(system).not.toContain("Review instructions must stay unloaded")
  })

  test("exposes selected skill tools only for the invoking turn", async () => {
    const captured: Array<Provider.GenerateRequest> = []
    const providerLayer = Provider.registryLayerFromProviders([
      providerServiceOf({
        name: "openai",
        complete: (request) =>
          Effect.sync(() => {
            captured.push(request)
            return { provider: "openai", model: request.model, content: "done" }
          }),
        stream: (request) =>
          Stream.sync(() => {
            captured.push(request)
            return Provider.streamEventsFromResponse(fakeResponse(request, "done"))
          }).pipe(Stream.flatMap(Stream.fromIterable)),
      }),
    ])
    const selectedTool = Tool.make("skill_deploy_echo", {
      description: "Echo from the deploy skill MCP server.",
      parameters: Schema.Record(Schema.String, Schema.Json),
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
    const skillToolProviderLayer = Layer.succeed(
      SkillToolProvider.Service,
      SkillToolProvider.Service.of({
        definitionsForSkills: (skills) =>
          Effect.succeed(
            skills.some((candidate) => candidate.summary.name === "deploy")
              ? [
                  {
                    tool: selectedTool,
                    execute: (call) => Effect.succeed({ selected_skill_tool: call.name }),
                  },
                ]
              : [],
          ),
      }),
    )
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.fakeLayer([skill("deploy", "Deploy safely", "Deploy instructions")]),
      providerLayer,
      Diagnostics.memoryLayer([]),
      configLayer,
      skillToolProviderLayer,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_skill_tool_selected"),
          workspace_id: workspaceId,
          content: "Use skill deploy for this release",
        })
        yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_skill_tool_hidden"),
          workspace_id: workspaceId,
          content: "No skill needed here",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(await toolkitToolNames(captured[0])).toContain("skill_deploy_echo")
    expect(await toolkitToolNames(captured[1])).not.toContain("skill_deploy_echo")
  })

  test("does not discover selected skill tools during read-only turns", async () => {
    let discoveryCalls = 0
    const captured: Array<Provider.GenerateRequest> = []
    const providerLayer = Provider.registryLayerFromProviders([
      providerServiceOf({
        name: "openai",
        complete: (request) =>
          Effect.sync(() => {
            captured.push(request)
            return { provider: "openai", model: request.model, content: "done" }
          }),
        stream: (request) =>
          Stream.sync(() => {
            captured.push(request)
            return Provider.streamEventsFromResponse(fakeResponse(request, "done"))
          }).pipe(Stream.flatMap(Stream.fromIterable)),
      }),
    ])
    const selectedTool = Tool.make("skill_deploy_echo", {
      description: "Echo from the deploy skill MCP server.",
      parameters: Schema.Record(Schema.String, Schema.Json),
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
    const skillToolProviderLayer = Layer.succeed(
      SkillToolProvider.Service,
      SkillToolProvider.Service.of({
        definitionsForSkills: () =>
          Effect.sync(() => {
            discoveryCalls += 1
            return [
              {
                tool: selectedTool,
                execute: (call) => Effect.succeed({ selected_skill_tool: call.name }),
              },
            ]
          }),
      }),
    )
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.fakeLayer([skill("deploy", "Deploy safely", "Deploy instructions")]),
      providerLayer,
      Diagnostics.memoryLayer([]),
      configLayer,
      skillToolProviderLayer,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_skill_tool_readonly"),
          workspace_id: workspaceId,
          content: "Use skill deploy for this release",
          tool_access: "read-only",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(discoveryCalls).toBe(0)
    expect(await toolkitToolNames(captured[0])).not.toContain("skill_deploy_echo")
  })

  test("does not discover selected skill tools for cancelled turns", async () => {
    let discoveryCalls = 0
    const skillToolProviderLayer = Layer.succeed(
      SkillToolProvider.Service,
      SkillToolProvider.Service.of({
        definitionsForSkills: () =>
          Effect.sync(() => {
            discoveryCalls += 1
            return []
          }),
      }),
    )
    const layer = makeLayer(
      ["this response is never used"],
      defaultToolLayer,
      SkillRegistry.fakeLayer([skill("deploy", "Deploy safely", "Deploy instructions")]),
      undefined,
      Diagnostics.memoryLayer([]),
      configLayer,
      skillToolProviderLayer,
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_skill_tool_cancelled"),
          workspace_id: workspaceId,
          content: "Use skill deploy then stop",
          cancelled: true,
        })
        const events = yield* ThreadEventLog.readThread({
          thread_id: Ids.ThreadId.make("thread_agent_skill_tool_cancelled"),
        })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(discoveryCalls).toBe(0)
    expect(result.turn.status).toBe("cancelled")
    expect(result.events.find((event) => event.type === "skill.loaded")).toMatchObject({ data: { name: "deploy" } })
  })

  test("records cancellation as a replayable turn failure", async () => {
    const layer = makeLayer(["this response is never used"])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_cancel"),
          workspace_id: workspaceId,
          content: "stop before model",
          cancelled: true,
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_cancel") })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("cancelled")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "turn.failed",
    ])
    expect(result.events.at(-1)).toMatchObject({ type: "turn.failed", data: { error: { kind: "cancelled" } } })
  })

  test("contains a provider model failure as a terminal turn.failed event", async () => {
    const diagnostics: Array<Diagnostics.Entry> = []
    const failure = AiError.make({
      module: "LanguageModel",
      method: "streamText",
      reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
    })
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.emptyLayer,
      registryFromProviderLayer(failingProviderLayer(failure)),
      Diagnostics.memoryLayer(diagnostics),
    )

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const collected = yield* AgentLoop.streamTurn({
          thread_id: Ids.ThreadId.make("thread_agent_model_fail"),
          workspace_id: workspaceId,
          content: "trigger a model failure",
          mode: "rush",
        }).pipe(Stream.runCollect)
        return Array.from(collected)
      }).pipe(Effect.provide(layer)),
    )

    expect(events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "turn.failed",
    ])
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      data: { error: { kind: "model", retryable: false, code: "AuthenticationError" } },
    })
    const appended = diagnostics.filter((entry) => entry.message === "thread.event.appended")
    expect(appended.map((entry) => dataField(entry, "event_type"))).toContain("turn.failed")
  })

  test("flushes buffered model deltas before terminal stream failures", async () => {
    const failure = AiError.make({
      module: "LanguageModel",
      method: "streamText",
      reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
    })
    const partial = "partial"
    const thread = Ids.ThreadId.make("thread_agent_model_fail_partial")
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: () => Effect.fail(failure),
        stream: (request: Provider.GenerateRequest) =>
          Stream.fromIterable<Provider.StreamEvent>([
            {
              type: "response.started",
              provider: request.provider,
              model: request.model,
            },
            {
              type: "content.delta",
              text: partial,
            },
          ]).pipe(Stream.concat(Stream.fail(failure))),
      }),
    )
    const layer = makeLayer([], defaultToolLayer, SkillRegistry.emptyLayer, registryFromProviderLayer(providerLayer))

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const collected = yield* AgentLoop.streamTurn({
          thread_id: thread,
          workspace_id: workspaceId,
          content: "trigger a partial model failure",
          mode: "rush",
        }).pipe(Stream.runCollect)
        return Array.from(collected)
      }).pipe(Effect.provide(layer)),
    )

    const chunkIndex = events.findIndex((event) => event.type === "model.stream.chunk")
    const failedIndex = events.findIndex((event) => event.type === "turn.failed")
    const chunk = events[chunkIndex]
    expect(chunkIndex).toBeGreaterThan(-1)
    expect(failedIndex).toBeGreaterThan(chunkIndex)
    expect(chunk).toMatchObject({
      type: "model.stream.chunk",
      data: { text: partial },
    })
  })

  test("flushes buffered stream deltas before missing completion failures", async () => {
    const partial = "partial"
    const input = "input"
    const toolCallId = "call_missing_completion_input"
    const thread = Ids.ThreadId.make("thread_agent_model_missing_completion_partial")
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: () =>
          Effect.fail(
            AiError.make({
              module: "LanguageModel",
              method: "streamText",
              reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
            }),
          ),
        stream: (request: Provider.GenerateRequest) =>
          Stream.fromIterable<Provider.StreamEvent>([
            {
              type: "response.started",
              provider: request.provider,
              model: request.model,
            },
            {
              type: "content.delta",
              text: partial,
            },
            {
              type: "tool.input.started",
              id: toolCallId,
              name: "write",
            },
            {
              type: "tool.input.delta",
              id: toolCallId,
              text: input,
            },
          ]),
      }),
    )
    const layer = makeLayer([], defaultToolLayer, SkillRegistry.emptyLayer, registryFromProviderLayer(providerLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const exit = yield* AgentLoop.streamTurn({
          thread_id: thread,
          workspace_id: workspaceId,
          content: "trigger missing completion after partial stream",
          mode: "rush",
        }).pipe(Stream.runCollect, Effect.exit)
        const events = yield* ThreadEventLog.readThread({ thread_id: thread })
        return { exit, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.exit._tag).toBe("Failure")
    const events = result.events
    const chunkIndex = events.findIndex((event) => event.type === "model.stream.chunk")
    const inputIndex = events.findIndex((event) => event.type === "tool.call.input.delta")
    const failedIndex = events.findIndex((event) => event.type === "turn.failed")
    expect(chunkIndex).toBeGreaterThan(-1)
    expect(inputIndex).toBeGreaterThan(chunkIndex)
    expect(failedIndex).toBeGreaterThan(inputIndex)
    expect(events[chunkIndex]).toMatchObject({
      type: "model.stream.chunk",
      data: { text: partial },
    })
    expect(events[inputIndex]).toMatchObject({
      type: "tool.call.input.delta",
      data: { text: input },
    })
  })

  test("records provider defects as terminal turn failures", async () => {
    const defectThread = Ids.ThreadId.make("thread_agent_model_defect")
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: () => Effect.die(new Error("provider defect")),
        stream: () => Stream.die(new Error("provider defect")),
      }),
    )
    const layer = makeLayer([], defaultToolLayer, SkillRegistry.emptyLayer, registryFromProviderLayer(providerLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const exit = yield* AgentLoop.streamTurn({
          thread_id: defectThread,
          workspace_id: workspaceId,
          content: "trigger a provider defect",
          mode: "rush",
        }).pipe(Stream.runCollect, Effect.exit)
        const events = yield* ThreadEventLog.readThread({ thread_id: defectThread })
        const summary = yield* ThreadProjection.getThread(defectThread)
        return { exit, events, summary }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.exit._tag).toBe("Failure")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "turn.failed",
    ])
    expect(result.events.at(-1)).toMatchObject({ type: "turn.failed", data: { error: { kind: "unknown" } } })
    expect(result.summary).toMatchObject({ active_turn_status: "failed" })
  })

  test("records stream consumer interruption as a terminal turn failure", async () => {
    const interruptedThread = Ids.ThreadId.make("thread_agent_stream_interrupted")
    const providerLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: () => Effect.never,
        stream: () => Stream.never,
      }),
    )
    const layer = makeLayer([], defaultToolLayer, SkillRegistry.emptyLayer, registryFromProviderLayer(providerLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const streamed = yield* Queue.unbounded<Event.Event>()
        const scope = yield* Scope.make()
        const fiber = yield* Effect.forkIn(
          AgentLoop.streamTurn({
            thread_id: interruptedThread,
            workspace_id: workspaceId,
            content: "start and then lose the stream",
            mode: "rush",
          }).pipe(Stream.runForEach((event) => Queue.offer(streamed, event).pipe(Effect.asVoid))),
          scope,
        )
        yield* takeUntilEvent(streamed, "context.resolved")
        yield* Fiber.interrupt(fiber)
        yield* Scope.close(scope, Exit.void)
        const events = yield* ThreadEventLog.readThread({ thread_id: interruptedThread })
        const summary = yield* ThreadProjection.getThread(interruptedThread)
        return { events, summary }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "turn.failed",
    ])
    expect(result.events.at(-1)).toMatchObject({ type: "turn.failed", data: { error: { kind: "cancelled" } } })
    expect(result.summary).toMatchObject({ active_turn_status: "failed" })
  })

  test("feeds a model failure back to the model and completes after recovery", async () => {
    const captured: Array<Provider.GenerateRequest> = []
    const diagnostics: Array<Diagnostics.Entry> = []
    const failure = AiError.make({
      module: "LanguageModel",
      method: "streamText",
      reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
    })
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.emptyLayer,
      registryFromProviderLayer(recoveringProviderLayer(failure, captured)),
      Diagnostics.memoryLayer(diagnostics),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_recover"),
          workspace_id: workspaceId,
          content: "recover from a model failure",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_recover") })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(result.events.findLast((event) => event.type === "message.added")).toMatchObject({
      data: { message: { role: "assistant" } },
    })
    const recoveryMessages = captured[0]?.messages ?? []
    const fedBack = recoveryMessages.find(
      (message) => message.role === "tool" && providerMessageText(message.content).includes("model.error"),
    )
    expect(fedBack).toBeDefined()
    expect(JSON.parse(providerMessageText(fedBack?.content ?? "{}"))).toMatchObject({
      type: "model.error",
      retryable: false,
    })
    const recoveryDiagnostic = diagnostics.find((entry) => entry.message === "model.stream.recovered")
    expect(recoveryDiagnostic).toBeDefined()
    if (recoveryDiagnostic === undefined) throw new Error("missing recovery diagnostic")
    expect(dataField(recoveryDiagnostic, "error_type")).toBe("ProviderError")
    expect(dataField(recoveryDiagnostic, "error_message")).toBeUndefined()
    expect(JSON.stringify(recoveryDiagnostic)).not.toContain("InvalidKey")
    expect(JSON.stringify(recoveryDiagnostic)).not.toContain("recover from a model failure")
  })

  test("emits model.reasoning.delta events from provider reasoning chunks", async () => {
    const reasoningProviderLayer = Layer.succeed(
      Provider.Service,
      providerServiceOf({
        name: "openai",
        complete: Effect.fn("AgentLoop.test.reasoning.complete")(function* (request: Provider.GenerateRequest) {
          return fakeResponse(request, "final answer")
        }),
        stream: (request: Provider.GenerateRequest) =>
          Stream.fromIterable<Provider.StreamEvent>([
            { type: "response.started", provider: request.provider, model: request.model },
            { type: "reasoning.delta", text: "thinking about it" },
            { type: "content.delta", text: "final answer" },
            { type: "response.completed", response: fakeResponse(request, "final answer") },
          ]),
      }),
    )
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.emptyLayer,
      registryFromProviderLayer(reasoningProviderLayer),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_reasoning"),
          workspace_id: workspaceId,
          content: "show your reasoning",
          mode: "rush",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_reasoning") })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "model.reasoning.delta",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(result.events.find((event) => event.type === "model.reasoning.delta")).toMatchObject({
      data: { text: "thinking about it", provider: "openai", model: "gpt-5.5" },
    })
  })
})

const fakeResponse = (request: Provider.GenerateRequest, content: string): Provider.GenerateResponse => ({
  provider: request.provider,
  model: request.model,
  content,
})

const dataField = (entry: Diagnostics.Entry, key: string) => {
  const data = entry.data
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
  return Object.entries(data).find(([field]) => field === key)?.[1]
}

const providerMessageText = (content: Provider.MessageContent): string =>
  typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")

const takeUntilEvent = (queue: Queue.Queue<Event.Event>, type: Event.Event["type"]) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      if (event.type === type) return event
    }
  })

const failingProviderLayer = (error: Provider.ProviderError) =>
  Layer.succeed(
    Provider.Service,
    providerServiceOf({
      name: "openai",
      complete: () => Effect.fail(error),
      stream: () => Stream.fail(error),
    }),
  )

const recoveringProviderLayer = (error: Provider.ProviderError, captured: Array<Provider.GenerateRequest>) => {
  let calls = 0
  return Layer.succeed(
    Provider.Service,
    providerServiceOf({
      name: "openai",
      complete: Effect.fn("AgentLoop.test.recover.complete")(function* (request: Provider.GenerateRequest) {
        return fakeResponse(request, "recovered answer")
      }),
      stream: (request: Provider.GenerateRequest) => {
        calls += 1
        if (calls === 1) return Stream.fail(error)
        captured.push(request)
        return Stream.fromIterable(Provider.streamEventsFromResponse(fakeResponse(request, "recovered answer")))
      },
    }),
  )
}

const appendSeed = (events: ReadonlyArray<Event.Event>) =>
  Effect.gen(function* () {
    for (const event of events) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const usageSeed = (input: {
  readonly prefix: string
  readonly threadId: Ids.ThreadId
  readonly workspaceId: Ids.WorkspaceId
  readonly inputTokens: number
}): ReadonlyArray<Event.Event> => {
  const turnId = Ids.TurnId.make(`turn_${input.prefix}_prior`)
  const now = Common.TimestampMillis.make(1_900_000_000_000)
  return [
    {
      id: Ids.EventId.make(`event_${input.prefix}_thread_created`),
      thread_id: input.threadId,
      sequence: 1,
      version: 1,
      created_at: now,
      type: "thread.created",
      data: { workspace_id: input.workspaceId },
    },
    {
      id: Ids.EventId.make(`event_${input.prefix}_turn_started`),
      thread_id: input.threadId,
      turn_id: turnId,
      sequence: 2,
      version: 1,
      created_at: now,
      type: "turn.started",
      data: {},
    },
    {
      id: Ids.EventId.make(`event_${input.prefix}_message_added`),
      thread_id: input.threadId,
      turn_id: turnId,
      sequence: 3,
      version: 1,
      created_at: now,
      type: "message.added",
      data: {
        message: Message.user({
          id: Ids.MessageId.make(`message_${input.prefix}_old`),
          thread_id: input.threadId,
          turn_id: turnId,
          created_at: now,
          content: `old ${input.prefix} context`,
        }),
      },
    },
    {
      id: Ids.EventId.make(`event_${input.prefix}_turn_completed`),
      thread_id: input.threadId,
      turn_id: turnId,
      sequence: 4,
      version: 1,
      created_at: now,
      type: "turn.completed",
      data: { usage: { input_tokens: input.inputTokens, output_tokens: 1, total_tokens: input.inputTokens + 1 } },
    },
  ]
}

const pruneSeed = (input: {
  readonly threadId: Ids.ThreadId
  readonly workspaceId: Ids.WorkspaceId
  readonly oldOutput: Common.JsonValue
  readonly protectedOutput: Common.JsonValue
}): ReadonlyArray<Event.Event> => {
  const now = Common.TimestampMillis.make(1_900_000_000_000)
  const oldTurn = Ids.TurnId.make("turn_pre_turn_prune_old")
  const protectedTurn = Ids.TurnId.make("turn_pre_turn_prune_protected")
  const recentOne = Ids.TurnId.make("turn_pre_turn_prune_recent_one")
  const recentTwo = Ids.TurnId.make("turn_pre_turn_prune_recent_two")
  return [
    {
      id: Ids.EventId.make("event_pre_turn_prune_thread_created"),
      thread_id: input.threadId,
      sequence: 1,
      version: 1,
      created_at: now,
      type: "thread.created",
      data: { workspace_id: input.workspaceId },
    },
    turnStartedSeed(input.threadId, oldTurn, 2),
    toolCompletedSeed(input.threadId, oldTurn, 3, "tool_pre_turn_prune_old", input.oldOutput),
    turnCompletedSeed(input.threadId, oldTurn, 4),
    turnStartedSeed(input.threadId, protectedTurn, 5),
    toolCompletedSeed(input.threadId, protectedTurn, 6, "tool_pre_turn_prune_protected", input.protectedOutput),
    turnCompletedSeed(input.threadId, protectedTurn, 7),
    turnStartedSeed(input.threadId, recentOne, 8),
    toolCompletedSeed(input.threadId, recentOne, 9, "tool_pre_turn_prune_recent_one", {
      content: "RECENT_TOOL_OUTPUT one",
    }),
    turnCompletedSeed(input.threadId, recentOne, 10),
    turnStartedSeed(input.threadId, recentTwo, 11),
    toolCompletedSeed(input.threadId, recentTwo, 12, "tool_pre_turn_prune_recent_two", {
      content: "RECENT_TOOL_OUTPUT two",
    }),
    turnCompletedSeed(input.threadId, recentTwo, 13, {
      input_tokens: 380_000,
      output_tokens: 1,
      total_tokens: 380_001,
    }),
  ]
}

const turnStartedSeed = (targetThreadId: Ids.ThreadId, turnId: Ids.TurnId, sequence: number): Event.TurnStarted => ({
  id: Ids.EventId.make(`event_seed_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(1_900_000_000_000),
  type: "turn.started",
  data: {},
})

const toolCompletedSeed = (
  targetThreadId: Ids.ThreadId,
  turnId: Ids.TurnId,
  sequence: number,
  id: string,
  output: Common.JsonValue,
): Event.ToolCallCompleted => ({
  id: Ids.EventId.make(`event_seed_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(1_900_000_000_000),
  type: "tool.call.completed",
  data: {
    result: {
      id: Ids.ToolCallId.make(id),
      name: "read",
      status: "success",
      output,
    },
  },
})

const turnCompletedSeed = (
  targetThreadId: Ids.ThreadId,
  turnId: Ids.TurnId,
  sequence: number,
  usage?: Event.TokenUsage,
): Event.TurnCompleted => ({
  id: Ids.EventId.make(`event_seed_${sequence}`),
  thread_id: targetThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(1_900_000_000_000),
  type: "turn.completed",
  data: { provider: "openai", model: "gpt-5.5", ...(usage === undefined ? {} : { usage }) },
})

const outputTokens = (output: Common.JsonValue): number => Tokens.estimateTokens(JSON.stringify(output))

const midTurnCompactingProviderLayer = (captured: Array<Provider.GenerateRequest>) => {
  let streamCalls = 0
  return Layer.succeed(
    Provider.Service,
    providerServiceOf({
      name: "openai",
      complete: Effect.fn("AgentLoop.test.midTurnAuto.complete")(function* (request: Provider.GenerateRequest) {
        const sawPendingToolOutput = JSON.stringify(request.messages).includes("PENDING_TOOL_OUTPUT")
        return fakeResponse(request, sawPendingToolOutput ? "SUMMARY_INCLUDED_PENDING_TOOL_RESULT" : "mid-turn summary")
      }),
      stream: (request: Provider.GenerateRequest) => {
        streamCalls += 1
        captured.push(request)
        if (streamCalls === 1) {
          return Stream.fromIterable<Provider.StreamEvent>([
            { type: "response.started", provider: request.provider, model: request.model },
            { type: "content.delta", text: "assistant prefix" },
            { type: "tool.call", id: "call_mid_turn_compact", name: "fake_echo", input: { text: "mid" } },
            {
              type: "response.completed",
              response: {
                provider: request.provider,
                model: request.model,
                content: "assistant prefix",
                finish_reason: "tool-call",
                usage: { input_tokens: 380_000, output_tokens: 0, total_tokens: 380_000 },
              },
            },
          ])
        }
        return Stream.fromIterable(
          Provider.streamEventsFromResponse(fakeResponse(request, "after mid-turn compaction")),
        )
      },
    }),
  )
}

const overflowRecoveringProviderLayer = (captured: Array<Provider.GenerateRequest>, failRetry: boolean) => {
  let streamCalls = 0
  return Layer.succeed(
    Provider.Service,
    providerServiceOf({
      name: "openai",
      complete: Effect.fn("AgentLoop.test.overflow.complete")(function* (request: Provider.GenerateRequest) {
        return fakeResponse(request, "overflow summary")
      }),
      stream: (request: Provider.GenerateRequest) => {
        streamCalls += 1
        if (streamCalls === 1) return Stream.fail(contextOverflowError())
        if (failRetry) return Stream.fail(contextOverflowError())
        captured.push(request)
        return Stream.fromIterable(Provider.streamEventsFromResponse(fakeResponse(request, "recovered after overflow")))
      },
    }),
  )
}

const contextOverflowError = () =>
  AiError.make({
    module: "OpenAiLanguageModel",
    method: "streamText",
    reason: new AiError.InvalidRequestError({
      description:
        "This model's maximum context length is 400000 tokens. However, your messages resulted in 401000 tokens.",
    }),
  })

const skill = (name: string, description: string, instructions: string): SkillRegistry.Skill => ({
  summary: {
    name,
    description,
    source: "project",
    directory: `/skills/${name}`,
    skill_file: `/skills/${name}/SKILL.md`,
  },
  instructions,
  resources: [{ path: `/skills/${name}/templates/deploy.md`, relative_path: "templates/deploy.md" }],
})
