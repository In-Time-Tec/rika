import { Schema } from "effect"
import { ModelRegistrationIdentity, modelRegistrationIdentity } from "./model-registration-identity"
import { ProviderAuthentication, ProviderConnectionSnapshot } from "./provider-connection-snapshot"
export { ModelRegistrationIdentity, modelRegistrationIdentity } from "./model-registration-identity"
export { ProviderAuthentication, ProviderConnectionSnapshot } from "./provider-connection-snapshot"

const ModelRouteRole = Schema.Literals([
  "main",
  "oracle",
  "title",
  "compaction",
  "librarian",
  "painter",
  "review",
  "readThread",
  "surgeon",
  "task",
])
type ModelRouteRole = typeof ModelRouteRole.Type

export const ExecutionRouteModelSnapshot = Schema.Struct({
  role: ModelRouteRole,
  alias: Schema.String,
  model: Schema.String,
  providerConnection: ProviderConnectionSnapshot,
  registrationIdentity: ModelRegistrationIdentity,
  effort: Schema.String,
  fast: Schema.Boolean,
  requestVariant: Schema.String,
  providerOptions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  compaction: Schema.Struct({
    contextWindow: Schema.Finite,
    reserveTokens: Schema.Finite,
    keepRecentTokens: Schema.Finite,
  }),
})
export type ExecutionRouteModelSnapshot = typeof ExecutionRouteModelSnapshot.Type

export const ExecutionRouteSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  mode: Schema.String,
  tokenBudget: Schema.optionalKey(Schema.Finite),
  title: Schema.optionalKey(ExecutionRouteModelSnapshot),
  compactionSummary: Schema.optionalKey(ExecutionRouteModelSnapshot),
  main: ExecutionRouteModelSnapshot,
  oracle: ExecutionRouteModelSnapshot,
  agents: Schema.optionalKey(
    Schema.Struct({
      librarian: ExecutionRouteModelSnapshot,
      painter: ExecutionRouteModelSnapshot,
      review: ExecutionRouteModelSnapshot,
      readThread: ExecutionRouteModelSnapshot,
      surgeon: ExecutionRouteModelSnapshot,
      task: ExecutionRouteModelSnapshot,
    }),
  ),
})
export type ExecutionRouteSnapshot = typeof ExecutionRouteSnapshot.Type
export type ExecutionModelRoute = ExecutionRouteModelSnapshot
export type ExecutionRoutePin = ExecutionRouteSnapshot

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

const validateModel = (value: unknown, expectedRole: ModelRouteRole): void => {
  const model = requireRecord(value, "Malformed execution route model")
  requireKeys(
    model,
    [
      "role",
      "alias",
      "model",
      "providerConnection",
      "registrationIdentity",
      "effort",
      "fast",
      "requestVariant",
      "providerOptions",
      "compaction",
    ],
    "Unsupported execution route model field",
  )
  if (model.role !== expectedRole) throw new Error("Malformed execution route role")
  const connection = requireRecord(model.providerConnection, "Malformed provider connection")
  requireKeys(
    connection,
    ["provider", "protocol", "baseUrl", "authentication", "apiKeyEnvironment", "credentialIdentity"],
    "Unsupported provider connection field",
  )
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
    ["version", "mode", "tokenBudget", "title", "compactionSummary", "main", "oracle", "agents"],
    "Unsupported execution route field",
  )
  if (route.version === undefined) throw new Error("Malformed execution route version")
  if (route.version !== 1) throw new Error("Unsupported execution route version")
  validateModel(route.main, "main")
  validateModel(route.oracle, "oracle")
  if (route.title !== undefined) validateModel(route.title, "title")
  if (route.compactionSummary !== undefined) validateModel(route.compactionSummary, "compaction")
  if (route.agents !== undefined) {
    const agents = requireRecord(route.agents, "Malformed execution route agents")
    requireKeys(
      agents,
      ["librarian", "painter", "review", "readThread", "surgeon", "task"],
      "Unsupported execution route agent",
    )
    for (const role of ["librarian", "painter", "review", "readThread", "surgeon", "task"] as const)
      validateModel(agents[role], role)
  }
  return Schema.decodeUnknownSync(ExecutionRouteSnapshot)(route)
}
