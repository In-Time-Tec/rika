import "./product-repositories-cancellation.fixture"
import * as PgClient from "@effect/sql-pg/PgClient"
import { expect, it } from "@effect/vitest"
import { Config, Context, Effect, Exit, Layer, Redacted } from "effect"
import { TypeOverrides, types } from "pg"
import { clientLayer } from "../../src/database/postgres"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const live = it.live.skipIf(databaseUrl === "")

live("parses safe BIGINT values as numbers and rejects unsafe values", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(clientLayer({ url: Redacted.make(databaseUrl), maxConnections: 1 }))
      const sql = Context.get(context, PgClient.PgClient)
      expect((yield* sql<{ value: number }>`SELECT 9007199254740991::bigint AS value`)[0]?.value).toBe(
        Number.MAX_SAFE_INTEGER,
      )
      expect(Exit.isFailure(yield* Effect.exit(sql`SELECT 9007199254740992::bigint AS value`))).toBe(true)
    }),
  ),
)

live("preserves an explicit PostgreSQL type override", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const customTypes = new TypeOverrides()
      customTypes.setTypeParser(types.builtins.INT8, (value) => `custom:${value}`)
      const context = yield* Layer.build(
        clientLayer({ url: Redacted.make(databaseUrl), maxConnections: 1, types: customTypes }),
      )
      const sql = Context.get(context, PgClient.PgClient)
      expect((yield* sql<{ value: string }>`SELECT 42::bigint AS value`)[0]?.value).toBe("custom:42")
    }),
  ),
)
