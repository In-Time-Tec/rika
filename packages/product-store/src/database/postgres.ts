import * as PgClient from "@effect/sql-pg/PgClient"
import { Cause, Duration, Effect, Exit, Redacted, Stream } from "effect"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { ConnectionError, SqlError, UnknownError } from "effect/unstable/sql/SqlError"
import { Reactivity } from "effect/unstable/reactivity"
import { Client, Pool, TypeOverrides, type PoolClient, types } from "pg"
import Cursor from "pg-cursor"

const productTypes = () => {
  const overrides = new TypeOverrides()
  overrides.setTypeParser(types.builtins.INT8, (value) => {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed))
      throw new RangeError(`PostgreSQL BIGINT is outside JavaScript's safe integer range: ${value}`)
    return parsed
  })
  return overrides
}

const makeClient = (config: PgClient.PgPoolConfig) =>
  Effect.gen(function* () {
    const pool = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Pool({
            connectionString: config.url === undefined ? undefined : Redacted.value(config.url),
            host: config.path ?? config.host,
            ...(config.stream === undefined ? undefined : { stream: config.stream }),
            port: config.port,
            user: config.username,
            password: config.password === undefined ? undefined : Redacted.value(config.password),
            database: config.database,
            ssl: config.ssl,
            types: config.types,
            application_name: config.applicationName,
            max: config.maxConnections,
            min: config.minConnections,
            connectionTimeoutMillis: Duration.toMillis(config.connectTimeout ?? "5 seconds"),
            idleTimeoutMillis: Duration.toMillis(config.idleTimeout ?? "10 seconds"),
            maxLifetimeSeconds:
              config.connectionTTL === undefined ? 0 : Duration.toMillis(config.connectionTTL) / 1_000,
          }),
      ),
      // ast-grep-ignore: effect-prefer-promise-composition -- pg Pool shutdown is a foreign cleanup boundary.
      (resource) => Effect.promise(() => resource.end()),
    )
    pool.on("error", () => {})
    const backendIds = new WeakMap<PoolClient, number>()
    const reactivity = yield* Reactivity.Reactivity
    const acquire = Effect.gen(function* () {
      let released = false
      const raw = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => pool.connect(),
          catch: (cause) => SqlError.make({ reason: ConnectionError.make({ cause, operation: "acquire" }) }),
        }),
        (client, exit) =>
          Effect.sync(() => {
            if (!released) {
              released = true
              client.release(Exit.isFailure(exit))
            }
          }),
      )
      const discard = Effect.sync(() => {
        if (!released) {
          released = true
          raw.release(true)
        }
      })
      const onError = () => {}
      raw.on("error", onError)
      yield* Effect.addFinalizer(() => Effect.sync(() => raw.off("error", onError)))
      const pooledClient = new Client(pool.options)
      pooledClient.query = raw.query.bind(raw)
      const client = yield* PgClient.fromClient({
        acquire: Effect.succeed(pooledClient),
        acquireForStream: true,
      }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity))
      let backendId = backendIds.get(raw)
      if (backendId === undefined) {
        const [row] = yield* client<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid`
        if (row === undefined)
          return yield* SqlError.make({
            reason: ConnectionError.make({ cause: "Missing backend PID", operation: "acquire" }),
          })
        backendId = row.pid
        backendIds.set(raw, backendId)
      }
      const pid = backendId
      const cancel = Effect.acquireUseRelease(
        Effect.sync(() => {
          const control = new Client({ ...pool.options, connectionTimeoutMillis: 750, query_timeout: 750 })
          control.on("error", () => {})
          return control
        }),
        (control) =>
          Effect.tryPromise(() => control.connect()).pipe(
            Effect.andThen(Effect.tryPromise(() => control.query("SELECT pg_cancel_backend($1)", [pid]))),
          ),
        // ast-grep-ignore: effect-prefer-promise-composition -- pg cancel-connection shutdown is a foreign cleanup boundary.
        (control) => Effect.promise(() => control.end()).pipe(Effect.timeoutOption("1 second")),
      ).pipe(Effect.ignore, Effect.ensuring(discard))
      const connection = yield* client.reserve
      const protect = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.onInterrupt(() => cancel))
      return {
        execute: (...args) => protect(connection.execute(...args)),
        executeRaw: (...args) => protect(connection.executeRaw(...args)),
        executeUnprepared: (...args) => protect(connection.executeUnprepared(...args)),
        executeValues: (...args) => protect(connection.executeValues(...args)),
        executeValuesUnprepared: (...args) => protect(connection.executeValuesUnprepared(...args)),
        executeStream: (sql, params, transformRows) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const closeCursor = (resource: Cursor<object>) => {
                if (released) return Effect.void
                // ast-grep-ignore: effect-prefer-promise-composition -- pg Cursor close is a foreign cleanup boundary.
                return Effect.promise(() => resource.close())
              }
              const cursor = yield* Effect.acquireRelease(
                Effect.sync(() => raw.query(new Cursor<object>(sql, [...params]))),
                (resource) => Effect.suspend(() => closeCursor(resource)),
              )
              const pull = Effect.callback<readonly [object, ...Array<object>], SqlError | Cause.Done>((resume) => {
                cursor.read(128, (cause, rows: Array<object>) => {
                  if (cause !== undefined && cause !== null)
                    resume(Effect.fail(SqlError.make({ reason: UnknownError.make({ cause, operation: "stream" }) })))
                  else if (rows.length === 0) resume(Cause.done())
                  else {
                    const transformed = transformRows === undefined ? rows : transformRows(rows)
                    const [first, ...rest] = transformed
                    if (first === undefined) resume(Cause.done())
                    else resume(Effect.succeed([first, ...rest]))
                  }
                })
              }).pipe(
                Effect.onInterrupt(() => cancel),
                Effect.onError(() => discard),
              )
              return Stream.fromPull(Effect.succeed(pull))
            }),
          ),
      } satisfies Connection
    })
    const listener = Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const resource = new Client(pool.options)
          resource.on("error", () => {})
          return resource
        }),
        // ast-grep-ignore: effect-prefer-promise-composition -- pg listener shutdown is a foreign cleanup boundary.
        (resource) => Effect.promise(() => resource.end()),
      )
      yield* Effect.tryPromise({
        try: () => client.connect(),
        catch: (cause) => SqlError.make({ reason: ConnectionError.make({ cause, operation: "listen" }) }),
      })
      return client
    })
    return yield* PgClient.makeWith({
      acquirer: acquire,
      transactionAcquirer: acquire,
      listenAcquirer: listener,
      config,
      spanAttributes: config.spanAttributes,
      transformResultNames: config.transformResultNames,
      transformQueryNames: config.transformQueryNames,
      transformJson: config.transformJson,
    })
  })

export const clientLayer = (config: PgClient.PgPoolConfig) =>
  PgClient.layerFrom(makeClient(config.types === undefined ? { ...config, types: productTypes() } : config))
