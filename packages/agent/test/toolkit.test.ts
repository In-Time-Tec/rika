import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput"
import { ToolRegistry } from "../src/index"

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
})
