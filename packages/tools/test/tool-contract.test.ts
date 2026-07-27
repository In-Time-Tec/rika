import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { AgentTools, Catalog, ParallelSearch, ProcessRegistry, Runtime, ThreadTools, ToolInvocation } from "../src"
import { provide } from "./test-layer"

describe("tool contracts", () => {
  it.effect("defines the model-facing Task spawn contract without model routing controls", () =>
    Effect.gen(function* () {
      const schema = Tool.getJsonSchema(AgentTools.taskTool)
      expect(AgentTools.taskTool.description).toContain(
        "Start a durable Task subagent for workspace investigation, codebase exploration, reproductions, or implementation",
      )
      expect(AgentTools.taskTool.description).toContain(
        "Returns immediately while the subagent runs in the background; collect its report with await_subagents.",
      )
      expect(AgentTools.taskTool.description).toContain("only a few subagents may run at a time")
      expect(AgentTools.oracleTool.description).toContain("already-gathered evidence")
      expect(AgentTools.oracleTool.description).toContain("do not use it for primary workspace or codebase exploration")
      expect(AgentTools.librarianTool.description).toContain(
        "substantive external documentation, repository, or codebase research",
      )
      expect(AgentTools.librarianTool.description).toContain("access-controlled GitHub-oriented")
      expect(AgentTools.librarianTool.description).toContain("public semantic-code searches")
      expect(schema).toMatchObject({
        properties: {
          prompt: { type: "string" },
        },
        required: ["prompt"],
      })
      expect(schema.properties).not.toHaveProperty("_batch")
      expect(schema.properties).not.toHaveProperty("model")
      expect(yield* Schema.decodeUnknownEffect(AgentTools.TaskInput)({ prompt: "List files" })).toEqual({
        prompt: "List files",
      })
    }),
  )

  it.effect("defines the model-facing subagent join contract", () =>
    Effect.gen(function* () {
      const schema = Tool.getJsonSchema(AgentTools.awaitSubagentsTool)
      expect(AgentTools.awaitSubagentsTool.name).toBe("await_subagents")
      expect(AgentTools.awaitSubagentsTool.description).toContain(
        "Collect the reports of subagents started earlier in this turn",
      )
      expect(AgentTools.awaitSubagentsTool.description).toContain(
        "You must collect every subagent you started before giving your final answer.",
      )
      expect(schema.required).toBeUndefined()
      expect(yield* Schema.decodeUnknownEffect(AgentTools.AwaitSubagentsInput)({})).toEqual({})
      expect(yield* Schema.decodeUnknownEffect(AgentTools.AwaitSubagentsInput)({ subagents: null })).toEqual({
        subagents: null,
      })
      expect(yield* Schema.decodeUnknownEffect(AgentTools.AwaitSubagentsInput)({ subagents: ["child-a"] })).toEqual({
        subagents: ["child-a"],
      })
    }),
  )

  it("reports a started subagent as a running handle instead of a verdict", () => {
    expect(AgentTools.spawned({ childExecutionId: "child:execution%3Aturn:call-1" })).toEqual({
      _tag: "Spawned",
      childExecutionId: "child:execution%3Aturn:call-1",
      status: "running",
      next: AgentTools.spawnedNext,
    })
  })

  it("defines permission and output policies for every initial tool", () => {
    expect(Catalog.definitions.length).toBeGreaterThanOrEqual(9)
    expect(Catalog.get("read")?.permission).toBe("allow")
    expect(Catalog.get("write")?.permission).toBe("allow")
    expect(Catalog.get("edit")?.permission).toBe("allow")
    expect(Catalog.get("oracle")?.permission).toBe("allow")
    expect(Catalog.get("librarian")?.permission).toBe("allow")
    expect(Catalog.get("review")?.permission).toBe("allow")
    expect(Catalog.get("task")?.permission).toBe("allow")
    expect(Catalog.get("missing")).toBeUndefined()
    expect(Catalog.definitions.every((definition) => definition.timeoutMillis > 0 && definition.outputLimit > 0)).toBe(
      true,
    )
    expect(Catalog.definitions.filter(({ idempotency }) => idempotency === "unsafe").map(({ name }) => name)).toEqual([
      "write",
      "edit",
      "bash",
      "task",
      "oracle",
      "librarian",
      "review",
      "surgeon",
      "read_thread",
      "await_subagents",
      "create_thread",
      "thread_interact",
    ])
  })

  it.effect("defines bounded public thread coordination contracts and policies", () =>
    Effect.gen(function* () {
      expect(Object.keys(ThreadTools.toolkit.tools)).toEqual(["search_threads", "read_thread_transcript"])
      expect(Object.keys(ThreadTools.findToolkit.tools)).toEqual(["find_thread"])
      expect(Object.keys(ThreadTools.coordinationToolkit.tools)).toEqual([
        "create_thread",
        "thread_interact",
        "wait_for_threads",
      ])
      expect(Object.keys(ThreadTools.publicToolkit.tools)).toEqual([
        "find_thread",
        "create_thread",
        "thread_interact",
        "wait_for_threads",
      ])
      expect(Object.keys(ThreadTools.allToolkit.tools)).toEqual([
        "search_threads",
        "read_thread_transcript",
        "find_thread",
        "create_thread",
        "thread_interact",
        "wait_for_threads",
      ])
      expect(
        yield* Schema.decodeUnknownEffect(ThreadTools.CreateThreadInput)({
          prompt: "Investigate",
          mode: "ultra",
          resultDelivery: "manual",
        }),
      ).toEqual({ prompt: "Investigate", mode: "ultra", resultDelivery: "manual" })
      yield* Effect.flip(Schema.decodeUnknownEffect(ThreadTools.CreateThreadInput)({ prompt: "x", mode: "max" }))
      yield* Effect.flip(Schema.decodeUnknownEffect(ThreadTools.CreateThreadInput)({ prompt: "😀".repeat(100_001) }))
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ThreadTools.ThreadInteractInput)({
          action: "status",
          message: "not valid for status",
        }),
      )
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ThreadTools.ThreadInteractInput)({ action: "steer", threadId: "thread-1" }),
      )
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ThreadTools.WaitForThreadsInput)({ targets: [], timeoutSeconds: 1 }),
      )
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ThreadTools.WaitForThreadsInput)({
          targets: Array.from({ length: 11 }, (_, index) => ({ threadId: `t-${index}`, turnId: `r-${index}` })),
        }),
      )
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ThreadTools.WaitForThreadsInput)({
          targets: [{ threadId: "t", turnId: "r" }],
          timeoutSeconds: 601,
        }),
      )
      expect(Catalog.get("find_thread")).toMatchObject({ productPermission: "thread.read", idempotency: "safe" })
      expect(Catalog.get("create_thread")).toMatchObject({
        productPermission: "thread.coordinate",
        idempotency: "unsafe",
      })
      expect(Catalog.get("thread_interact")?.permissionRules).toEqual([
        { actions: ["status", "preview_messages"], productPermission: "thread.read", idempotency: "safe" },
        { actions: ["message"], productPermission: "thread.coordinate", idempotency: "unsafe" },
        { actions: ["steer", "cancel", "stop"], productPermission: "thread.control", idempotency: "unsafe" },
      ])
      expect(Catalog.get("wait_for_threads")).toMatchObject({
        productPermission: "thread.read",
        idempotency: "safe",
        outputLimit: 40_000,
      })
      expect(ThreadTools.waitHandlerOutputBudget).toBe(36_000)
      expect(ThreadTools.findDefaultLimit).toBe(10)
      expect(ThreadTools.findMaximumLimit).toBe(50)
      expect(ThreadTools.previewDefaultLimit).toBe(10)
      expect(ThreadTools.previewMaximumLimit).toBe(20)
      yield* Effect.flip(Schema.decodeUnknownEffect(ThreadTools.FindThreadInput)({ query: "all", limit: 51 }))
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ThreadTools.ThreadInteractInput)({
          action: "preview_messages",
          threadId: "thread-1",
          limit: 21,
        }),
      )
      expect(
        yield* Schema.decodeUnknownEffect(ThreadTools.AcceptedSuccess)({
          schemaVersion: 2,
          threadId: "thread-1",
          turnId: "turn-1",
          resultDelivery: "reply",
          state: "awaiting-approval",
        }),
      ).toMatchObject({ schemaVersion: 2, state: "awaiting-approval" })
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ThreadTools.AcceptedSuccess)({
          schemaVersion: 2,
          threadId: "thread-1",
          turnId: "turn-1",
          resultDelivery: "reply",
          state: "stopped",
        }),
      )
    }),
  )

  it("builds the catalog from every registered built-in tool contract", () => {
    const tools = [
      ...Object.values(Runtime.toolkit.tools),
      ...Object.values(AgentTools.modelToolkit.tools),
      ...Object.values(AgentTools.joinToolkit.tools),
      ...Object.values(ThreadTools.allToolkit.tools),
    ]
    expect(Catalog.definitions.map(({ name, description }) => ({ name, description }))).toEqual(
      tools.map(({ name, description }) => ({ name, description })),
    )
  })

  it.effect("preserves Relay invocation time and derives one absolute deadline", () =>
    Effect.gen(function* () {
      const invocation = yield* Schema.decodeUnknownEffect(ToolInvocation.ValueSchema)({
        executionId: "execution-1",
        callId: "call-1",
        toolName: "wait_for_threads",
        eventSequence: 12,
        createdAt: 1_721_234_567_890.5,
        idempotencyKeyDigest: "digest",
      })
      expect(invocation.createdAt).toBe(1_721_234_567_890.5)
      expect(ToolInvocation.absoluteDeadline(invocation.createdAt, 600_000)).toBe(1_721_235_167_890.5)
      expect(() => ToolInvocation.absoluteDeadline(invocation.createdAt, -1)).toThrow("Invalid tool deadline")
    }),
  )

  it("rejects duplicated tools and incomplete registration", () => {
    const registration = Runtime.registrations.find(({ tool }) => tool.name === "read")!
    expect(() =>
      Catalog.makeDefinitions(
        [
          { name: "read", description: "one" },
          { name: "read", description: "two" },
        ],
        [registration],
      ),
    ).toThrow("duplicate tools: read")
    expect(() =>
      Catalog.makeDefinitions(
        [{ name: "read", description: "read" }],
        [{ ...registration, tool: { name: "write", description: "write" } }],
      ),
    ).toThrow("tools without registration: read; registrations without tool: write")
  })

  it.effect("rejects invalid bounds while preserving file ranges for typed runtime failures", () =>
    Effect.gen(function* () {
      const definition = Catalog.get("read")!
      yield* Effect.flip(Schema.decodeUnknownEffect(Catalog.Definition)({ ...definition, timeoutMillis: 0 }))
      yield* Effect.flip(Schema.decodeUnknownEffect(Catalog.Definition)({ ...definition, outputLimit: 1.5 }))
      expect(
        yield* Schema.decodeUnknownEffect(Runtime.Request)({ _tag: "Read", path: "a", readRange: [-1, 0] }),
      ).toEqual({ _tag: "Read", path: "a", readRange: [-1, 0] })
      yield* Effect.flip(
        Schema.decodeUnknownEffect(Runtime.Request)({
          _tag: "Read",
          path: "a",
          readRange: [1, Number.POSITIVE_INFINITY],
        }),
      )
      yield* Effect.flip(
        Schema.decodeUnknownEffect(Runtime.Request)({ _tag: "Bash", command: "echo", timeoutMillis: 0.5 }),
      )
      yield* Effect.flip(Schema.decodeUnknownEffect(ThreadTools.FindThreadInput)({ query: "all", limit: 0 }))
    }),
  )

  it.effect("round-trips canonical typed failures and rejects incomplete failure results", () =>
    Effect.gen(function* () {
      const failure = Runtime.ToolError.make({
        tool: "read",
        message: "missing",
        kind: "operation",
        category: "not_found",
        outcome: "known",
        recovery: "after_change",
        nextAction: "Correct the path",
      })
      expect(yield* Schema.decodeUnknownEffect(Runtime.ToolError)(failure)).toEqual(failure)
      yield* Effect.flip(
        Schema.decodeUnknownEffect(Runtime.ToolError)({ _tag: "ToolError", tool: "read", message: "missing" }),
      )
    }),
  )

  it("defines an Amp presentation for every built-in tool", () => {
    expect(Catalog.definitions.every((definition) => definition.presentation !== undefined)).toBe(true)
    expect(Catalog.get("edit")?.presentation).toMatchObject({ family: "edit" })
    expect(Catalog.get("read")?.presentation).toMatchObject({ family: "explore", action: "read" })
    expect(Catalog.get("shell_command_status")?.presentation).toMatchObject({ family: "direct", action: "status" })
    expect(Catalog.get("web_search")?.presentation).toMatchObject({
      family: "direct",
      action: "web-search",
      outputDisplay: "hidden",
    })
    expect(Catalog.get("read_web_page")?.presentation).toMatchObject({
      family: "direct",
      action: "read-web-page",
      outputDisplay: "hidden",
    })
    expect(Catalog.get("search_threads")?.presentation).toMatchObject({
      family: "explore",
      activeLabel: "Exploring",
      completeLabel: "Explored",
    })
    expect(Catalog.get("read_thread_transcript")?.presentation).toMatchObject({
      family: "direct",
      activeLabel: "Reading Thread",
      completeLabel: "Read Thread",
    })
    expect(Catalog.get("oracle")?.presentation).toMatchObject({
      family: "agent",
      activeLabel: "Oracle exploring",
      completeLabel: "Oracle has spoken",
    })
  })

  it("names Amp-compatible dynamic tools and subagents", () => {
    expect(
      [
        "Read",
        "Grep",
        "glob",
        "Bash",
        "shell_command",
        "run_terminal_command",
        "write_file",
        "finder",
        "review",
        "transfer_to_oracle",
        "transfer_to_librarian",
        "spawn_child_run",
        "skill",
        "list_agent_modes",
        "load_plugin",
        "archive_current_thread",
        "create_thread",
        "send_message_to_thread",
        "send_message_to_puck",
        "slack_read",
        "slack_write",
      ].map((name) => [name, Catalog.resolvePresentation(name).completeLabel]),
    ).toEqual([
      ["Read", "Explored"],
      ["Grep", "Explored"],
      ["glob", "Explored"],
      ["Bash", "Ran"],
      ["shell_command", "Ran"],
      ["run_terminal_command", "Ran"],
      ["write_file", "Created"],
      ["finder", "Searched codebase"],
      ["review", "Reviewed code"],
      ["transfer_to_oracle", "Oracle has spoken"],
      ["transfer_to_librarian", "Librarian researched"],
      ["spawn_child_run", "Subagent finished"],
      ["skill", "Explored"],
      ["list_agent_modes", "Checked available agent modes"],
      ["load_plugin", "Loaded plugin"],
      ["archive_current_thread", "Archived this thread"],
      ["create_thread", "Created thread"],
      ["send_message_to_thread", "Sent message to thread"],
      ["send_message_to_puck", "Sent message to Puck"],
      ["slack_read", "Slack"],
      ["slack_write", "Slack"],
    ])
  })

  it("labels handoff spawns without a parenthesized profile from the first resolution", () => {
    const task = Catalog.resolvePresentation("transfer_to_task")
    expect(task.activeLabel).toBe("Subagent working")
    expect(task.completeLabel).toBe("Subagent finished")
    const planner = Catalog.resolvePresentation("transfer_to_planner")
    expect(planner.activeLabel).toBe("Planner working")
    expect(planner.completeLabel).toBe("Planner finished")
    for (const label of [task.activeLabel, task.completeLabel, planner.activeLabel, planner.completeLabel])
      expect(label).not.toContain("(")
  })

  it.effect("substitutes the runtime through its test layer", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* runtime.run({ _tag: "Bash", command: "fixture" })
      expect(result).toEqual({ text: "fixture", truncated: false })
    }).pipe(provide(Runtime.testLayer(() => Effect.succeed({ text: "fixture", truncated: false })))),
  )

  it.effect("substitutes the process registry through its test layer", () =>
    Effect.gen(function* () {
      const registry = yield* ProcessRegistry.Service
      expect(yield* registry.start("command", [], "/workspace")).toBe("fixture")
    }).pipe(
      provide(
        ProcessRegistry.testLayer({
          start: () => Effect.succeed("fixture"),
          poll: () => Effect.die("unused"),
          cancel: () => Effect.die("unused"),
        }),
      ),
    ),
  )

  it.effect("requires a meaningful web search objective and homogeneous non-empty queries", () =>
    Effect.gen(function* () {
      const schema = Tool.getJsonSchema(Runtime.webSearchTool)
      expect(schema.required).toContain("objective")
      const searchQueries = (schema.properties as Record<string, unknown>).searchQueries
      expect(searchQueries).toEqual({
        type: "array",
        items: { type: "string" },
        allOf: [{ minItems: 1 }],
      })
      expect(searchQueries).not.toHaveProperty("prefixItems")
      expect(schema.properties).not.toHaveProperty("providers")
      expect(Runtime.webSearchTool.description).toContain("code for public semantic implementation examples")
      expect(Runtime.webSearchTool.description).toContain("github through the configured GitHub search provider")
      expect(Runtime.webSearchTool.description).not.toContain("capability, not a particular provider")
      expect(yield* Schema.decodeUnknownEffect(ParallelSearch.SearchQueries)(["current docs"])).toEqual([
        "current docs",
      ])
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ParallelSearch.SearchInput)({ objective: "", searchQueries: ["docs"] }),
      )
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ParallelSearch.SearchInput)({ objective: "   ", searchQueries: ["docs"] }),
      )
      yield* Effect.flip(Schema.decodeUnknownEffect(ParallelSearch.SearchQueries)([]))
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ParallelSearch.SearchQueries)({ 0: "current docs", __rest__: ["api"] }),
      )
    }),
  )

  it("registers the migrated core model-facing tool names", () => {
    expect(Object.keys(Runtime.toolkit.tools)).toEqual(expect.arrayContaining(["read", "write", "edit", "bash"]))
    expect(
      ["read_file", "create_file", "edit_file", "shell", "apply_patch"].filter((name) => name in Runtime.toolkit.tools),
    ).toEqual([])
  })

  it("uses Amp-compatible core tool inputs under Rika's lowercase names", () => {
    expect(Tool.getJsonSchema(Runtime.readTool)).toMatchObject({
      properties: {
        path: { type: "string" },
        read_range: { type: "array", allOf: [{ minItems: 2 }, { maxItems: 2 }] },
      },
      required: ["path"],
    })
    expect(Tool.getJsonSchema(Runtime.writeTool)).toMatchObject({
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    })
    expect(Tool.getJsonSchema(Runtime.editTool)).toMatchObject({
      properties: {
        path: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_str", "new_str"],
    })
    expect(Tool.getJsonSchema(Runtime.bashTool)).toMatchObject({
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
        timeout_ms: { type: "integer" },
      },
      required: ["command"],
    })
  })
})
