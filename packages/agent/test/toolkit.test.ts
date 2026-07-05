import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput"
import { Toolkit, ToolRegistry } from "../src/index"

describe("Toolkit", () => {
  test("registered shell tool emits an OpenAI strict object schema", () => {
    const definition = ToolRegistry.shellDefinitions("/workspace")[0]
    if (definition === undefined) throw new Error("shell tool was not registered")

    const schema = Tool.getJsonSchema(definition.tool, { transformer: toCodecOpenAI })

    expect(definition.tool.name).toBe("shell_command")
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { anyOf: [{ type: "integer" }, { type: "null" }] },
        max_output_bytes: { anyOf: [{ type: "integer" }, { type: "null" }] },
      },
      required: ["command", "timeout_ms", "max_output_bytes"],
      additionalProperties: false,
    })
  })

  test("empty-parameter tools use Effect Tool.EmptyParams", () => {
    const tool = Tool.make("semantic_search_status", {
      description: "Report semantic search status.",
      parameters: Tool.EmptyParams,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })

    expect(Tool.getJsonSchema(tool, { transformer: toCodecOpenAI })).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    })
  })

  test("prepared toolkits expose schemas but fail loudly if provider-side handlers run", async () => {
    const tool = Tool.make("manual_only", {
      description: "Manual-only tool",
      parameters: Schema.Struct({ text: Schema.String }),
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    })
    const prepared = Toolkit.prepare([tool])
    const withHandlers = Effect.isEffect(prepared.toolkit)
      ? await Effect.runPromise(prepared.toolkit)
      : prepared.toolkit
    const error = await Effect.runPromise(withHandlers.handle("manual_only", { text: "hello" }).pipe(Effect.flip))

    expect(Object.keys(withHandlers.tools)).toEqual(["manual_only"])
    expect(error.message).toContain("Rika resolves model tool calls manually")
    expect(error.reason._tag).toBe("ToolConfigurationError")
  })
})
