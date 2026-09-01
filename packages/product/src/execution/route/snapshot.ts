import { Schema } from "effect"
import { ModelRegistrationIdentity, modelRegistrationIdentity } from "../model/registration-identity"
import { ProviderConnectionSnapshot } from "../model/provider-connection"
import { defaultCompactionSummaryPrompt } from "../compaction/prompt"

const ModelRouteRole = Schema.Literals([
  "main",
  "oracle",
  "title",
  "compaction",
  "librarian",
  "painter",
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
  selection: Schema.String,
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

export const ExecutionRouteSnapshot = Schema.Struct({
  version: Schema.Literal(3),
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
    review: ExecutionRouteModelSnapshot,
    surgeon: ExecutionRouteModelSnapshot,
    task: ExecutionRouteModelSnapshot,
  }),
})
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
    registrationIdentity: modelRegistrationIdentity("test"),
  }
  const route = {
    selection: "test",
    registrationIdentity: modelRegistrationIdentity("test-route"),
    effort: "medium",
    fast: false,
    candidates: [candidate],
    compaction: { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
  }
  return {
    version: 3,
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
      review: { ...route, role: "review" },
      surgeon: { ...route, role: "surgeon" },
      task: { ...route, role: "task" },
    },
  }
}

const RecordValue = Schema.Record(Schema.String, Schema.Unknown)

const requireRecord = <A>(value: A, message: string) => {
  if (!Schema.is(RecordValue)(value)) throw new Error(message)
  return Schema.decodeUnknownSync(RecordValue)(value)
}

const requireKeys = (value: typeof RecordValue.Type, allowed: ReadonlyArray<string>, message: string) => {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error(message)
}

const validateConnection = <A>(value: A): void => {
  const connection = requireRecord(value, "Malformed provider connection")
  requireKeys(
    connection,
    [
      "provider",
      "protocol",
      "baseUrl",
      "authentication",
      "apiKeyEnvironment",
      "credentialIdentity",
      "accountFingerprint",
    ],
    "Unsupported provider connection field",
  )
  if (
    connection.authentication === "account" &&
    (connection.provider !== "openai" ||
      connection.protocol !== "openai-responses" ||
      !Schema.is(Schema.String)(connection.credentialIdentity) ||
      connection.credentialIdentity.length === 0 ||
      !Schema.is(Schema.String)(connection.accountFingerprint) ||
      connection.accountFingerprint.length === 0 ||
      connection.apiKeyEnvironment !== undefined)
  ) {
    throw new Error("Malformed OpenAI account provider connection")
  }
  if (connection.authentication !== "account" && connection.accountFingerprint !== undefined) {
    throw new Error("Malformed provider connection account fingerprint")
  }
}

const validateModel = <A>(value: A, expectedRole: ModelRouteRole): void => {
  const model = requireRecord(value, "Malformed execution route model")
  requireKeys(
    model,
    ["role", "selection", "registrationIdentity", "effort", "fast", "candidates", "compaction"],
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

export const toExecutionRouteSnapshot = <A extends object>(routeValue: A): ExecutionRouteSnapshot => {
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
  if (route.version !== 3) throw new Error("Unsupported execution route version")
  validateModel(route.main, "main")
  validateModel(route.oracle, "oracle")
  validateModel(route.title, "title")
  validateModel(route.compactionSummary, "compaction")
  const compaction = requireRecord(route.compaction, "Malformed execution route compaction intent")
  requireKeys(compaction, ["strategy", "summaryPrompt"], "Unsupported execution route compaction intent field")
  const agents = requireRecord(route.agents, "Malformed execution route agents")
  requireKeys(agents, ["librarian", "painter", "review", "surgeon", "task"], "Unsupported execution route agent")
  for (const role of ["librarian", "painter", "review", "surgeon", "task"] as const) validateModel(agents[role], role)
  return Schema.decodeUnknownSync(ExecutionRouteSnapshot, { onExcessProperty: "error" })(route)
}
