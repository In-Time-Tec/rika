import { Schema } from "effect"

export const ModelRegistrationIdentity = Schema.String.pipe(Schema.brand("ModelRegistrationIdentity"))
export type ModelRegistrationIdentity = typeof ModelRegistrationIdentity.Type

export const ProviderConnectionSnapshot = Schema.Struct({
  provider: Schema.String,
  protocol: Schema.String,
  baseUrl: Schema.String,
  apiKeyEnvironment: Schema.optionalKey(Schema.String),
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

export const modelRegistrationIdentity = (value: string): ModelRegistrationIdentity => value as ModelRegistrationIdentity

export const toExecutionRouteSnapshot = (route: Record<string, unknown>): ExecutionRouteSnapshot => {
  const convert = (input: Record<string, unknown>): ExecutionRouteModelSnapshot => {
    const provider = typeof input.provider === "string" ? input.provider : undefined
    const protocol = typeof input.providerProtocol === "string" ? input.providerProtocol : undefined
    const baseUrl = typeof input.providerBaseUrl === "string" ? input.providerBaseUrl : undefined
    const model = typeof input.model === "string" ? input.model : undefined
    const alias = typeof input.alias === "string" ? input.alias : undefined
    const role = typeof input.role === "string" ? input.role : undefined
    const registrationKey = typeof input.registrationKey === "string" ? input.registrationKey : undefined
    if (!provider || !protocol || !baseUrl || !model || !alias || !role || !registrationKey) throw new Error("Malformed execution route model")
    const compaction = input.compaction
    if (!compaction || typeof compaction !== "object") throw new Error("Malformed execution route compaction")
    return {
      role: role as ExecutionRouteModelSnapshot["role"],
      alias,
      model,
      providerConnection: {
        provider,
        protocol,
        baseUrl,
        ...(typeof input.providerApiKeyEnv === "string" ? { apiKeyEnvironment: input.providerApiKeyEnv } : {}),
      },
      registrationIdentity: modelRegistrationIdentity(registrationKey),
      effort: typeof input.effort === "string" ? input.effort : "medium",
      fast: input.fast === true,
      requestVariant: typeof input.requestVariant === "string" ? input.requestVariant : "default",
      ...(input.providerOptions && typeof input.providerOptions === "object" ? { providerOptions: input.providerOptions as Record<string, unknown> } : {}),
      compaction: {
        contextWindow: Number((compaction as Record<string, unknown>).contextWindow),
        reserveTokens: Number((compaction as Record<string, unknown>).reserveTokens),
        keepRecentTokens: Number((compaction as Record<string, unknown>).keepRecentTokens),
      },
    }
  }
  const result: Record<string, unknown> = { mode: route.mode }
  if (typeof route.tokenBudget === "number") result.tokenBudget = route.tokenBudget
  for (const key of ["title", "compactionSummary", "main", "oracle"] as const) {
    const value = route[key]
    if (value && typeof value === "object") result[key] = convert(value as Record<string, unknown>)
  }
  if (!result.main || !result.oracle) throw new Error("Malformed execution route branches")
  if (route.agents && typeof route.agents === "object") {
    const agents = route.agents as Record<string, unknown>
    result.agents = Object.fromEntries(["librarian", "painter", "review", "readThread", "surgeon", "task"].map((key) => {
      const value = agents[key]
      if (!value || typeof value !== "object") throw new Error("Malformed execution route agent branch")
      return [key, convert(value as Record<string, unknown>)]
    }))
  }
  return result as ExecutionRouteSnapshot
}
