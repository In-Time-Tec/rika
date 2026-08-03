import * as ThreadToolkits from "@rika/coding-tools/thread-tool-contract"
import { expect, test } from "vitest"
import { Tool } from "effect/unstable/ai"
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput"
import { toolkitFor } from "../../../src/model/routing/relay-model-tools"

const productionToolkit = toolkitFor({ additionalToolkit: ThreadToolkits.ThreadContract.allToolkit })

const expectedToolNames = [
  "grep",
  "read",
  "write",
  "edit",
  "bash",
  "shell_command_status",
  "web_search",
  "read_web_page",
  "view_media",
  "task",
  "oracle",
  "librarian",
  "review",
  "surgeon",
  "read_thread",
  "await_subagents",
  "search_threads",
  "read_thread_transcript",
  "find_thread",
  "create_thread",
  "thread_interact",
  "wait_for_threads",
]

const strictSchemaProblems = (schema: unknown): ReadonlyArray<string> => {
  const problems = new Array<string>()
  const visit = (value: unknown, path: string) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return
    const node = value as Record<string, unknown>
    if (node.type === "object") {
      if (node.additionalProperties !== false) problems.push(`${path} must set additionalProperties to false`)
      if (node.properties === null || typeof node.properties !== "object" || Array.isArray(node.properties)) {
        problems.push(`${path} must define object properties`)
      } else {
        const propertyNames = Object.keys(node.properties)
        const required = Array.isArray(node.required) ? node.required : []
        if (required.length !== propertyNames.length || propertyNames.some((name) => !required.includes(name)))
          problems.push(`${path} must require every property`)
        for (const [name, property] of Object.entries(node.properties)) visit(property, `${path}.properties.${name}`)
      }
    }
    if (node.type === "array") visit(node.items, `${path}.items`)
    if (Array.isArray(node.anyOf))
      for (const [index, member] of node.anyOf.entries()) visit(member, `${path}.anyOf.${index}`)
  }
  if (
    schema === null ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>).type !== "object"
  )
    problems.push("$ must have type object")
  visit(schema, "$")
  return problems
}

test("every production tool has an OpenAI strict object-root input schema", () => {
  const tools = Object.values(productionToolkit.tools)
  expect(tools.map((tool) => tool.name)).toEqual(expectedToolNames)
  for (const tool of tools) {
    const schema = Tool.getJsonSchema(tool, { transformer: toCodecOpenAI })
    expect(strictSchemaProblems(schema), tool.name).toEqual([])
  }
})
