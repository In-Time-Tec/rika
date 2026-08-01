import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

const rewriteModelRouteProvider = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  const result = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => key !== "gatewayProtocol" && key !== "gatewayBaseUrl" && key !== "gatewayAuth",
    ),
  )
  if (typeof source.gatewayProtocol === "string") result.providerProtocol = source.gatewayProtocol
  if (typeof source.gatewayBaseUrl === "string") result.providerBaseUrl = source.gatewayBaseUrl
  if (typeof source.gatewayAuth === "string" && source.gatewayAuth.startsWith("bearer-env:"))
    result.providerApiKeyEnv = source.gatewayAuth.slice("bearer-env:".length)
  return result
}

export const migration013 = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql<{ readonly id: string; readonly route: string }>`
    SELECT id, execution_route_json AS route FROM rika_turns WHERE execution_route_json IS NOT NULL
  `
  for (const row of rows) {
    const source = (yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(row.route)) as Record<
      string,
      unknown
    >
    const agents = source.agents as Record<string, unknown> | undefined
    const route = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
      ...source,
      main: rewriteModelRouteProvider(source.main),
      oracle: rewriteModelRouteProvider(source.oracle),
      ...(source.title === undefined ? {} : { title: rewriteModelRouteProvider(source.title) }),
      ...(source.compactionSummary === undefined
        ? {}
        : { compactionSummary: rewriteModelRouteProvider(source.compactionSummary) }),
      ...(agents === undefined
        ? {}
        : {
            agents: Object.fromEntries(
              Object.entries(agents).map(([name, value]) => [name, rewriteModelRouteProvider(value)]),
            ),
          }),
    })
    yield* sql`UPDATE rika_turns SET execution_route_json = ${route} WHERE id = ${row.id}`
  }
})
