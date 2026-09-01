import * as BunServices from "@effect/platform-bun/BunServices"
import { expect } from "@effect/vitest"
import {
  identityMember,
  identityOrganization,
  identityUser,
  type Account,
  type CliDeviceDirectory,
  type IdentityDirectory,
  type IdentityRuntime,
} from "@rika/identity"
import {
  rikaHostedExecutorAssignments,
  rikaHostedThreadEvents,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreads,
} from "@rika/product-store/database-schema"
import { ExecutorMessage } from "@rika/remote-execution/protocol"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Config, Effect, FileSystem, Option, Redacted, Ref, Schema, type Scope } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import type { Gateway } from "../../../api/src/executor/gateway"
import { runMigration } from "../../../../packages/identity/src/database/postgres"
import { identityMigrations } from "../../../../packages/identity/src/database/migrations"
import { migrations as productMigrations } from "../../../../packages/product-store/src/hosted/migrations"
import * as ExecutionPostgres from "../../../../packages/execution/src/postgres"

export const databaseUrl = Effect.runSync(Config.option(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL"))).pipe(
  Option.getOrUndefined,
)
export const live = databaseUrl !== undefined
export const encodeExecutorMessage = Schema.encodeSync(Schema.fromJsonString(ExecutorMessage))
export const workspaceCapabilities = {
  environmentDigest: `sha256:${"1".repeat(64)}`,
  capturedAt: "2026-01-01T00:00:00.000Z",
  filesystem: { _tag: "Ready", detail: "available" },
  nativeTools: { _tag: "Ready", detail: "available" },
  git: { _tag: "Ready", detail: "available" },
  process: { _tag: "Ready", detail: "available" },
  pty: { _tag: "Unavailable", reason: "not required" },
  browser: { _tag: "Unavailable", reason: "not required" },
  services: { _tag: "Ready", detail: "available" },
  workspaceLifecycle: { _tag: "Ready", detail: "available" },
} as const
export const deviceId = "device-cli-e2b"
export const clientId = "client-cli-e2b"
export const workspaceEncryptionKey = Redacted.make(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))

export const account: Account = {
  user: {
    id: "user-cli-e2b",
    name: "Rika User",
    email: "rika@example.test",
    emailVerified: true,
    image: null,
  },
  memberships: [],
}

export const migrate = (url: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const pool = yield* Effect.sync(() => new Pool({ connectionString: url }))
    for (const migration of [...identityMigrations, ...productMigrations]) {
      const sql = yield* fileSystem.readFileString(fileURLToPath(migration.url))
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    yield* ExecutionPostgres.applySchema({ url, source: "rika-cli-e2b-integration" })
    for (const migration of [...identityMigrations, ...productMigrations]) {
      const sql = yield* fileSystem.readFileString(fileURLToPath(migration.url))
      expect(yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })).toBe(false)
    }
    yield* ExecutionPostgres.applySchema({ url, source: "rika-cli-e2b-integration" })
    return pool
  })

export const webRequest = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body._tag === "Uint8Array" ? request.body.body : undefined
  const init: RequestInit = { method: request.method, headers: request.headers }
  if (body !== undefined) init.body = body
  return new Request(request.url, init)
}

export const unusedHttpClient = HttpClient.make(() =>
  Effect.die("The integration test did not install its HTTP client"),
)

export interface GatewayRef {
  current: Gateway | undefined
}

export type HostedIdentityFixture = IdentityRuntime & IdentityDirectory & CliDeviceDirectory

export const bunLayer = BunServices.layer

export const seedIdentity = (databaseClient: ReturnType<typeof drizzle>, createdAt: Date) =>
  Effect.all(
    [
      Effect.tryPromise(() =>
        databaseClient.insert(identityUser).values({
          id: account.user.id,
          name: account.user.name,
          email: account.user.email,
          emailVerified: account.user.emailVerified,
          createdAt,
          updatedAt: createdAt,
        }),
      ).pipe(Effect.orDie),
      Effect.tryPromise(() =>
        databaseClient.insert(identityOrganization).values({
          id: "organization-cli-e2b",
          name: "Rika Organization",
          slug: "rika-organization",
          createdAt,
        }),
      ).pipe(Effect.orDie),
      Effect.tryPromise(() =>
        databaseClient.insert(identityMember).values({
          id: "member-cli-e2b",
          organizationId: "organization-cli-e2b",
          userId: account.user.id,
          role: "owner",
          createdAt,
        }),
      ).pipe(Effect.orDie),
    ],
    { concurrency: 1, discard: true },
  )

export const verifyQueuedTurn = (
  databaseClient: ReturnType<typeof drizzle>,
  threadId: string,
  observations: {
    readonly helloAccepted: number
    readonly closes: ReadonlyArray<unknown>
    readonly operations: ReadonlyArray<unknown>
    readonly creates: ReadonlyArray<unknown>
    readonly bootstraps: ReadonlyArray<unknown>
    readonly localServerSpawns: Ref.Ref<number>
  },
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const [thread, assignment, commands, events] = yield* Effect.all(
      [
        Effect.tryPromise(() =>
          databaseClient
            .select({ executorKind: rikaHostedThreads.executorKind })
            .from(rikaHostedThreads)
            .where(eq(rikaHostedThreads.id, threadId)),
        ).pipe(Effect.orDie),
        Effect.tryPromise(() =>
          databaseClient
            .select({ id: rikaHostedExecutorAssignments.id, threadId: rikaHostedExecutorAssignments.threadId })
            .from(rikaHostedExecutorAssignments)
            .where(eq(rikaHostedExecutorAssignments.threadId, threadId)),
        ).pipe(Effect.orDie),
        Effect.tryPromise(() =>
          databaseClient
            .select({ idempotencyKey: rikaHostedThreadProtocolCommands.idempotencyKey })
            .from(rikaHostedThreadProtocolCommands)
            .where(eq(rikaHostedThreadProtocolCommands.threadId, threadId)),
        ).pipe(Effect.orDie),
        Effect.tryPromise(() =>
          databaseClient
            .select({ event: rikaHostedThreadEvents.event })
            .from(rikaHostedThreadEvents)
            .where(eq(rikaHostedThreadEvents.threadId, threadId)),
        ).pipe(Effect.orDie),
      ],
      { concurrency: "unbounded" },
    )
    expect(thread).toEqual([{ executorKind: "orb" }])
    expect(assignment).toHaveLength(1)
    expect(assignment[0]).toMatchObject({ threadId })
    expect(assignment[0]?.id).not.toBe(threadId)
    expect(observations.helloAccepted).toBe(0)
    expect(observations.closes).toEqual([])
    expect(commands).toHaveLength(1)
    expect(observations.operations).toHaveLength(0)
    expect(events).toHaveLength(0)
    expect(observations.creates).toHaveLength(0)
    expect(observations.bootstraps).toHaveLength(0)
    expect(yield* Ref.get(observations.localServerSpawns)).toBe(0)
  })
