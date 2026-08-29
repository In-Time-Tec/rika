import { RunSchema, layer as postgresLayer } from "@tenetkit/pg"
import { Config, Context, Effect, Layer, Random } from "effect"
import { SqlClient, type SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { afterAll, beforeAll } from "vitest"
import { Pool } from "pg"
import { Agent, TurnPolicy } from "tenetkit"
import { TestModel } from "tenetkit/test"
import { Address, ExecutableManifest, ExecutableRegistration, ExecutableResolver, RunClaims } from "tenetkit/runtime"
import { driverConformance, type Services } from "tenetkit/test/runtime-driver"
import * as Postgres from "../src/postgres"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const source = "rika-execution-conformance"
const address = Address.make("agent:rika-postgres-conformance")
const executable = ExecutableManifest.makeTest("rika-postgres-conformance", "1")
const agent = Agent.close(
  Agent.make({
    name: "rika-postgres-conformance",
    policy: TurnPolicy.make(() => Effect.succeed(TurnPolicy.decision.continue())),
  }),
  TestModel.layer([]),
)
const registrations = [...ExecutableRegistration.requiredPins(executable)].map((pin) => ({
  pin,
  codec: "rika-postgres-conformance",
  version: "1",
  payload: { fixture: "rika-postgres-conformance" },
}))

let isolatedUrl = databaseUrl
let database = ""
let admin: Pool | undefined
let isolated: Pool | undefined
let activeClaims: RunClaims.Interface | undefined
let activeSql: SqlClientService | undefined

if (databaseUrl !== "") {
  const createDatabase = Effect.fn("PostgresDriverConformance.createDatabase")(function* () {
    database = `rika_execution_conformance_${String(yield* Random.nextInt).replaceAll("-", "n")}`
    admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.tryPromise(() => admin!.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl)
    parsed.pathname = `/${database}`
    isolatedUrl = parsed.toString()
    isolated = new Pool({ connectionString: isolatedUrl })
    yield* Postgres.applySchema({ url: isolatedUrl, source })
  })
  const dropDatabase = Effect.fn("PostgresDriverConformance.dropDatabase")(function* () {
    if (isolated !== undefined) yield* Effect.tryPromise(() => isolated!.end())
    if (admin !== undefined) {
      yield* Effect.tryPromise(() => admin!.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.tryPromise(() => admin!.end())
    }
  })

  beforeAll(() => Effect.runPromise(createDatabase()))
  afterAll(() => Effect.runPromise(dropDatabase()))
}

const layer = Layer.unwrap(
  Effect.sync(() => {
    const client = RunSchema.layerClient({ url: isolatedUrl, maxConnections: 12 })
    return postgresLayer({
      source,
      resolver: ExecutableResolver.makeStatic([{ executable, agent }]),
      addresses: [{ address, executable, registrations }],
    }).pipe(
      Layer.provideMerge(client),
      Layer.tap((context) =>
        Effect.sync(() => {
          activeClaims = Context.get(context, RunClaims.RunClaims)
          activeSql = Context.get(context, SqlClient)
        }),
      ),
    )
  }),
)

const claim = (services: Services, input: { readonly runId: string; readonly workerId: string }) =>
  Effect.gen(function* () {
    if (services.claims === undefined) return yield* Effect.die("PostgreSQL claims service is missing")
    const [claimed] = yield* services.claims.claimReadyRuns({ workerId: input.workerId, limit: 1, lease: "10 seconds" })
    if (claimed === undefined || claimed.run.runId !== input.runId)
      return yield* Effect.die(`PostgreSQL did not claim expected Run ${input.runId}`)
    return { runId: claimed.run.runId, ownerId: claimed.workerId, attemptFence: claimed.attemptFence }
  }).pipe(Effect.orDie)

const forceRollback = <A, E>(effect: Effect.Effect<A, E>) => {
  if (activeSql === undefined) return Effect.die("PostgreSQL transaction service is missing")
  return activeSql
    .withTransaction(effect.pipe(Effect.andThen(Effect.die("forced rollback"))))
    .pipe(Effect.catchTag("SqlError", Effect.die))
}

const expire = (workerClaim: { readonly runId: string; readonly workerId: string; readonly attemptFence: number }) =>
  activeClaims === undefined
    ? Effect.die("PostgreSQL claims service is missing")
    : activeClaims
        .refreshLease({ ...workerClaim, cancellationRequested: false, lease: -1 })
        .pipe(Effect.orDie, Effect.andThen(Effect.void))

const setup = Effect.tryPromise(() => {
  if (isolated === undefined) throw new Error("PostgreSQL conformance database is missing")
  return isolated.query(`DO $$
    DECLARE tables text;
    BEGIN
      SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') INTO tables
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename LIKE 'tenetkit_%'
        AND tablename NOT IN ('tenetkit_schema_meta', 'tenetkit_sql_migrations');
      IF tables IS NOT NULL THEN EXECUTE 'TRUNCATE TABLE ' || tables || ' CASCADE'; END IF;
    END $$`)
}).pipe(Effect.orDie, Effect.andThen(Effect.void))

driverConformance({
  name: "Rika PostgreSQL",
  address,
  layer,
  capabilities: {
    admission: true,
    runtime: { claim },
    runTree: { claim },
    sqlTransactions: { claim, forceRollback },
    multiWorkerClaims: { layer, expire },
    notificationRecovery: { claim },
  },
  setup,
  skip: databaseUrl === "",
})
