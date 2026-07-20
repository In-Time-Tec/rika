import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { AgentTools, Catalog, ParallelSearch, ProcessRegistry, Runtime, ThreadTools } from "../src"
import { provide } from "./test-layer"

describe("tool contracts", () => {
  it.effect("defines the model-facing Task spawn contract and rejects unknown model variants", () =>
    Effect.gen(function* () {
      const schema = Tool.getJsonSchema(AgentTools.taskTool)
      expect(AgentTools.taskTool.description).toContain(
        "Independent explorations SHOULD be parallel spawn calls in one turn.",
      )
      expect(AgentTools.taskTool.description).toContain("Omit model to inherit the parent model and effort.")
      expect(AgentTools.taskTool.description).toContain(AgentTools.modelGuidance)
      expect(schema).toMatchObject({
        properties: {
          prompt: { type: "string" },
          model: { enum: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] },
        },
        required: ["prompt"],
      })
      expect(schema.properties).not.toHaveProperty("_batch")
      expect(
        yield* Schema.decodeUnknownEffect(AgentTools.TaskInput)({ prompt: "List files", model: "gpt-5.6-luna" }),
      ).toEqual({ prompt: "List files", model: "gpt-5.6-luna" })
      const invalid = yield* Effect.flip(
        Schema.decodeUnknownEffect(AgentTools.TaskInput)({ prompt: "List files", model: "gpt-5.6-unknown" }),
      )
      expect(String(invalid)).toContain("gpt-5.6-unknown")
    }),
  )

  it("defines permission and output policies for every initial tool", () => {
    expect(Catalog.definitions.length).toBeGreaterThanOrEqual(9)
    expect(Catalog.get("read")?.permission).toBe("allow")
    expect(Catalog.get("write")?.permission).toBe("allow")
    expect(Catalog.get("edit")?.permission).toBe("allow")
    expect(Catalog.get("oracle")?.permission).toBe("allow")
    expect(Catalog.get("librarian")?.permission).toBe("allow")
    expect(Catalog.get("painter")?.permission).toBe("allow")
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
      "oracle",
      "librarian",
      "review",
      "painter",
      "task",
    ])
  })

  it("keeps the static catalog aligned with every registered built-in runtime tool", () => {
    const runtimeNames = [
      ...Object.keys(Runtime.toolkit.tools),
      ...Object.keys(AgentTools.modelToolkit.tools),
      ...Object.keys(ThreadTools.toolkit.tools),
    ]
    const catalogNames = Catalog.definitions.map(({ name }) => name)
    expect(new Set(catalogNames).size).toBe(catalogNames.length)
    expect(catalogNames).toEqual(expect.arrayContaining(runtimeNames))
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
        outcome: "known",
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
    expect(Catalog.get("find_thread")?.presentation).toMatchObject({
      family: "explore",
      activeLabel: "Exploring",
      completeLabel: "Explored",
    })
    expect(Catalog.get("read_thread")?.presentation).toMatchObject({
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
      const result = yield* runtime.run({ _tag: "GitStatus" })
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
