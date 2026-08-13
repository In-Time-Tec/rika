import { Schema, SchemaGetter } from "effect"
import { ModelRegistrationIdentity } from "./model-registration-identity"
import { ProviderConnectionSnapshot } from "./provider-connection-snapshot"
import { defaultCompactionSummaryPrompt } from "./execution-compaction-prompt"

const ModelRouteRole = Schema.Literals([
  "main",
  "oracle",
  "title",
  "compaction",
  "librarian",
  "painter",
  "readThread",
  "review",
  "surgeon",
  "task",
])
type ModelRouteRole = typeof ModelRouteRole.Type

export const ExecutionRouteModelCandidateSnapshot = Schema.Struct({
  model: Schema.String,
  providerConnection: ProviderConnectionSnapshot,
  registrationIdentity: ModelRegistrationIdentity,
  providerOptions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type ExecutionRouteModelCandidateSnapshot = typeof ExecutionRouteModelCandidateSnapshot.Type

export const ExecutionRouteModelSnapshot = Schema.Struct({
  role: ModelRouteRole,
  alias: Schema.String,
  registrationIdentity: ModelRegistrationIdentity,
  effort: Schema.String,
  fast: Schema.Boolean,
  candidates: Schema.Array(ExecutionRouteModelCandidateSnapshot),
  compaction: Schema.Struct({
    contextWindow: Schema.Finite,
    reserveTokens: Schema.Finite,
    keepRecentTokens: Schema.Finite,
  }),
})
export type ExecutionRouteModelSnapshot = typeof ExecutionRouteModelSnapshot.Type

const ExecutionRouteSnapshotV1 = Schema.Struct({
  version: Schema.Literal(1),
  mode: Schema.String,
  tokenBudget: Schema.optionalKey(Schema.Finite),
  compaction: Schema.Struct({
    strategy: Schema.Literal("default"),
    summaryPrompt: Schema.String,
  }),
  title: ExecutionRouteModelSnapshot,
  compactionSummary: ExecutionRouteModelSnapshot,
  main: ExecutionRouteModelSnapshot,
  oracle: ExecutionRouteModelSnapshot,
  agents: Schema.Struct({
    librarian: ExecutionRouteModelSnapshot,
    painter: ExecutionRouteModelSnapshot,
    readThread: ExecutionRouteModelSnapshot,
    review: ExecutionRouteModelSnapshot,
    surgeon: ExecutionRouteModelSnapshot,
    task: ExecutionRouteModelSnapshot,
  }),
})
const ExecutionRouteSnapshotV2 = Schema.Struct({
  version: Schema.Literal(2),
  mode: Schema.String,
  tokenBudget: Schema.optionalKey(Schema.Finite),
  subagents: Schema.Struct({
    maxDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_024)),
    maxSubagents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_024)),
  }),
  compaction: Schema.Struct({
    strategy: Schema.Literal("default"),
    summaryPrompt: Schema.String,
  }),
  title: ExecutionRouteModelSnapshot,
  compactionSummary: ExecutionRouteModelSnapshot,
  main: ExecutionRouteModelSnapshot,
  oracle: ExecutionRouteModelSnapshot,
  agents: Schema.Struct({
    librarian: ExecutionRouteModelSnapshot,
    painter: ExecutionRouteModelSnapshot,
    readThread: ExecutionRouteModelSnapshot,
    review: ExecutionRouteModelSnapshot,
    surgeon: ExecutionRouteModelSnapshot,
    task: ExecutionRouteModelSnapshot,
  }),
})
export const ExecutionRouteSnapshot = Schema.Union([
  ExecutionRouteSnapshotV2,
  ExecutionRouteSnapshotV1,
]).pipe(
  Schema.decodeTo(Schema.toType(ExecutionRouteSnapshotV2), {
    decode: SchemaGetter.transform((snapshot) =>
      snapshot.version === 1
        ? { ...snapshot, version: 2 as const, subagents: { maxDepth: 1, maxSubagents: 4 } }
        : snapshot,
    ),
    encode: SchemaGetter.transform((snapshot) => snapshot),
  }),
)
export type ExecutionRouteSnapshot = typeof ExecutionRouteSnapshot.Type

export const testExecutionRoute = (mode = "test"): ExecutionRouteSnapshot => {
  const candidate = {
    model: "test",
    providerConnection: {
      provider: "test",
      protocol: "test",
      baseUrl: "test://model",
      authentication: "none" as const,
    },
    registrationIdentity: "test" as ExecutionRouteModelCandidateSnapshot["registrationIdentity"],
  }
  const route = {
    alias: "test",
    registrationIdentity: "test-route" as ExecutionRouteModelSnapshot["registrationIdentity"],
    effort: "medium",
    fast: false,
    candidates: [candidate],
    compaction: { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
  }
  return {
    version: 2,
    mode,
    subagents: { maxDepth: 1, maxSubagents: 4 },
    compaction: { strategy: "default", summaryPrompt: defaultCompactionSummaryPrompt },
    title: { ...route, role: "title", effort: "low" },
    compactionSummary: { ...route, role: "compaction" },
    main: { ...route, role: "main" },
    oracle: { ...route, role: "oracle" },
    agents: {
      librarian: { ...route, role: "librarian" },
      painter: { ...route, role: "painter" },
      readThread: { ...route, role: "readThread" },
      review: { ...route, role: "review" },
      surgeon: { ...route, role: "surgeon" },
      task: { ...route, role: "task" },
    },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const requireRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(message)
  return value
}

const requireKeys = (value: Record<string, unknown>, allowed: ReadonlyArray<string>, message: string) => {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error(message)
}

const validateConnection = (value: unknown): void => {
  const connection = requireRecord(value, "Malformed provider connection")
  requireKeys(
    connection,
    ["provider", "protocol", "baseUrl", "authentication", "apiKeyEnvironment", "credentialIdentity"],
    "Unsupported provider connection field",
  )
  if (
    connection.authentication === "account" &&
    (connection.provider !== "openai" ||
      connection.protocol !== "openai" ||
      typeof connection.credentialIdentity !== "string" ||
      connection.credentialIdentity.length === 0 ||
      connection.apiKeyEnvironment !== undefined)
  ) {
    throw new Error("Malformed OpenAI account provider connection")
  }
}

const validateModel = (value: unknown, expectedRole: ModelRouteRole): void => {
  const model = requireRecord(value, "Malformed execution route model")
  requireKeys(
    model,
    ["role", "alias", "registrationIdentity", "effort", "fast", "candidates", "compaction"],
    "Unsupported execution route model field",
  )
  if (model.role !== expectedRole) throw new Error("Malformed execution route role")
  if (!Array.isArray(model.candidates) || model.candidates.length === 0)
    throw new Error("Malformed execution route candidates")
  for (const candidateValue of model.candidates) {
    const candidate = requireRecord(candidateValue, "Malformed execution route candidate")
    requireKeys(
      candidate,
      ["model", "providerConnection", "registrationIdentity", "providerOptions"],
      "Unsupported execution route candidate field",
    )
    validateConnection(candidate.providerConnection)
  }
  const compaction = requireRecord(model.compaction, "Malformed execution route compaction")
  requireKeys(
    compaction,
    ["contextWindow", "reserveTokens", "keepRecentTokens"],
    "Unsupported execution route compaction field",
  )
}

export const toExecutionRouteSnapshot = (routeValue: unknown): ExecutionRouteSnapshot => {
  const route = requireRecord(routeValue, "Malformed execution route")
  requireKeys(
    route,
    [
      "version",
      "mode",
      "tokenBudget",
      "subagents",
      "compaction",
      "title",
      "compactionSummary",
      "main",
      "oracle",
      "agents",
    ],
    "Unsupported execution route field",
  )
  if (route.version === undefined) throw new Error("Malformed execution route version")
  if (route.version !== 2) throw new Error("Unsupported execution route version")
  validateModel(route.main, "main")
  validateModel(route.oracle, "oracle")
  validateModel(route.title, "title")
  validateModel(route.compactionSummary, "compaction")
  const compaction = requireRecord(route.compaction, "Malformed execution route compaction intent")
  requireKeys(compaction, ["strategy", "summaryPrompt"], "Unsupported execution route compaction intent field")
  const agents = requireRecord(route.agents, "Malformed execution route agents")
  requireKeys(
    agents,
    ["librarian", "painter", "readThread", "review", "surgeon", "task"],
    "Unsupported execution route agent",
  )
  for (const role of ["librarian", "painter", "readThread", "review", "surgeon", "task"] as const)
    validateModel(agents[role], role)
  return Schema.decodeUnknownSync(ExecutionRouteSnapshotV2, { onExcessProperty: "error" })(route)
}
