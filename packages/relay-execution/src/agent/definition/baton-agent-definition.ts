import * as AgentTools from "@rika/coding-tools/agent-tool-contract"
import * as AgentSelection from "@rika/coding-tools/agent-tool-contract"
import * as ThreadDefinitions from "@rika/coding-tools/thread-tool-contract"
import { Agent, type ModelRegistry, TurnPolicy } from "@batonfx/core"
import * as RuntimeTools from "@rika/coding-tools/coding-tool-runtime"
import { Effect, Function, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"
import childPrompt from "../../prompts/child.prompt.txt"
import librarianPrompt from "../../prompts/librarian.prompt.txt"
import oraclePrompt from "../../prompts/oracle.prompt.txt"
import painterPrompt from "../../prompts/painter.prompt.txt"
import readThreadPrompt from "../../prompts/read-thread.prompt.txt"
import reviewPrompt from "../../prompts/review.prompt.txt"
import rootPrompt from "../../prompts/root.prompt.txt"
import surgeonPrompt from "../../prompts/surgeon.prompt.txt"
import taskPrompt from "../../prompts/task.prompt.txt"
import titlePrompt from "../../prompts/title.prompt.txt"

export const names = ["Oracle", "Librarian", "Painter", "Review", "ReadThread", "Surgeon", "Task"] as const
export type Name = (typeof names)[number]

export type AgentKey = "librarian" | "painter" | "review" | "readThread" | "surgeon" | "task"

export const agentKeyForName = (name: Name): AgentKey | undefined =>
  name === "Oracle" ? undefined : ((name.charAt(0).toLowerCase() + name.slice(1)) as AgentKey)

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
const childInstructions = instructions("child", childPrompt)

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
    tools: [RuntimeTools.toolkit.tools.grep, RuntimeTools.toolkit.tools.read, RuntimeTools.toolkit.tools.web_search],
    permissions: ["workspace.read", "network.read", "thread.read"],
    maxToolTurns: 60,
  },
  Librarian: {
    instructions: instructions("Librarian", librarianPrompt),
    tools: [RuntimeTools.toolkit.tools.web_search, RuntimeTools.toolkit.tools.read_web_page],
    permissions: ["network.read", "thread.read"],
    maxToolTurns: 30,
  },
  Painter: {
    instructions: instructions("Painter", painterPrompt),
    tools: [RuntimeTools.toolkit.tools.view_media],
    permissions: ["workspace.read", "thread.read"],
    maxToolTurns: 30,
  },
  Review: {
    instructions: instructions("Review", reviewPrompt),
    tools: [RuntimeTools.toolkit.tools.grep, RuntimeTools.toolkit.tools.read, RuntimeTools.toolkit.tools.web_search],
    permissions: ["workspace.read", "network.read", "thread.read"],
    maxToolTurns: 60,
  },
  ReadThread: {
    instructions: instructions("ReadThread", readThreadPrompt),
    tools: [
      ThreadDefinitions.ThreadContract.searchThreadsTool,
      ThreadDefinitions.ThreadContract.readThreadTranscriptTool,
    ],
    permissions: ["thread.read"],
    maxToolTurns: 30,
  },
  Surgeon: {
    instructions: instructions("Surgeon", surgeonPrompt),
    tools: [
      RuntimeTools.toolkit.tools.grep,
      RuntimeTools.toolkit.tools.read,
      RuntimeTools.toolkit.tools.write,
      RuntimeTools.toolkit.tools.edit,
      RuntimeTools.toolkit.tools.bash,
      RuntimeTools.toolkit.tools.shell_command_status,
    ],
    permissions: ["workspace.read", "workspace.write", "process.run", "thread.read"],
    maxToolTurns: 80,
  },
  Task: {
    instructions: instructions("Task", taskPrompt),
    tools: [
      RuntimeTools.toolkit.tools.grep,
      RuntimeTools.toolkit.tools.read,
      RuntimeTools.toolkit.tools.write,
      RuntimeTools.toolkit.tools.edit,
      RuntimeTools.toolkit.tools.bash,
      RuntimeTools.toolkit.tools.shell_command_status,
      RuntimeTools.toolkit.tools.web_search,
    ],
    permissions: ["workspace.read", "workspace.write", "process.run", "network.read", "thread.read"],
    maxToolTurns: 80,
  },
} as const

const resolveImpl = (name: Name, model: ModelRegistry.ModelSelection) => {
  const definition = definitions[name]
  const delegationTools = (() => {
    if (name === "ReadThread") return []
    if (name !== "Task")
      return [AgentTools.AgentContract.readThreadTool, AgentSelection.AgentContract.awaitSubagentsTool]
    return [
      AgentTools.AgentContract.oracleTool,
      AgentTools.AgentContract.librarianTool,
      AgentTools.AgentContract.reviewTool,
      AgentTools.AgentContract.surgeonTool,
      AgentTools.AgentContract.readThreadTool,
      AgentSelection.AgentContract.awaitSubagentsTool,
    ]
  })()
  const recoveryTools =
    name === "ReadThread"
      ? []
      : [ThreadDefinitions.ThreadContract.searchThreadsTool, ThreadDefinitions.ThreadContract.readThreadTranscriptTool]
  const toolkit = Toolkit.make(...definition.tools, ...delegationTools, ...recoveryTools)
  const profileInstructions =
    name === "ReadThread"
      ? definition.instructions
      : instructions(name, `${definition.instructions}\n\n${childInstructions}`)
  const relayModel = {
    provider: model.provider,
    model: model.model,
    ...(model.registrationKey === undefined ? {} : { registration_key: model.registrationKey }),
  }
  return {
    name,
    agent: Agent.make({
      name: `rika-${name.toLowerCase()}`,
      instructions: profileInstructions,
      model,
      toolkit,
      policy: TurnPolicy.both(TurnPolicy.recurs(definition.maxToolTurns), TurnPolicy.forever),
    }),
    preset: {
      instructions: profileInstructions,
      model: relayModel,
      tool_names: Object.keys(toolkit.tools),
      permissions: [...definition.permissions],
      max_tool_turns: definition.maxToolTurns,
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
  readonly agentModels?: Partial<Readonly<Record<Name, ModelRegistry.ModelSelection>>> | undefined
}): Record<string, ResolvedProfile["preset"]> =>
  Object.fromEntries(
    names.map((name) => [
      name,
      resolve(
        name,
        options.agentModels?.[name] ??
          (name === "Task" || name === "Surgeon" ? options.model : (options.oracleModel ?? options.model)),
      ).preset,
    ]),
  )

export const parentPermissions = [...new Set(names.flatMap((name) => definitions[name].permissions))].map((name) => ({
  name,
  value: true,
}))

export const rootPermissions = [
  ...parentPermissions,
  { name: "thread.coordinate", value: true },
  { name: "thread.control", value: true },
]

export const childRunSpawnPermission = { name: "relay.child_run.spawn", value: true }

export const subagentHandoffTargets = [
  { name: "oracle", preset_name: "Oracle" },
  { name: "librarian", preset_name: "Librarian" },
  { name: "review", preset_name: "Review" },
  { name: "read_thread", preset_name: "ReadThread" },
  { name: "surgeon", preset_name: "Surgeon" },
  { name: "task", preset_name: "Task" },
] as const
