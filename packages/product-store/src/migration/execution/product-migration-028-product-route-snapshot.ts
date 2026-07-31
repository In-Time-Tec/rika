import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { toExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"

export const productRouteSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql<{
    id: string
    execution_route_json: string
  }>`SELECT id, execution_route_json FROM rika_turns WHERE execution_route_json IS NOT NULL`
  const snapshots = rows.map((row) => {
    let route: unknown
    try {
      route = JSON.parse(row.execution_route_json)
    } catch {
      throw new Error(`Malformed execution route JSON for turn ${row.id}`)
    }
    if (!route || typeof route !== "object" || Array.isArray(route))
      throw new Error(`Malformed execution route for turn ${row.id}`)
    try {
      return { id: row.id, snapshot: toExecutionRouteSnapshot(route as Record<string, unknown>) }
    } catch (error) {
      throw new Error(`Malformed execution route for turn ${row.id}: ${String(error)}`)
    }
  })
  for (const row of snapshots)
    yield* sql`UPDATE rika_turns SET execution_route_json = ${JSON.stringify(row.snapshot)} WHERE id = ${row.id}`
})
