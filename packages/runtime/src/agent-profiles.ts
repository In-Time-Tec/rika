import { Agent, type ModelRegistry, TurnPolicy } from "@batonfx/core"
import { AgentTools, Runtime as Tools, ThreadTools } from "@rika/tools"
import { Effect, Function, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"
import librarianPrompt from "./prompts/librarian.prompt.txt"
import oraclePrompt from "./prompts/oracle.prompt.txt"
import painterPrompt from "./prompts/painter.prompt.txt"
import readThreadPrompt from "./prompts/read-thread.prompt.txt"
import reviewPrompt from "./prompts/review.prompt.txt"
import rootPrompt from "./prompts/root.prompt.txt"
import taskPrompt from "./prompts/task.prompt.txt"
import titlePrompt from "./prompts/title.prompt.txt"

export const names = ["Oracle", "Librarian", "Painter", "Review", "ReadThread", "Task"] as const
export type Name = (typeof names)[number]

export class PainterUnavailableError extends Schema.TaggedErrorClass<PainterUnavailableError>()(
  "PainterUnavailableError",
  { message: Schema.String, provider: Schema.String, model: Schema.String },
) {}

const instructions = (name: string, prompt: string) => {
  const normalized = prompt.trim()
  if (normalized.length === 0) throw new Error(`Built-in ${name} prompt is empty`)
  return normalized
}

export const mainInstructions = instructions("root", rootPrompt)
export const titleInstructions = instructions("Title", titlePrompt)

export const resolveTitle = (model: ModelRegistry.ModelSelection) => ({
  instructions: titleInstructions,
  model: {
    provider: model.provider,
    model: model.model,
    ...(model.registrationKey === undefined ? {} : { registration_key: model.registrationKey }),
  },
  tool_names: [] as ReadonlyArray<string>,
  permissions: [] as ReadonlyArray<string>,
  metadata: { product_profile: "Title" },
})

const definitions = {
  Oracle: {
    instructions: instructions("Oracle", oraclePrompt),
    tools: [Tools.grepTool, Tools.readTool, Tools.webSearchTool],
    permissions: ["workspace.read", "network.read", "thread.read"],
  },
  Librarian: {
    instructions: instructions("Librarian", librarianPrompt),
    tools: [Tools.webSearchTool, Tools.readWebPageTool],
    permissions: ["network.read", "thread.read"],
  },
  Painter: {
    instructions: instructions("Painter", painterPrompt),
    tools: [Tools.viewMediaTool],
    permissions: ["workspace.read", "thread.read"],
  },
  Review: {
    instructions: instructions("Review", reviewPrompt),
    tools: [Tools.grepTool, Tools.readTool, Tools.webSearchTool],
    permissions: ["workspace.read", "network.read", "thread.read"],
  },
  ReadThread: {
    instructions: instructions("ReadThread", readThreadPrompt),
    tools: [ThreadTools.searchThreadsTool, ThreadTools.readThreadTranscriptTool],
    permissions: ["thread.read"],
  },
  Task: {
    instructions: instructions("Task", taskPrompt),
    tools: [
      Tools.grepTool,
      Tools.readTool,
      Tools.writeTool,
      Tools.editTool,
      Tools.bashTool,
      Tools.shellCommandStatusTool,
      Tools.webSearchTool,
    ],
    permissions: ["workspace.read", "workspace.write", "process.run", "network.read", "thread.read"],
  },
} as const

const resolveImpl = (name: Name, model: ModelRegistry.ModelSelection) => {
  const definition = definitions[name]
  const delegationTools = (() => {
    if (name === "ReadThread") return []
    if (name === "Oracle" || name === "Review") return [AgentTools.readThreadTool]
    return Object.values(AgentTools.modelToolkit.tools)
  })()
  const recoveryTools =
    name === "ReadThread" ? [] : [ThreadTools.searchThreadsTool, ThreadTools.readThreadTranscriptTool]
  const toolkit = Toolkit.make(...definition.tools, ...delegationTools, ...recoveryTools)
  const relayModel = {
    provider: model.provider,
    model: model.model,
    ...(model.registrationKey === undefined ? {} : { registration_key: model.registrationKey }),
  }
  return {
    name,
    agent: Agent.make({
      name: `rika-${name.toLowerCase()}`,
      instructions: definition.instructions,
      model,
      toolkit,
      policy: TurnPolicy.forever,
    }),
    preset: {
      instructions: definition.instructions,
      model: relayModel,
      tool_names: Object.keys(toolkit.tools),
      permissions: [...definition.permissions],
      metadata: { product_profile: name },
    },
  }
}

type ResolvedProfile = ReturnType<typeof resolveImpl>

export const resolve: {
  (name: Name, model: ModelRegistry.ModelSelection): ResolvedProfile
  (model: ModelRegistry.ModelSelection): (name: Name) => ResolvedProfile
} = Function.dual(2, resolveImpl)

export const resolvePainter = Effect.fn("AgentProfiles.resolvePainter")(function* (
  model: ModelRegistry.ModelSelection,
  mediaAvailable: boolean,
) {
  if (!mediaAvailable) {
    return yield* PainterUnavailableError.make({
      message: "The configured model route does not provide the required media capability",
      provider: model.provider,
      model: model.model,
    })
  }
  return resolve("Painter", model)
})

export const presets = (options: {
  readonly model: ModelRegistry.ModelSelection
  readonly oracleModel?: ModelRegistry.ModelSelection | undefined
}): Record<string, ResolvedProfile["preset"]> =>
  Object.fromEntries(
    names.map((name) => [
      name,
      resolve(name, name === "Task" ? options.model : (options.oracleModel ?? options.model)).preset,
    ]),
  )

export const parentPermissions = [...new Set(names.flatMap((name) => definitions[name].permissions))].map((name) => ({
  name,
  value: true,
}))

export const childRunSpawnPermission = { name: "relay.child_run.spawn", value: true }

export const subagentHandoffTargets = [
  { name: "oracle", preset_name: "Oracle" },
  { name: "librarian", preset_name: "Librarian" },
  { name: "review", preset_name: "Review" },
  { name: "read_thread", preset_name: "ReadThread" },
  { name: "task", preset_name: "Task" },
] as const
