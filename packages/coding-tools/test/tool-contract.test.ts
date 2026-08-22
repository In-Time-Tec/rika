import { contractFixtures } from "./tool-contract-support"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import { provide } from "./test-layer"

describe("tool contracts", () => {
  it("defines execution and output policies for every initial tool", () => {
    expect(Catalog.definitions.length).toBeGreaterThanOrEqual(9)
    expect(Catalog.get("missing")).toBeUndefined()
    expect(Catalog.definitions.every((definition) => definition.timeoutMillis > 0 && definition.outputLimit > 0)).toBe(
      true,
    )
    expect(Catalog.definitions.filter(({ idempotency }) => idempotency === "unsafe").map(({ name }) => name)).toEqual([
      "write",
      "edit",
      "bash",
    ])
  })

  it.effect("defines bounded read-only Thread contracts and policies", () =>
    Effect.gen(function* () {
      expect(Object.keys(contractFixtures.ThreadToolkits.toolkit.tools)).toEqual([
        "search_threads",
        "read_thread_transcript",
      ])
      expect(Object.keys(contractFixtures.ThreadToolkits.findToolkit.tools)).toEqual(["find_thread"])
      expect(Object.keys(contractFixtures.ThreadToolkits.publicToolkit.tools)).toEqual(["find_thread"])
      expect(Object.keys(contractFixtures.ThreadToolkits.allToolkit.tools)).toEqual([
        "search_threads",
        "read_thread_transcript",
        "find_thread",
      ])
      expect(Catalog.get("find_thread")).toMatchObject({ idempotency: "safe" })
      expect(contractFixtures.ThreadFind.findDefaultLimit).toBe(10)
      expect(contractFixtures.ThreadFind.findMaximumLimit).toBe(50)
      expect(contractFixtures.ThreadFind.previewDefaultLimit).toBe(10)
      expect(contractFixtures.ThreadFind.previewMaximumLimit).toBe(20)
      yield* Effect.flip(
        Schema.decodeUnknownEffect(contractFixtures.ThreadFind.FindThreadInput)({ query: "all", limit: 51 }),
      )
    }),
  )

  it("builds the catalog from every registered built-in tool contract", () => {
    const tools = [
      ...Object.values(contractFixtures.RuntimeTools.toolkit.tools),
      ...Object.values(contractFixtures.ThreadToolkits.allToolkit.tools),
    ]
    expect(Catalog.definitions.map(({ name, description }) => ({ name, description }))).toEqual(
      tools.map(({ name, description }) => ({ name, description })),
    )
  })

  it("rejects duplicated tools and incomplete registration", () => {
    const registration = contractFixtures.RuntimeTools.registrations.find(({ tool }) => tool.name === "read")!
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
        yield* Schema.decodeUnknownEffect(contractFixtures.RuntimeContract.Request)({
          _tag: "Read",
          path: "a",
          readRange: [-1, 0],
        }),
      ).toEqual({ _tag: "Read", path: "a", readRange: [-1, 0] })
      yield* Effect.flip(
        Schema.decodeUnknownEffect(contractFixtures.RuntimeContract.Request)({
          _tag: "Read",
          path: "a",
          readRange: [1, Number.POSITIVE_INFINITY],
        }),
      )
      yield* Effect.flip(
        Schema.decodeUnknownEffect(contractFixtures.RuntimeContract.Request)({
          _tag: "Bash",
          command: "echo",
          timeoutMillis: 0.5,
        }),
      )
      yield* Effect.flip(
        Schema.decodeUnknownEffect(contractFixtures.ThreadFind.FindThreadInput)({ query: "all", limit: 0 }),
      )
    }),
  )

  it.effect("round-trips canonical typed failures and rejects incomplete failure results", () =>
    Effect.gen(function* () {
      const failure = contractFixtures.RuntimeContract.ToolError.make({
        tool: "read",
        message: "missing",
        kind: "operation",
        category: "not_found",
        outcome: "known",
        recovery: "after_change",
        nextAction: "Correct the path",
      })
      expect(yield* Schema.decodeUnknownEffect(contractFixtures.RuntimeContract.ToolError)(failure)).toEqual(failure)
      yield* Effect.flip(
        Schema.decodeUnknownEffect(contractFixtures.RuntimeContract.ToolError)({
          _tag: "ToolError",
          tool: "read",
          message: "missing",
        }),
      )
    }),
  )

  it("defines an Amp presentation for every built-in tool", () => {
    expect(Catalog.definitions.every((definition) => definition.presentation !== undefined)).toBe(true)
    expect(Catalog.get("edit")?.presentation).toMatchObject({ family: "edit" })
    expect(Catalog.get("read")?.presentation).toMatchObject({ family: "explore", action: "read" })
    expect(Catalog.get("shell_command_status")?.presentation).toMatchObject({
      family: "direct",
      action: "status",
      rowDisplay: "continuation",
      failedLabel: "Command wait failed",
    })
    expect(Catalog.get("web_search")?.presentation).toMatchObject({
      family: "direct",
      action: "web-search",
      outputDisplay: "expandable",
    })
    expect(Catalog.get("read_web_page")?.presentation).toMatchObject({
      family: "direct",
      action: "read-web-page",
      outputDisplay: "expandable",
    })
    expect(Catalog.get("read_web_page")?.description).toContain("file:// URLs are unsupported")
    expect(Catalog.get("read_web_page")?.description).toContain("rika.workspace.read")
    expect(Catalog.get("read_web_page")?.description).toContain("local-capable child")
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
    expect(Catalog.resolveAgentPresentation("Oracle")).toMatchObject({
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
        "skill",
        "list_agent_modes",
        "load_plugin",
        "archive_current_thread",
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
      ["skill", "Explored"],
      ["list_agent_modes", "Checked available agent modes"],
      ["load_plugin", "Loaded plugin"],
      ["archive_current_thread", "Archived this thread"],
      ["send_message_to_thread", "Sent message to thread"],
      ["send_message_to_puck", "Sent message to Puck"],
      ["slack_read", "Slack"],
      ["slack_write", "Slack"],
    ])
  })

  it.effect("substitutes the runtime through its test layer", () =>
    Effect.gen(function* () {
      const runtime = yield* contractFixtures.Runtime.Service
      const result = yield* runtime.run({ _tag: "Bash", command: "fixture" })
      expect(result).toEqual({ text: "fixture", truncated: false })
    }).pipe(provide(contractFixtures.Runtime.testLayer(() => Effect.succeed({ text: "fixture", truncated: false })))),
  )

  it.effect("substitutes the process registry through its test layer", () =>
    Effect.gen(function* () {
      const registry = yield* contractFixtures.ProcessRegistry.Service
      expect(yield* registry.start("command", [], "/workspace")).toBe("fixture")
    }).pipe(
      provide(
        contractFixtures.ProcessRegistry.testLayer({
          start: () => Effect.succeed("fixture"),
          poll: () => Effect.die("unused"),
          cancel: () => Effect.die("unused"),
        }),
      ),
    ),
  )

  it.effect("requires a meaningful web search objective and homogeneous non-empty queries", () =>
    Effect.gen(function* () {
      const schema = Tool.getJsonSchema(contractFixtures.RuntimeServiceTools.webSearchTool)
      expect(schema.required).toContain("objective")
      const searchQueries = (schema.properties as Record<string, unknown>).searchQueries
      expect(searchQueries).toEqual({
        type: "array",
        items: { type: "string", pattern: "\\S" },
        minItems: 1,
      })
      expect(searchQueries).not.toHaveProperty("prefixItems")
      expect(schema.properties).not.toHaveProperty("providers")
      expect(contractFixtures.RuntimeServiceTools.webSearchTool.description).toContain(
        "code for public semantic implementation examples",
      )
      expect(contractFixtures.RuntimeServiceTools.webSearchTool.description).toContain(
        "github through the configured GitHub search provider",
      )
      expect(contractFixtures.RuntimeServiceTools.webSearchTool.description).not.toContain(
        "capability, not a particular provider",
      )
      expect(
        yield* Schema.decodeUnknownEffect(contractFixtures.WebSearchInputContract.SearchQueries)(["current docs"]),
      ).toEqual(["current docs"])
      yield* Effect.flip(
        Schema.decodeUnknownEffect(contractFixtures.WebSearchRequestContract.SearchInput)({
          objective: "",
          searchQueries: ["docs"],
        }),
      )
      yield* Effect.flip(
        Schema.decodeUnknownEffect(contractFixtures.WebSearchRequestContract.SearchInput)({
          objective: "   ",
          searchQueries: ["docs"],
        }),
      )
      yield* Effect.flip(Schema.decodeUnknownEffect(contractFixtures.WebSearchInputContract.SearchQueries)([]))
      yield* Effect.flip(
        Schema.decodeUnknownEffect(contractFixtures.WebSearchInputContract.SearchQueries)({
          0: "current docs",
          __rest__: ["api"],
        }),
      )
    }),
  )

  it("registers the migrated core model-facing tool names", () => {
    expect(Object.keys(contractFixtures.RuntimeTools.toolkit.tools)).toEqual(
      expect.arrayContaining(["read", "write", "edit", "bash"]),
    )
    expect(
      ["read_file", "create_file", "edit_file", "shell", "apply_patch"].filter(
        (name) => name in contractFixtures.RuntimeTools.toolkit.tools,
      ),
    ).toEqual([])
  })

  it("uses Amp-compatible core tool inputs under Rika's lowercase names", () => {
    expect(Tool.getJsonSchema(contractFixtures.RuntimeCoreTools.readTool)).toMatchObject({
      properties: {
        path: { type: "string" },
        read_range: { type: "array", allOf: [{ minItems: 2 }, { maxItems: 2 }] },
      },
      required: ["path"],
    })
    expect(Tool.getJsonSchema(contractFixtures.RuntimeCoreTools.writeTool)).toMatchObject({
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    })
    expect(Tool.getJsonSchema(contractFixtures.RuntimeCoreTools.editTool)).toMatchObject({
      properties: {
        path: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_str", "new_str"],
    })
    expect(Tool.getJsonSchema(contractFixtures.RuntimeCoreTools.bashTool)).toMatchObject({
      properties: {
        command: { type: "string" },
        workdir: { type: "string" },
        timeout_ms: { type: "integer" },
      },
      required: ["command"],
    })
  })
})
