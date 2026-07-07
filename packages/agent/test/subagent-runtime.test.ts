import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { Common, Ids } from "@rika/schema"
import type { Call } from "@rika/schema/tool"
import { Effect, Layer, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import { SubagentRuntime, ToolExecutor } from "../src/index"

const now = Common.TimestampMillis.make(2_000_000_000_000)
const readTool = Tool.make("read", {
  description: "Read a workspace file",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.Json,
  failure: Schema.Json,
  failureMode: "return",
})

const defaultToolLayer = ToolExecutor.fakeSubagentLayer(
  {
    read: (call) => Effect.succeed({ path: pathFromInput(call.input), content: "read output" }),
  },
  [readTool],
)

const configLayer = (subagentTools?: Config.SubagentTools) =>
  Config.layerFromValues({
    workspace_root: "/workspace/rika-subagent-runtime-test",
    data_dir: "/workspace/rika-subagent-runtime-test/.rika",
    default_mode: "smart",
    ...(subagentTools === undefined ? {} : { subagent_tools: subagentTools }),
  })
const redactorLayer = SecretRedactor.layer
const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))

const makeLayer = (
  routerLayer: Layer.Layer<Router.Service>,
  toolLayer = defaultToolLayer,
  activeConfigLayer = configLayer(),
) =>
  SubagentRuntime.layer.pipe(
    Layer.provideMerge(activeConfigLayer),
    Layer.provideMerge(redactorLayer),
    Layer.provideMerge(diagnosticsLayer),
    Layer.provideMerge(IdGenerator.sequenceLayer(1)),
    Layer.provideMerge(Time.fixedLayer(now)),
    Layer.provideMerge(routerLayer),
    Layer.provideMerge(toolLayer.pipe(Layer.provideMerge(diagnosticsLayer))),
  )

describe("SubagentRuntime", () => {
  test("runs independent read-only subagents concurrently and returns compact evidence", async () => {
    let active = 0
    let maxActive = 0
    const requests: Array<Router.Request> = []
    const routerLayer = fakeRouterLayer((request) =>
      Effect.promise(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        requests.push(request)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active -= 1
        const prompt = providerMessageText(request.messages.at(-1)?.content ?? "missing")
        return response(`Summary for ${prompt}\n- evidence:${prompt}`)
      }),
    )

    const result = await Effect.runPromise(
      SubagentRuntime.runBatch({
        agents: [
          { name: "alpha", prompt: "inspect alpha" },
          { name: "beta", prompt: "inspect beta" },
        ],
      }).pipe(Effect.provide(makeLayer(routerLayer))),
    )

    expect(maxActive).toBeGreaterThan(1)
    expect(result.runs.map((run) => `${run.name}:${run.status}:${run.summary.split("\n")[0]}`)).toEqual([
      "alpha:completed:Summary for inspect alpha",
      "beta:completed:Summary for inspect beta",
    ])
    expect(result.runs[0]?.evidence).toEqual(["evidence:inspect alpha"])
    expect(requests[0]?.messages.map((message) => providerMessageText(message.content)).join("\n")).not.toContain(
      "inspect beta",
    )
    expect(requests[1]?.messages.map((message) => providerMessageText(message.content)).join("\n")).not.toContain(
      "inspect alpha",
    )
    expect(requests.map((request) => Object.hasOwn(request, "max_output_tokens"))).toEqual([false, false])
  })

  test("defaults to the exact read-only tool list in readonly mode", async () => {
    const routerRequests: Array<Router.Request> = []
    const routerLayer = fakeRouterLayer((request) =>
      Effect.sync(() => {
        routerRequests.push(request)
        return response("read-only done")
      }),
    )

    const result = await Effect.runPromise(
      SubagentRuntime.runBatch({ agents: [{ name: "reader", prompt: "inspect files" }] }).pipe(
        Effect.provide(makeLayer(routerLayer)),
      ),
    )

    expect(result.runs[0]).toMatchObject({
      tool_access: "read-only",
      tool_names: [...SubagentRuntime.readOnlyToolNames],
    })
    const systemPrompt = providerMessageText(routerRequests[0]?.messages[0]?.content ?? "")
    expect(systemPrompt).toContain("Read-only tools available to this subagent:")
    expect(systemPrompt).not.toContain("shell_command")
    expect(systemPrompt).not.toContain("edit")
    expect(systemPrompt).not.toContain("task")
  })

  test("defaults to the full non-recursive toolkit in full mode", async () => {
    const routerRequests: Array<Router.Request> = []
    const shellTool = Tool.make("shell_command", {
      description: "Run a shell command",
      parameters: Schema.Struct({ command: Schema.String }),
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
    const editTool = Tool.make("edit", {
      description: "Edit a workspace file",
      parameters: Schema.Struct({ path: Schema.String }),
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
    const taskTool = Tool.make("task", {
      description: "Spawn a subagent",
      parameters: Schema.Struct({ prompt: Schema.String }),
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
    const routerLayer = fakeRouterLayer((request) =>
      Effect.sync(() => {
        routerRequests.push(request)
        return response("full done")
      }),
    )
    const toolLayer = ToolExecutor.fakeSubagentLayer(
      {
        read: () => Effect.succeed({ ok: true }),
        shell_command: () => Effect.succeed({ ok: true }),
        edit: () => Effect.succeed({ ok: true }),
        task: () => Effect.succeed({ ok: true }),
      },
      [readTool, shellTool, editTool, taskTool],
    )

    const result = await Effect.runPromise(
      SubagentRuntime.runBatch({ agents: [{ name: "writer", prompt: "edit files" }] }).pipe(
        Effect.provide(makeLayer(routerLayer, toolLayer, configLayer("full"))),
      ),
    )

    expect(result.runs[0]).toMatchObject({
      tool_access: "read-write",
      tool_names: ["read", "shell_command", "edit"],
    })
    const systemPrompt = providerMessageText(routerRequests[0]?.messages[0]?.content ?? "")
    expect(systemPrompt).toContain("Tools available to this subagent:")
    expect(systemPrompt).toContain("shell_command")
    expect(systemPrompt).toContain("edit")
    expect(systemPrompt).not.toContain("- task:")
    expect(systemPrompt).not.toContain("Spawn a subagent")
  })

  test("rejects mutating tool access before subagents run", async () => {
    let called = false
    const routerLayer = fakeRouterLayer(() =>
      Effect.sync(() => {
        called = true
        return response("should not run")
      }),
    )

    const error = await Effect.runPromise(
      SubagentRuntime.runBatch({ agents: [{ name: "writer", prompt: "edit files", tool_names: ["write"] }] }).pipe(
        Effect.provide(makeLayer(routerLayer)),
        Effect.flip,
      ),
    )

    expect(called).toBe(false)
    expect(error).toMatchObject({ message: expect.stringContaining("read-only") })
  })

  test("rejects explicit read-write access in readonly mode", async () => {
    let called = false
    const routerLayer = fakeRouterLayer(() =>
      Effect.sync(() => {
        called = true
        return response("should not run")
      }),
    )

    const error = await Effect.runPromise(
      SubagentRuntime.runBatch({
        agents: [
          {
            name: "writer",
            prompt: "edit files",
            tool_access: "read-write",
            tool_names: ["edit"],
          },
        ],
      }).pipe(Effect.provide(makeLayer(routerLayer)), Effect.flip),
    )

    expect(called).toBe(false)
    expect(error).toMatchObject({ message: "Subagents are read-only; disallowed tools: read-write" })
  })

  test("allows read-write subagents to use workspace tools", async () => {
    const toolCalls: Array<Call> = []
    const routerRequests: Array<Router.Request> = []
    let requestCount = 0
    const shellTool = Tool.make("shell_command", {
      description: "Run a shell command",
      parameters: Schema.Struct({ command: Schema.String }),
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
    const routerLayer = fakeRouterLayer((request) =>
      Effect.sync(() => {
        routerRequests.push(request)
        requestCount += 1
        if (requestCount === 1) {
          return response(JSON.stringify({ tool_call: { name: "shell_command", input: { command: "printf ok" } } }))
        }
        return response("Created the file.\n- subagent-output.txt")
      }),
    )
    const toolLayer = ToolExecutor.fakeSubagentLayer(
      {
        shell_command: (call) =>
          Effect.sync(() => {
            toolCalls.push(call)
            return { stdout: "ok", stderr: "", exit_code: 0 }
          }),
      },
      [shellTool],
    )

    const result = await Effect.runPromise(
      SubagentRuntime.runBatch({
        agents: [
          {
            name: "writer",
            prompt: "create a file",
            tool_access: "read-write",
            tool_names: ["shell_command"],
          },
        ],
      }).pipe(Effect.provide(makeLayer(routerLayer, toolLayer, configLayer("full")))),
    )

    expect(result.runs[0]).toMatchObject({
      name: "writer",
      status: "completed",
      evidence: ["subagent-output.txt"],
      tool_access: "read-write",
      tool_names: ["shell_command"],
    })
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({ name: "shell_command", input: { command: "printf ok" } })
    const systemPrompt = providerMessageText(routerRequests[0]?.messages[0]?.content ?? "")
    expect(systemPrompt).toContain("Tools available to this subagent:")
    expect(systemPrompt).toContain("Use mutating tools only when required by the delegated task.")
    expect(systemPrompt).not.toContain("Read-only tools available to this subagent:")
    expect(systemPrompt).not.toContain("Do not propose or perform file mutations.")
  })

  test("allows one read-only tool call and feeds only the result into the final summary", async () => {
    const toolCalls: Array<Call> = []
    const routerRequests: Array<Router.Request> = []
    let requestCount = 0
    const routerLayer = fakeRouterLayer((request) =>
      Effect.sync(() => {
        routerRequests.push(request)
        requestCount += 1
        if (requestCount === 1) {
          return response(JSON.stringify({ tool_call: { name: "read", input: { path: "README.md" } } }))
        }
        expect(request.messages.at(-1)?.role).toBe("tool")
        return response("Read README.md and found the setup notes.\n- README.md")
      }),
    )
    const toolLayer = ToolExecutor.fakeSubagentLayer(
      {
        read: (call) =>
          Effect.sync(() => {
            toolCalls.push(call)
            return { path: "README.md", content: "setup notes" }
          }),
      },
      [readTool],
    )

    const result = await Effect.runPromise(
      SubagentRuntime.runBatch({
        parent_thread_id: Ids.ThreadId.make("thread_parent"),
        parent_turn_id: Ids.TurnId.make("turn_parent"),
        agents: [{ name: "reader", prompt: "read setup", tool_names: ["read"], max_output_chars: 800 }],
      }).pipe(Effect.provide(makeLayer(routerLayer, toolLayer))),
    )

    expect(result.runs[0]).toMatchObject({
      name: "reader",
      status: "completed",
      evidence: ["README.md"],
      summary: expect.stringContaining("setup notes"),
    })
    expect(toolCalls[0]).toMatchObject({
      name: "read",
      metadata: {
        subagent_id: "subagent_1",
        subagent_name: "reader",
        parent_thread_id: "thread_parent",
        parent_turn_id: "turn_parent",
      },
    })
    expect(routerRequests.map((request) => Object.hasOwn(request, "max_output_tokens"))).toEqual([false, false])
    expect(routerRequests.map((request) => request.metadata)).toEqual([
      {
        subagent_id: "subagent_1",
        subagent_name: "reader",
        parent_thread_id: "thread_parent",
        parent_turn_id: "turn_parent",
      },
      {
        subagent_id: "subagent_1",
        subagent_name: "reader",
        parent_thread_id: "thread_parent",
        parent_turn_id: "turn_parent",
      },
    ])
  })

  test("returns cancelled summaries without invoking the model", async () => {
    let called = false
    const routerLayer = fakeRouterLayer(() =>
      Effect.sync(() => {
        called = true
        return response("should not run")
      }),
    )

    const result = await Effect.runPromise(
      SubagentRuntime.runBatch({ cancelled: true, agents: [{ name: "slow", prompt: "work" }] }).pipe(
        Effect.provide(makeLayer(routerLayer)),
      ),
    )

    expect(called).toBe(false)
    expect(result.runs[0]).toMatchObject({ name: "slow", status: "cancelled" })
  })
})

const fakeRouterLayer = (complete: (request: Router.Request) => Effect.Effect<Provider.GenerateResponse>) =>
  Layer.succeed(
    Router.Service,
    Router.Service.of({
      route: Effect.fn("SubagentRuntime.test.route")(function* (request: Router.Request) {
        return {
          mode: request.mode ?? "smart",
          provider: request.provider ?? "openai",
          model: request.model ?? "fake-model",
          messages: request.messages,
          reasoning_effort: request.reasoning_effort ?? "none",
        }
      }),
      complete: Effect.fn("SubagentRuntime.test.complete")(complete),
      completeStructured: () => Effect.die(new Error("structured completion not configured")),
      stream: (request: Router.Request) =>
        Stream.fromIterable(
          Provider.streamEventsFromResponse(response(providerMessageText(request.messages.at(-1)?.content ?? ""))),
        ),
    }),
  )

const response = (content: string): Provider.GenerateResponse => ({ provider: "openai", model: "fake-model", content })

const providerMessageText = (content: Provider.MessageContent): string =>
  typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")

const pathFromInput = (value: Common.JsonValue): string => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ""
  const path = Object.entries(value).find(([key]) => key === "path")?.[1]
  return typeof path === "string" ? path : ""
}
