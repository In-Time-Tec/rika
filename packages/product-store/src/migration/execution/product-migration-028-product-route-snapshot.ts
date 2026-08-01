import { ExecutionRouteSnapshot, type ExecutionRouteModelSnapshot } from "@rika/product/execution-route-snapshot"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

class RouteSnapshotMigrationError extends Schema.TaggedErrorClass<RouteSnapshotMigrationError>()(
  "RouteSnapshotMigrationError",
  { message: Schema.String },
) {}

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

const requireString = (value: unknown, message: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(message)
  return value
}

const requireFinite = (value: unknown, message: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(message)
  return value
}

const roles = [
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
] as const

const legacyModel = (value: unknown, expectedRole: (typeof roles)[number]): ExecutionRouteModelSnapshot => {
  const input = requireRecord(value, "Malformed legacy execution route model")
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
    "Unsupported legacy execution route model field",
  )
  if (input.role !== expectedRole) throw new Error("Malformed legacy execution route role")
  const provider = requireString(input.provider, "Malformed legacy execution route provider")
  const protocol = requireString(input.providerProtocol, "Malformed legacy execution route protocol")
  const baseUrl = requireString(input.providerBaseUrl, "Malformed legacy execution route base URL")
  const alias = requireString(input.alias, "Malformed legacy execution route alias")
  const model = requireString(input.model, "Malformed legacy execution route model")
  const identity = requireString(input.registrationKey, "Malformed legacy execution route identity")
  const effort = requireString(input.effort, "Malformed legacy execution route effort")
  const requestVariant = requireString(input.requestVariant, "Malformed legacy execution route request variant")
  if (typeof input.fast !== "boolean") throw new Error("Malformed legacy execution route fast flag")
  const compaction = requireRecord(input.compaction, "Malformed legacy execution route compaction")
  requireKeys(
    compaction,
    ["contextWindow", "reserveTokens", "keepRecentTokens"],
    "Unsupported legacy execution route compaction field",
  )
  const runtime = input.providerRuntime
  let runtimeAdapter: string | undefined
  let runtimeCredentialIdentity: string | undefined
  if (runtime !== undefined) {
    const runtimeRecord = requireRecord(runtime, "Malformed legacy execution route provider runtime")
    requireKeys(
      runtimeRecord,
      ["adapter", "credentialIdentity", "connectionIdentity"],
      "Unsupported provider runtime field",
    )
    runtimeAdapter = requireString(runtimeRecord.adapter, "Malformed legacy execution route provider runtime")
    if (runtimeRecord.credentialIdentity !== undefined)
      runtimeCredentialIdentity = requireString(
        runtimeRecord.credentialIdentity,
        "Malformed legacy execution route runtime identity",
      )
    const connectionIdentity = requireRecord(
      runtimeRecord.connectionIdentity,
      "Malformed legacy execution route connection identity",
    )
    requireKeys(connectionIdentity, ["opaque"], "Unsupported legacy execution route connection identity field")
    requireString(connectionIdentity.opaque, "Malformed legacy execution route connection identity")
  }
  const fingerprint =
    input.openAiAccountFingerprint === undefined
      ? undefined
      : requireString(input.openAiAccountFingerprint, "Malformed legacy execution route account identity")
  const apiKeyEnvironment =
    input.providerApiKeyEnv === undefined
      ? undefined
      : requireString(input.providerApiKeyEnv, "Malformed legacy execution route API key environment")
  const credentialIdentity = fingerprint ?? runtimeCredentialIdentity
  let authentication: "account" | "none" | "api-key"
  if (runtimeAdapter === "openai-account" || credentialIdentity !== undefined) authentication = "account"
  else if (apiKeyEnvironment === undefined) authentication = "none"
  else authentication = "api-key"
  const providerOptions = input.providerOptions
  if (providerOptions !== undefined && !isRecord(providerOptions))
    throw new Error("Malformed legacy execution route options")
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
      ...(credentialIdentity === undefined ? {} : { credentialIdentity }),
    },
    registrationIdentity: modelRegistrationIdentity(identity),
    effort,
    fast: input.fast,
    requestVariant,
    ...(providerOptions === undefined ? {} : { providerOptions }),
    compaction: {
      contextWindow: requireFinite(compaction.contextWindow, "Malformed legacy execution route context window"),
      reserveTokens: requireFinite(compaction.reserveTokens, "Malformed legacy execution route reserve tokens"),
      keepRecentTokens: requireFinite(compaction.keepRecentTokens, "Malformed legacy execution route recent tokens"),
    },
  }
}

export const decodeLegacyExecutionRoute = (value: unknown) => {
  const input = requireRecord(value, "Malformed execution route")
  requireKeys(
    input,
    ["version", "mode", "tokenBudget", "title", "compactionSummary", "main", "oracle", "agents"],
    "Unsupported execution route field",
  )
  if (input.version !== undefined && input.version !== 1) throw new Error("Unsupported execution route version")
  if (input.version === 1 && isRecord(input.main) && input.main.providerConnection !== undefined)
    return Schema.decodeUnknownSync(ExecutionRouteSnapshot)(input)
  const mode = requireString(input.mode, "Malformed execution route mode")
  const result: Record<string, unknown> = {
    version: 1,
    mode,
    main: legacyModel(input.main, "main"),
    oracle: legacyModel(input.oracle, "oracle"),
  }
  if (input.tokenBudget !== undefined)
    result.tokenBudget = requireFinite(input.tokenBudget, "Malformed execution route token budget")
  if (input.title !== undefined) result.title = legacyModel(input.title, "title")
  if (input.compactionSummary !== undefined)
    result.compactionSummary = legacyModel(input.compactionSummary, "compaction")
  if (input.agents !== undefined) {
    const agents = requireRecord(input.agents, "Malformed execution route agents")
    requireKeys(agents, roles.slice(4), "Unsupported execution route agent")
    result.agents = Object.fromEntries(roles.slice(4).map((role) => [role, legacyModel(agents[role], role)]))
  }
  return Schema.decodeUnknownSync(ExecutionRouteSnapshot)(result)
}

const encodedSnapshot = Schema.fromJsonString(ExecutionRouteSnapshot)

export const productRouteSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql<{
    id: string
    execution_route_json: string
  }>`SELECT id, execution_route_json FROM rika_turns WHERE execution_route_json IS NOT NULL`
  const snapshots = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const route = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(row.execution_route_json).pipe(
        Effect.mapError((error) =>
          RouteSnapshotMigrationError.make({
            message: `Malformed execution route JSON for turn ${row.id}: ${String(error)}`,
          }),
        ),
      )
      const snapshot = yield* Effect.try({
        try: () => decodeLegacyExecutionRoute(route),
        catch: (error) =>
          RouteSnapshotMigrationError.make({
            message: `Malformed execution route for turn ${row.id}: ${String(error)}`,
          }),
      })
      const encoded = yield* Schema.encodeEffect(encodedSnapshot)(snapshot).pipe(
        Effect.mapError((error) =>
          RouteSnapshotMigrationError.make({
            message: `Malformed execution route for turn ${row.id}: ${String(error)}`,
          }),
        ),
      )
      return { id: row.id, encoded }
    }),
  )
  for (const row of snapshots)
    yield* sql`UPDATE rika_turns SET execution_route_json = ${row.encoded} WHERE id = ${row.id}`
})
