import { Agent, type ModelRegistry } from "@batonfx/core"
import { Runtime as Tools } from "@rika/tools"
import { Effect, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"

export const names = ["Oracle", "Librarian", "Painter", "Review", "ReadThread", "Task"] as const
export type Name = (typeof names)[number]

export class PainterUnavailableError extends Schema.TaggedErrorClass<PainterUnavailableError>()(
  "PainterUnavailableError",
  { message: Schema.String, provider: Schema.String, model: Schema.String },
) {}

export const outputSchemas = {
  Oracle: Schema.Struct({ answer: Schema.String, evidence: Schema.Array(Schema.String) }),
  Librarian: Schema.Struct({ answer: Schema.String, sources: Schema.Array(Schema.String) }),
  Painter: Schema.Struct({
    text: Schema.String,
    artifact: Schema.Struct({ path: Schema.String, mimeType: Schema.String, kind: Schema.String }),
  }),
  Review: Schema.Struct({
    summary: Schema.String,
    findings: Schema.Array(
      Schema.Struct({ severity: Schema.String, message: Schema.String, path: Schema.optionalKey(Schema.String) }),
    ),
  }),
  ReadThread: Schema.Struct({ answer: Schema.String, threadIds: Schema.Array(Schema.String) }),
  Task: Schema.Struct({ summary: Schema.String, files: Schema.Array(Schema.String) }),
} as const

const definitions = {
  Oracle: {
    instructions: "Answer a focused technical question using read-only workspace evidence. Do not modify files.",
    tools: [Tools.findFilesTool, Tools.grepTool, Tools.readFileTool],
    permissions: ["workspace.read"],
    schema: "rika.agent.oracle.v1",
  },
  Librarian: {
    instructions: "Research current authoritative sources and return cited findings. Do not modify files.",
    tools: [Tools.webSearchTool, Tools.readWebPageTool],
    permissions: ["network.read"],
    schema: "rika.agent.librarian.v1",
  },
  Painter: {
    instructions:
      "Produce a requested visual artifact through the available media route and report its metadata. Do not modify source files.",
    tools: [Tools.viewMediaTool],
    permissions: ["workspace.read"],
    schema: "rika.agent.painter.v1",
  },
  Review: {
    instructions: "Review workspace changes for correctness, regressions, and missing tests. Do not modify files.",
    tools: [Tools.grepTool, Tools.readFileTool, Tools.gitStatusTool],
    permissions: ["workspace.read"],
    schema: "rika.agent.review.v1",
  },
  ReadThread: {
    instructions: "Answer only from local thread transcripts and identify the threads used.",
    tools: [],
    permissions: ["thread.read"],
    schema: "rika.agent.read-thread.v1",
  },
  Task: {
    instructions:
      "Complete the assigned implementation task in the workspace and report changed files and verification.",
    tools: [
      Tools.findFilesTool,
      Tools.grepTool,
      Tools.readFileTool,
      Tools.createFileTool,
      Tools.editFileTool,
      Tools.shellTool,
    ],
    permissions: ["workspace.read", "workspace.write", "process.run"],
    schema: "rika.agent.task.v1",
  },
} as const

export const resolve = (name: Name, model: ModelRegistry.ModelSelection) => {
  const definition = definitions[name]
  const toolkit = Toolkit.make(...definition.tools)
  return {
    name,
    agent: Agent.make(`rika-${name.toLowerCase()}`, { instructions: definition.instructions, model, toolkit }),
    preset: {
      instructions: definition.instructions,
      model,
      tool_names: Object.keys(toolkit.tools),
      permissions: [...definition.permissions],
      output_schema_ref: definition.schema,
      metadata: { product_profile: name },
    },
    outputSchema: outputSchemas[name],
  }
}

export const resolvePainter = Effect.fn("AgentProfiles.resolvePainter")(function* (
  model: ModelRegistry.ModelSelection,
  mediaAvailable: boolean,
) {
  if (!mediaAvailable) {
    return yield* Effect.fail(
      new PainterUnavailableError({
        message: "The configured model route does not provide the required media capability",
        provider: model.provider,
        model: model.model,
      }),
    )
  }
  return resolve("Painter", model)
})

export const presets = (model: ModelRegistry.ModelSelection, oracleModel: ModelRegistry.ModelSelection = model) =>
  Object.fromEntries(names.map((name) => [name, resolve(name, name === "Oracle" ? oracleModel : model).preset]))

export const parentPermissions = [...new Set(names.flatMap((name) => definitions[name].permissions))].map((name) => ({
  name,
  value: true,
}))

export const childRunSpawnPermission = { name: "relay.child_run.spawn", value: true }

export const outputSchemaRegistrations = names.map((name) => ({
  ref: definitions[name].schema,
  schema: outputSchemas[name],
}))

export const subagentHandoffTargets = [
  { name: "oracle", preset_name: "Oracle" },
  { name: "librarian", preset_name: "Librarian" },
  { name: "review", preset_name: "Review" },
  { name: "read_thread", preset_name: "ReadThread" },
  { name: "task", preset_name: "Task" },
] as const
