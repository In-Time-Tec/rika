import { Agent, type ModelRegistry, TurnPolicy } from "@batonfx/core"
import { AgentTools, Runtime as Tools, ThreadTools } from "@rika/tools"
import { Effect, Function, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"

export const names = ["Oracle", "Librarian", "Painter", "Review", "ReadThread", "Task"] as const
export type Name = (typeof names)[number]

export class PainterUnavailableError extends Schema.TaggedErrorClass<PainterUnavailableError>()(
  "PainterUnavailableError",
  { message: Schema.String, provider: Schema.String, model: Schema.String },
) {}

export const mainInstructions = [
  "Oracle is a read-only, high-reasoning advisor for planning, reviewing, understanding code, and debugging. Consult Oracle frequently for complex or difficult tasks. Before consulting Oracle, tell the user that you are consulting it; after consulting Oracle, state that you did and use its advice while remaining responsible for the implementation and conclusion.",
  "Use web_search when the task depends on current external facts, documentation, or public code. Use auto for normal lookups and compare only when claims are disputed, recent, safety-sensitive, or high-impact. Use kind code for semantic implementation examples and kind github for exact code, repository metadata, issues, pull requests, or commits. Treat search snippets as discovery evidence: fetch authoritative pages when details matter, cite the URLs used, and state when sources disagree. Delegate broad or multi-source research to Librarian, but handle simple lookups directly and do not query every provider by default.",
].join(" ")

const librarianInstructions = [
  "Research current external sources and return concise, cited findings without modifying files.",
  "Start with a self-contained objective and one to three focused queries. Use auto for a normal lookup. Use compare only for disputed, recent, safety-sensitive, or high-impact claims where independent perspectives improve confidence; do not query every provider by default.",
  "Choose the search kind deliberately. Use web for general research, Exa through kind code for semantic implementation examples, and kind github with githubSearchType for exact code, repositories, issues and pull requests, or commit history.",
  "Prefer primary and authoritative sources. Search excerpts are leads, not final proof: use read_web_page when the source text, version, date, qualification, or surrounding context matters. Cross-check important claims, distinguish sourced facts from your conclusions, cite the URLs that support each material finding, and call out disagreement or uncertainty explicitly. Stop when the evidence is sufficient for the request.",
].join(" ")

const definitions = {
  Oracle: {
    instructions:
      "Act as a read-only, high-reasoning technical advisor for planning, reviewing, understanding code, and debugging. Ground your advice in workspace evidence, explain your reasoning and recommendations, and do not modify files.",
    tools: [Tools.findFilesTool, Tools.grepTool, Tools.readTool, Tools.webSearchTool],
    permissions: ["workspace.read", "network.read"],
  },
  Librarian: {
    instructions: librarianInstructions,
    tools: [Tools.webSearchTool, Tools.readWebPageTool],
    permissions: ["network.read"],
  },
  Painter: {
    instructions:
      "Produce a requested visual artifact through the available media route and report its metadata. Do not modify source files.",
    tools: [Tools.viewMediaTool],
    permissions: ["workspace.read"],
  },
  Review: {
    instructions: "Review workspace changes for correctness, regressions, and missing tests. Do not modify files.",
    tools: [Tools.grepTool, Tools.readTool, Tools.gitStatusTool, Tools.webSearchTool],
    permissions: ["workspace.read", "network.read"],
  },
  ReadThread: {
    instructions: "Answer only from local thread transcripts and identify the threads used.",
    tools: [ThreadTools.findThreadTool, ThreadTools.readThreadTool],
    permissions: ["thread.read"],
  },
  Task: {
    instructions:
      "Complete the assigned implementation task in the workspace and report changed files and verification.",
    tools: [
      Tools.findFilesTool,
      Tools.grepTool,
      Tools.readTool,
      Tools.writeTool,
      Tools.editTool,
      Tools.bashTool,
      Tools.shellCommandStatusTool,
      Tools.webSearchTool,
    ],
    permissions: ["workspace.read", "workspace.write", "process.run", "network.read"],
  },
} as const

const resolveImpl = (name: Name, model: ModelRegistry.ModelSelection) => {
  const definition = definitions[name]
  const toolkit = Toolkit.make(
    ...definition.tools,
    ...(name === "Oracle" || name === "Review" ? [] : Object.values(AgentTools.modelToolkit.tools)),
  )
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

const presetsImpl = (
  model: ModelRegistry.ModelSelection,
  oracleModel?: ModelRegistry.ModelSelection,
  agentModels?: Partial<Readonly<Record<Name, ModelRegistry.ModelSelection>>>,
): Record<string, ResolvedProfile["preset"]> =>
  Object.fromEntries(
    names.map((name) => [
      name,
      resolve(name, agentModels?.[name] ?? (name === "Oracle" ? (oracleModel ?? model) : model)).preset,
    ]),
  )

export const presets: {
  (
    model: ModelRegistry.ModelSelection,
    oracleModel?: ModelRegistry.ModelSelection,
    agentModels?: Partial<Readonly<Record<Name, ModelRegistry.ModelSelection>>>,
  ): Record<string, ResolvedProfile["preset"]>
  (
    oracleModel?: ModelRegistry.ModelSelection,
    agentModels?: Partial<Readonly<Record<Name, ModelRegistry.ModelSelection>>>,
  ): (model: ModelRegistry.ModelSelection) => Record<string, ResolvedProfile["preset"]>
} = Function.dual(
  (arguments_) =>
    arguments_.length > 0 && (arguments_.length !== 2 || arguments_[1] === undefined || "provider" in arguments_[1]),
  presetsImpl,
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
