import { Schema } from "effect"

export const ModelRegistrationIdentity = Schema.String.pipe(Schema.brand("ModelRegistrationIdentity"))
export type ModelRegistrationIdentity = typeof ModelRegistrationIdentity.Type

export const ProviderAuthentication = Schema.Literals(["api-key", "account", "none"])
export type ProviderAuthentication = typeof ProviderAuthentication.Type

export const ProviderConnectionSnapshot = Schema.Struct({
  provider: Schema.String,
  protocol: Schema.String,
  baseUrl: Schema.String,
  authentication: ProviderAuthentication,
  apiKeyEnvironment: Schema.optionalKey(Schema.String),
  credentialIdentity: Schema.optionalKey(Schema.String),
})
export type ProviderConnectionSnapshot = typeof ProviderConnectionSnapshot.Type

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

export const modelRegistrationIdentity = (value: string): ModelRegistrationIdentity =>
  Schema.decodeUnknownSync(ModelRegistrationIdentity)(value)

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

const requireString = (value: unknown, message: string) => {
  if (typeof value !== "string" || value.length === 0) throw new Error(message)
  return value
}

const requireFinite = (value: unknown, message: string) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(message)
  return value
}

const roles: ReadonlyArray<ModelRouteRole> = [
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
]
const roleSet = new Set<string>(roles)

const convertModel = (inputValue: unknown, expectedRole: ModelRouteRole): ExecutionRouteModelSnapshot => {
  const input = requireRecord(inputValue, "Malformed execution route model")
  requireKeys(
    input,
    [
      "role",
      "alias",
      "provider",
      "model",
      "registrationKey",
      "providerProtocol",
      "providerBaseUrl",
      "providerApiKeyEnv",
      "providerRuntime",
      "openAiAccountFingerprint",
      "effort",
      "fast",
      "requestVariant",
      "providerOptions",
      "compaction",
    ],
    "Unsupported execution route model field",
  )
  const role = requireString(input.role, "Malformed execution route role")
  if (role !== expectedRole || !roleSet.has(role)) throw new Error("Malformed execution route role")
  const provider = requireString(input.provider, "Malformed execution route provider")
  const protocol = requireString(input.providerProtocol, "Malformed execution route protocol")
  const baseUrl = requireString(input.providerBaseUrl, "Malformed execution route base URL")
  const alias = requireString(input.alias, "Malformed execution route alias")
  const model = requireString(input.model, "Malformed execution route model")
  const identity = requireString(input.registrationKey, "Malformed execution route identity")
  const effort = requireString(input.effort, "Malformed execution route effort")
  const requestVariant = requireString(input.requestVariant, "Malformed execution route request variant")
  if (typeof input.fast !== "boolean") throw new Error("Malformed execution route fast flag")
  const compaction = requireRecord(input.compaction, "Malformed execution route compaction")
  requireKeys(
    compaction,
    ["contextWindow", "reserveTokens", "keepRecentTokens"],
    "Unsupported execution route compaction field",
  )
  const runtime = input.providerRuntime
  if (runtime !== undefined) {
    const runtimeRecord = requireRecord(runtime, "Malformed execution route provider runtime")
    requireKeys(
      runtimeRecord,
      ["adapter", "credentialIdentity", "connectionIdentity"],
      "Unsupported provider runtime field",
    )
    requireString(runtimeRecord.adapter, "Malformed execution route provider runtime")
  }
  const fingerprint =
    input.openAiAccountFingerprint === undefined
      ? undefined
      : requireString(input.openAiAccountFingerprint, "Malformed execution route account identity")
  const apiKeyEnvironment =
    input.providerApiKeyEnv === undefined
      ? undefined
      : requireString(input.providerApiKeyEnv, "Malformed execution route API key environment")
  let authentication: ProviderAuthentication = "none"
  if ((isRecord(runtime) && runtime.adapter === "openai-account") || fingerprint !== undefined)
    authentication = "account"
  else if (apiKeyEnvironment !== undefined) authentication = "api-key"
  const providerOptions = input.providerOptions
  if (providerOptions !== undefined && !isRecord(providerOptions)) throw new Error("Malformed execution route options")
  return {
    role: expectedRole,
    alias,
    model,
    providerConnection: {
      provider,
      protocol,
      baseUrl,
      authentication,
      ...(apiKeyEnvironment === undefined ? {} : { apiKeyEnvironment }),
      ...(authentication === "account" && fingerprint !== undefined ? { credentialIdentity: fingerprint } : {}),
    },
    registrationIdentity: modelRegistrationIdentity(identity),
    effort,
    fast: input.fast,
    requestVariant,
    ...(providerOptions === undefined ? {} : { providerOptions }),
    compaction: {
      contextWindow: requireFinite(compaction.contextWindow, "Malformed execution route context window"),
      reserveTokens: requireFinite(compaction.reserveTokens, "Malformed execution route reserve tokens"),
      keepRecentTokens: requireFinite(compaction.keepRecentTokens, "Malformed execution route recent tokens"),
    },
  }
}

export const toExecutionRouteSnapshot = (routeValue: unknown): ExecutionRouteSnapshot => {
  const route = requireRecord(routeValue, "Malformed execution route")
  requireKeys(
    route,
    ["version", "mode", "tokenBudget", "title", "compactionSummary", "main", "oracle", "agents"],
    "Unsupported execution route field",
  )
  const mode = requireString(route.mode, "Malformed execution route mode")
  const modelValues = [
    route.main,
    route.oracle,
    route.title,
    route.compactionSummary,
    ...(isRecord(route.agents) ? Object.values(route.agents) : []),
  ]
  if (modelValues.some((value) => isRecord(value) && value.providerConnection !== undefined)) {
    if (route.version !== 1) throw new Error("Unsupported execution route version")
    for (const value of modelValues) {
      if (value === undefined) continue
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
      const connection = requireRecord(model.providerConnection, "Malformed provider connection")
      requireKeys(
        connection,
        ["provider", "protocol", "baseUrl", "authentication", "apiKeyEnvironment", "credentialIdentity"],
        "Unsupported provider connection field",
      )
    }
    return Schema.decodeUnknownSync(ExecutionRouteSnapshot)(route)
  }
  if (route.version !== undefined && route.version !== 1) throw new Error("Unsupported execution route version")
  const result: Record<string, unknown> = {
    version: 1,
    mode,
    main: convertModel(route.main, "main"),
    oracle: convertModel(route.oracle, "oracle"),
  }
  if (route.tokenBudget !== undefined)
    result.tokenBudget = requireFinite(route.tokenBudget, "Malformed execution route token budget")
  if (route.title !== undefined) result.title = convertModel(route.title, "title")
  if (route.compactionSummary !== undefined)
    result.compactionSummary = convertModel(route.compactionSummary, "compaction")
  if (route.agents !== undefined) {
    const agents = requireRecord(route.agents, "Malformed execution route agents")
    requireKeys(
      agents,
      ["librarian", "painter", "review", "readThread", "surgeon", "task"],
      "Unsupported execution route agent",
    )
    result.agents = Object.fromEntries(
      (["librarian", "painter", "review", "readThread", "surgeon", "task"] as const).map((role) => [
        role,
        convertModel(agents[role], role),
      ]),
    )
  }
  return Schema.decodeUnknownSync(ExecutionRouteSnapshot)(result)
}
