import { Effect, Schema } from "effect"

class RouteSnapshotMigrationError extends Schema.TaggedErrorClass<RouteSnapshotMigrationError>()(
  "RouteSnapshotMigrationError",
  { message: Schema.String },
) {}
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { toExecutionRouteSnapshot, ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"

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
        try: () => toExecutionRouteSnapshot(route),
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
