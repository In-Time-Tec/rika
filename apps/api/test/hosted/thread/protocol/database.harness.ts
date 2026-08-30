import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { identityMigrations, identityUser, runMigration } from "@rika/identity"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import { HostedPresence } from "@rika/product/hosted-presence"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import {
  rikaHostedOwnerCounters,
  rikaHostedOwners,
  rikaHostedThreads,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaWorkspaces,
} from "@rika/product-store/database-schema"
import { layer } from "@rika/product-store/layer"
import { migrations } from "@rika/product-store/migrations"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { Config, DateTime, Effect, FileSystem, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"
import { live as livePlatform } from "../../../support/live-platform"
import {
  actor,
  authorityExpiresAt,
  clientId,
  deviceId,
  now,
  ownerId,
  threadId,
  userId,
  workspaceId,
} from "./values.harness"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))

export const live = databaseUrl !== ""

export const withDatabase = <A, E, R>(
  use: (
    pool: Pool,
    url: string,
  ) => Effect.Effect<A, E, R | HostedClientAuthority | HostedPresence | ThreadProtocolStore>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_thread_protocol_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      let pool: Pool | undefined
      try {
        const activePool = new Pool({ connectionString: url })
        pool = activePool
        for (const migration of [...identityMigrations, ...migrations]) {
          const sql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.readFileString(migration.url.pathname),
          )
          yield* runMigration({ pool: activePool, id: migration.id, checksum: migration.checksum, sql })
        }
        const context = yield* Layer.build(
          layer({ url: Redacted.make(url), maxConnections: 8 }).pipe(Layer.provide(BunCrypto.layer)),
        )
        return yield* use(activePool, url).pipe(Effect.provide(context))
      } finally {
        const cleanupPool = pool
        yield* cleanupPool === undefined ? Effect.void : Effect.tryPromise(() => cleanupPool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ).pipe(livePlatform)

export const setup = (pool: Pool) =>
  Effect.gen(function* () {
    const createdAt = DateTime.toDate(DateTime.nowUnsafe())
    const db = drizzle({ client: pool })
    yield* Effect.tryPromise(() =>
      db.insert(identityUser).values({
        id: userId,
        name: userId,
        email: "protocol@example.test",
        emailVerified: true,
        createdAt,
        updatedAt: createdAt,
      }),
    )
    const aggregateDatabase = yield* PgDrizzle.makeWithDefaults()
    yield* aggregateDatabase.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.insert(rikaHostedOwners).values({ id: ownerId, kind: "personal", userId })
        yield* tx.insert(rikaHostedOwnerCounters).values({ ownerId })
        yield* tx.insert(rikaHostedWorkspaces).values({
          id: workspaceId,
          ownerId,
          projectId: null,
          createdByUserId: userId,
          executorKind: "runner",
          inheritProjectGrants: false,
          createdAt,
        })
        yield* tx.insert(rikaWorkspaces).values({ ownerId, path: workspaceId, createdAt: 1 })
        yield* tx.insert(rikaHostedThreads).values({
          id: threadId,
          ownerId,
          projectId: null,
          workspaceId,
          createdByUserId: userId,
          executorKind: "runner",
          inheritProjectGrants: false,
          createdAt,
        })
        yield* tx.insert(rikaThreads).values({
          id: threadId,
          ownerId,
          workspace: workspaceId,
          title: "Protocol Thread",
          createdAt: 1,
          updatedAt: 1,
        })
      }),
    )
    const authority = yield* HostedClientAuthority
    yield* authority.registerDevice({
      id: deviceId,
      userId,
      displayName: "Protocol device",
      publicKeyFingerprint: "protocol-key",
      now,
    })
    yield* authority.authenticateClient({ id: clientId, userId, deviceId, now, expiresAt: authorityExpiresAt })
    yield* authority.grantClientAuthority({ ownerId, actor, now, expiresAt: authorityExpiresAt })
    const protocol = yield* ThreadProtocolStore
    yield* protocol.initializeThread({ ownerId, threadId, actor })
    return protocol
  })
