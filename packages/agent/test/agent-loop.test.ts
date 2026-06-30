import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, IdGenerator, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect"
import { AiError, Prompt } from "effect/unstable/ai"
import { AgentLoop, ContextResolver, PermissionPolicy, SkillRegistry, ToolExecutor, ToolRegistry } from "../src/index"

const threadId = Ids.ThreadId.make("thread_agent_loop")
const workspaceId = Ids.WorkspaceId.make("workspace_agent_loop")

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-test",
  data_dir: "/workspace/rika-test/.rika",
  default_mode: "rush",
})

const defaultToolLayer = ToolExecutor.fakeLayer({
  fake_echo: (call) => Effect.succeed({ echoed: call.input }),
})

const registryFromProviderLayer = (providerLayer: Layer.Layer<Provider.Service>) =>
  Provider.registryLayerFromService.pipe(Layer.provide(providerLayer))

const makeLayer = (
  responses: ReadonlyArray<Provider.FakeResponse>,
  toolLayer = defaultToolLayer,
  skillLayer = SkillRegistry.emptyLayer,
  providerLayer: Layer.Layer<Provider.Registry> = Provider.fakeRegistryLayer([
    { name: "openai", responses },
    { name: "anthropic", responses },
  ]),
  diagnosticsLayer = Diagnostics.memoryLayer([]),
) => {
  const llmLayer = Router.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(providerLayer))
  const services = Layer.mergeAll(
    configLayer,
    Database.memoryLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(Common.TimestampMillis.make(1_900_000_000_000)),
    IdGenerator.sequenceLayer(1),
    diagnosticsLayer,
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
    toolLayer,
    llmLayer,
  )

  return AgentLoop.layer.pipe(Layer.provideMerge(services))
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

  test("loops through multiple tool calls before emitting the final answer", async () => {
    const multiToolThread = Ids.ThreadId.make("thread_agent_multi_tool")
    const layer = makeLayer([
      { type: "tool-call", id: "call_fake_echo_1", name: "fake_echo", input: { text: "first" } },
      { type: "tool-call", id: "call_fake_echo_2", name: "fake_echo", input: { text: "second" } },
      "done after two tools",
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
    expect(result.events.at(-1)).toMatchObject({ type: "turn.completed" })
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

  test("coalesces bursty model deltas before persistence and replay", async () => {
    const burstThread = Ids.ThreadId.make("thread_agent_bursty_model")
    const chunkCount = 512
    const chunkText = "x"
    const content = chunkText.repeat(chunkCount)
    const providerLayer = Layer.succeed(
      Provider.Service,
      Provider.Service.of({
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
      Provider.Service.of({
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
      Provider.Service.of({
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
      Provider.Service.of({
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

  test("records provider defects as terminal turn failures", async () => {
    const defectThread = Ids.ThreadId.make("thread_agent_model_defect")
    const providerLayer = Layer.succeed(
      Provider.Service,
      Provider.Service.of({
        name: "openai",
        complete: () => Effect.die(new Error("provider defect")),
        stream: () => Stream.die(new Error("provider defect")),
      }),
    )
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.emptyLayer,
      registryFromProviderLayer(providerLayer),
    )

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
      Provider.Service.of({
        name: "openai",
        complete: () => Effect.never,
        stream: () => Stream.never,
      }),
    )
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.emptyLayer,
      registryFromProviderLayer(providerLayer),
    )

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
      Provider.Service.of({
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

  test("queues follow-up turns through the service boundary without module-level state", async () => {
    const layer = makeLayer(["queued later"])

    const queued = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* AgentLoop.queueTurn({ thread_id: threadId, workspace_id: workspaceId, content: "next" })
      }).pipe(Effect.provide(layer)),
    )

    expect(queued).toEqual({ thread_id: threadId, position: 1 })
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
    Provider.Service.of({
      name: "openai",
      complete: () => Effect.fail(error),
      stream: () => Stream.fail(error),
    }),
  )

const recoveringProviderLayer = (error: Provider.ProviderError, captured: Array<Provider.GenerateRequest>) => {
  let calls = 0
  return Layer.succeed(
    Provider.Service,
    Provider.Service.of({
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
