import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMigrations, runMigration } from "@rika/identity"
import {
  BetterAuthUserId,
  ClientId,
  CommandId,
  DeviceId,
  IdempotencyKey,
  OwnerId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedStore } from "@rika/product/hosted-store"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { migrations } from "@rika/product-store/migrations"
import { layer } from "@rika/product-store/postgres-layer"
import { Effect, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
const live = databaseUrl !== undefined
const now = Timestamp.make("2026-01-01T00:00:00.000Z")
const later = Timestamp.make("2026-01-01T00:01:00.000Z")
const userId = BetterAuthUserId.make("protocol-user")
const ownerId = OwnerId.make("protocol-owner")
const workspaceId = WorkspaceId.make("protocol-workspace")
const threadId = ThreadId.make("protocol-thread")
const clientId = ClientId.make("protocol-client")
const deviceId = DeviceId.make("protocol-device")
const actor = {
  _tag: "PersonalActor" as const,
  owner: { _tag: "PersonalOwner" as const, userId },
  userId,
  clientId,
  deviceId,
}
const snapshot = {
  thread: {
    id: ProductThreadId.make(threadId),
    workspace: workspaceId,
    title: "Protocol Thread",
    labels: [],
    pinned: false,
    archived: false,
    lineage: { _tag: "Original" as const },
    createdAt: 1,
    updatedAt: 1,
  },
  turns: [],
  units: [],
  queue: { revision: 0, turns: [] },
  pendingAuthorizations: [],
}

const query = (pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.promise(() => pool.query(text, [...values]))

const withDatabase = <A, E, R>(use: (pool: Pool) => Effect.Effect<A, E, R | HostedStore | ThreadProtocolStore>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_thread_protocol_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* query(admin, `CREATE DATABASE "${database}"`)
      const parsed = new URL(databaseUrl!)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      let pool: Pool | undefined
      try {
        pool = new Pool({ connectionString: url })
        for (const migration of [...identityMigrations, ...migrations]) {
          const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        const context = yield* Layer.build(
          layer({ url: Redacted.make(url), maxConnections: 8 }).pipe(Layer.provide(BunCrypto.layer)),
        )
        return yield* use(pool).pipe(Effect.provide(context))
      } finally {
        yield* Effect.promise(() => pool?.end() ?? Promise.resolve())
        yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.promise(() => admin.end())
      }
    }),
  )

const setup = (pool: Pool) =>
  Effect.gen(function* () {
    yield* query(
      pool,
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
        VALUES ($1, $1, $2, true, now(), now())`,
      [userId, "protocol@example.test"],
    )
    const hosted = yield* HostedStore
    yield* hosted.putOwner({ id: ownerId, identity: actor.owner, now })
    yield* hosted.registerDevice({
      id: deviceId,
      userId,
      displayName: "Protocol device",
      publicKeyFingerprint: "protocol-key",
      now,
    })
    yield* hosted.authenticateClient({
      id: clientId,
      userId,
      deviceId,
      now,
      expiresAt: Timestamp.make("2027-01-01T00:00:00.000Z"),
    })
    yield* hosted.createWorkspace({
      id: workspaceId,
      ownerId,
      createdByUserId: userId,
      executorKind: "local_device",
      now,
    })
    yield* hosted.createThread({
      id: threadId,
      ownerId,
      workspaceId,
      createdByUserId: userId,
      executorKind: "local_device",
      now,
    })
    const protocol = yield* ThreadProtocolStore
    yield* protocol.initializeThread({ ownerId, threadId })
    return protocol
  })

const command = (id: string, expectedThreadVersion: string) => ({
  ownerId,
  threadId,
  commandId: CommandId.make(id),
  idempotencyKey: IdempotencyKey.make(`${id}-key`),
  expectedThreadVersion: ThreadVersion.make(expectedThreadVersion),
  actor,
  command: { _tag: "Cancel" },
  admittedAt: now,
})

it.effect.skipIf(!live)("serializes controllers, replays cursors, and consumes socket tickets once", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const duplicate = command("duplicate", "0")
      const deliveries = yield* Effect.all([protocol.admitCommand(duplicate), protocol.admitCommand(duplicate)], {
        concurrency: "unbounded",
      })
      expect(deliveries.filter((delivery) => delivery._tag === "Admitted")).toHaveLength(1)
      expect(deliveries.filter((delivery) => delivery._tag === "Duplicate")).toHaveLength(1)
      const completed = yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: duplicate.commandId,
        result: { _tag: "Applied" },
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        snapshot,
        completedAt: later,
      })
      expect(completed).toMatchObject({ state: "completed", threadVersion: "1", cursor: "1" })
      expect(yield* protocol.admitCommand(duplicate)).toMatchObject({ _tag: "Duplicate", command: completed })
      expect(
        yield* protocol
          .admitCommand({
            ...command("different-command", "1"),
            idempotencyKey: duplicate.idempotencyKey,
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })

      const races = yield* Effect.all(
        [command("controller-a", "1"), command("controller-b", "1")].map((input) =>
          protocol.admitCommand(input).pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      )
      expect(races.filter((result) => result._tag === "Success")).toHaveLength(1)
      expect(races.filter((result) => result._tag === "Failure")).toMatchObject([
        { failure: { reason: "stale-version" } },
      ])

      yield* protocol.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: later,
      })
      const replay = yield* protocol.replay({ ownerId, threadId, afterCursor: ThreadEventCursor.make("0"), limit: 100 })
      expect(replay).toMatchObject({ threadVersion: "2", cursor: "2", snapshot: { cursor: "1" } })
      expect(replay.events.map((event) => event.cursor)).toEqual(["2"])
      expect(
        yield* protocol.acknowledgeCursor({
          ownerId,
          threadId,
          clientId,
          cursor: ThreadEventCursor.make("1"),
          acknowledgedAt: later,
        }),
      ).toBe("1")
      const compacted = yield* protocol.replay({
        ownerId,
        threadId,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 100,
      })
      expect(compacted.snapshot?.cursor).toBe("1")
      expect(compacted.events.map((event) => event.cursor)).toEqual(["2"])

      yield* protocol.issueTicket({
        ticketId: "ticket",
        ticketDigest: "digest",
        userId,
        clientId,
        deviceId,
        audience: "/api/v1/threads/socket",
        issuedAt: now,
        expiresAt: later,
      })
      const redemptions = yield* Effect.all(
        [1, 2].map(() =>
          protocol
            .redeemTicket({ ticketDigest: "digest", audience: "/api/v1/threads/socket", redeemedAt: now })
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      )
      expect(redemptions.filter((result) => result._tag === "Success")).toHaveLength(1)
      expect(redemptions.filter((result) => result._tag === "Failure")).toHaveLength(1)

      yield* protocol.issueTicket({
        ticketId: "audience-ticket",
        ticketDigest: "audience-digest",
        userId,
        clientId,
        deviceId,
        audience: "/api/v1/threads/socket",
        issuedAt: now,
        expiresAt: later,
      })
      expect(
        yield* protocol
          .redeemTicket({ ticketDigest: "audience-digest", audience: "/wrong", redeemedAt: now })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })

      yield* protocol.issueTicket({
        ticketId: "revoked-ticket",
        ticketDigest: "revoked-digest",
        userId,
        clientId,
        deviceId,
        audience: "/api/v1/threads/socket",
        issuedAt: now,
        expiresAt: later,
      })
      yield* protocol.revokeTicket("revoked-ticket")
      expect(
        yield* protocol
          .redeemTicket({ ticketDigest: "revoked-digest", audience: "/api/v1/threads/socket", redeemedAt: now })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })

      yield* protocol.issueTicket({
        ticketId: "expired-ticket",
        ticketDigest: "expired-digest",
        userId,
        clientId,
        deviceId,
        audience: "/api/v1/threads/socket",
        issuedAt: now,
        expiresAt: later,
      })
      expect(
        yield* protocol
          .redeemTicket({ ticketDigest: "expired-digest", audience: "/api/v1/threads/socket", redeemedAt: later })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })
    }),
  ),
)
