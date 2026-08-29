import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMember, identityMigrations, identityOrganization, identityUser, runMigration } from "@rika/identity"
import * as ExecutionProjection from "@rika/product/execution-projection"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  CommandId,
  DeviceId,
  IdempotencyKey,
  OrganizationId,
  OwnerId,
  RequestId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { HostedPresence } from "@rika/product/hosted-presence"
import { protocolVersion, type HostedThreadSnapshot, type ServerFrame } from "@rika/product/client-protocol"
import type { InteractiveCommand } from "@rika/product/interactive-command"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { TurnId } from "@rika/product/turn-record"
import {
  rikaHostedClientAuthorities,
  rikaHostedOwnerCounters,
  rikaHostedOwners,
  rikaHostedThreads,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolEvents,
  rikaHostedThreadProtocolSnapshots,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaWorkspaces,
} from "@rika/product-store/database-schema"
import { migrations } from "@rika/product-store/migrations"
import { layer } from "@rika/product-store/layer"
import { and, count, eq, gt } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { FileSystem, Config, Context, DateTime, Deferred, Effect, Layer, Random, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { Pool } from "pg"
import { live as livePlatform } from "../../support/live-platform"
import { HostedThreadApplication, type HostedThreadApplicationService } from "../../../src/hosted/thread/application"
import { layer as hostedThreadCommandWorkerLayer } from "../../../src/hosted/thread/command-worker"
import { HostedProduct, type HostedProductService } from "../../../src/hosted/product"
import {
  HostedThreadProtocol,
  layer as hostedThreadProtocolLayer,
  layerWithOptions as hostedThreadProtocolLayerWithOptions,
  threadWebSocketAudience,
} from "../../../src/hosted/thread/protocol"
import { HostedToolPolicy } from "../../../src/hosted/execution/tool-policy"
import { HostedWorkspace } from "../../../src/hosted/environment/workspace"
import { layerTest as hostedWorkerRuntimeLayerTest } from "../../../src/hosted/worker-runtime"
import { testToolPolicy } from "../execution/tool-policy.fixture"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const live = databaseUrl !== ""
const startedAt = DateTime.toEpochMillis(DateTime.nowUnsafe())
const timestampAfter = (milliseconds: number) =>
  Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(startedAt + milliseconds)))
const now = timestampAfter(0)
const later = timestampAfter(60_000)
const authorityExpiresAt = timestampAfter(5 * 60_000)
const presenceExpiresAt = timestampAfter(4 * 60_000)
const userId = BetterAuthUserId.make("protocol-user")
const ownerId = OwnerId.make("protocol-owner")
const workspaceId = WorkspaceId.make("protocol-workspace")
const threadId = ThreadId.make("protocol-thread")
const assignmentId = "protocol-assignment"
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
  executorKind: "runner" as const,
  view: {
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
    revision: 0,
    source: { projectionVersion: ExecutionProjection.projectionVersion },
    turns: [],
    pending: [],
    hasOlder: false,
    hasNewer: false,
    usage: { state: ExecutionProjection.emptyUsageState() },
  },
  pendingAuthorizations: [],
}

const withDatabase = <A, E, R>(
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
          yield* runMigration({
            pool: activePool,
            id: migration.id,
            checksum: migration.checksum,
            sql,
          })
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

const setup = (pool: Pool) =>
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
    yield* authority.authenticateClient({
      id: clientId,
      userId,
      deviceId,
      now,
      expiresAt: authorityExpiresAt,
    })
    yield* authority.grantClientAuthority({
      ownerId,
      actor,
      now,
      expiresAt: authorityExpiresAt,
    })
    const protocol = yield* ThreadProtocolStore
    yield* protocol.initializeThread({ ownerId, threadId, actor })
    return protocol
  })

const command = (id: string, expectedThreadVersion: string) => ({
  ownerId,
  threadId,
  commandId: CommandId.make(id),
  turnId: TurnId.make(`turn-${id}`),
  idempotencyKey: IdempotencyKey.make(`${id}-key`),
  expectedThreadVersion: ThreadVersion.make(expectedThreadVersion),
  actor,
  command: { _tag: "Cancel" },
  admittedAt: now,
})

const completeMockPrompt = (
  store: ThreadProtocolStore["Service"],
  input: Parameters<HostedProductService["admitAuthorizedRun"]>[0],
  status: "accepted" | "queued",
  completedSnapshot?: HostedThreadSnapshot,
) => {
  if (input.claimToken === undefined) return Effect.die("Worker prompt admission is missing its command claim")
  const completion: Parameters<ThreadProtocolStore["Service"]["completeCommand"]>[0] = {
    ownerId: input.authority.ownerId,
    threadId: ThreadId.make(input.threadId),
    commandId: CommandId.make(input.operationKey),
    claimToken: input.claimToken,
    result: { _tag: "PromptAdmitted", status },
    events: [
      {
        _tag: "SubmissionAdmitted",
        threadId: ProductThreadId.make(input.threadId),
        turnId: TurnId.make(input.turnId),
        status: status === "accepted" ? "active" : "queued",
        submissionId: input.submissionId ?? input.operationKey,
      },
    ],
    completedAt: later,
  }
  if (completedSnapshot !== undefined) Object.assign(completion, { snapshot: completedSnapshot })
  return store.completeCommand(completion).pipe(
    Effect.orDie,
    Effect.as({
      _tag: "Admitted" as const,
      commandId: input.operationKey,
      turnId: input.turnId,
      status,
    }),
  )
}

it.effect.skipIf(!live)("serializes controllers, replays cursors, and consumes socket tickets once", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const db = drizzle({ client: pool })
      const duplicate = command("duplicate", "0")
      const deliveries = yield* Effect.all([protocol.admitCommand(duplicate), protocol.admitCommand(duplicate)], {
        concurrency: "unbounded",
      })
      expect(deliveries.filter((delivery) => delivery._tag === "Admitted")).toHaveLength(1)
      expect(deliveries.filter((delivery) => delivery._tag === "Duplicate")).toHaveLength(1)
      const firstClaimToken = "duplicate-claim-first"
      expect(
        yield* protocol.claimNextCommand({
          claimToken: firstClaimToken,
          claimMillis: 60_000,
        }),
      ).toMatchObject({
        commandId: duplicate.commandId,
      })
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "duplicate-claim-busy",
          claimMillis: 60_000,
        }),
      ).toBeUndefined()
      yield* Effect.tryPromise(() =>
        db
          .update(rikaHostedThreadProtocolCommands)
          .set({ claimExpiresAt: DateTime.toDate(DateTime.makeUnsafe(0)) })
          .where(
            and(
              eq(rikaHostedThreadProtocolCommands.threadId, threadId),
              eq(rikaHostedThreadProtocolCommands.commandId, duplicate.commandId),
            ),
          ),
      )
      const claimToken = "duplicate-claim-recovered"
      expect(yield* protocol.claimNextCommand({ claimToken, claimMillis: 60_000 })).toMatchObject({
        commandId: duplicate.commandId,
      })
      expect(
        yield* protocol.renewCommandClaim({
          ownerId,
          threadId,
          commandId: duplicate.commandId,
          claimToken: firstClaimToken,
          claimMillis: 60_000,
        }),
      ).toBe(false)
      yield* protocol.releaseCommandClaim({
        ownerId,
        threadId,
        commandId: duplicate.commandId,
        claimToken: firstClaimToken,
      })
      expect(
        yield* protocol.renewCommandClaim({
          ownerId,
          threadId,
          commandId: duplicate.commandId,
          claimToken,
          claimMillis: 60_000,
        }),
      ).toBe(true)
      expect(
        yield* protocol
          .completeCommand({
            ownerId,
            threadId,
            commandId: duplicate.commandId,
            claimToken: firstClaimToken,
            result: { _tag: "Applied" },
            events: [],
            completedAt: later,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale-fence" },
      })
      const completed = yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: duplicate.commandId,
        claimToken,
        result: { _tag: "Applied" },
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        snapshot,
        completedAt: later,
      })
      expect(completed).toMatchObject({
        _tag: "Completed",
        command: { state: "completed", threadVersion: "1", cursor: "1" },
      })
      expect(yield* protocol.admitCommand(duplicate)).toMatchObject({
        _tag: "Duplicate",
        command: completed.command,
      })
      expect(
        yield* protocol
          .admitCommand({
            ...duplicate,
            command: { _tag: "Cancel", payload: "changed" },
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } })
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

      const appended = yield* protocol.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: later,
      })
      yield* protocol.checkpoint({
        ownerId,
        threadId,
        threadVersion: appended[0]!.threadVersion,
        cursor: appended[0]!.cursor,
        snapshot,
        createdAt: later,
      })
      const replay = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 100,
      })
      expect(replay).toMatchObject({
        threadVersion: "2",
        cursor: "2",
        snapshot: { cursor: "1" },
      })
      expect(replay.events).toMatchObject([{ cursor: "2" }])
      expect(
        yield* protocol.acknowledgeCursor({
          ownerId,
          threadId,
          actor,
          cursor: ThreadEventCursor.make("1"),
          acknowledgedAt: later,
        }),
      ).toBe("1")
      const compacted = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 100,
      })
      expect(compacted.snapshot?.cursor).toBe("1")
      expect(compacted.events).toMatchObject([{ cursor: "2" }])

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
            .redeemTicket({
              ticketDigest: "digest",
              audience: "/api/v1/threads/socket",
              redeemedAt: now,
            })
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
          .redeemTicket({
            ticketDigest: "audience-digest",
            audience: "/wrong",
            redeemedAt: now,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })

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
          .redeemTicket({
            ticketDigest: "revoked-digest",
            audience: "/api/v1/threads/socket",
            redeemedAt: now,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })

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
          .redeemTicket({
            ticketDigest: "expired-digest",
            audience: "/api/v1/threads/socket",
            redeemedAt: later,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })
    }),
  ),
)

it.effect.skipIf(!live)("claims one admitted command, reclaims expiry, and includes Thread creation", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const db = drizzle({ client: pool })
      const input = command("worker-command", "0")
      yield* protocol.admitCommand(input)
      const claims = yield* Effect.all(
        ["worker-claim-a", "worker-claim-b"].map((claimToken) =>
          protocol.claimNextCommand({ claimToken, claimMillis: 60_000 }),
        ),
        { concurrency: "unbounded" },
      )
      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
      expect(claims.find((claim) => claim !== undefined)).toMatchObject({
        commandId: input.commandId,
      })

      yield* Effect.tryPromise(() =>
        db
          .update(rikaHostedThreadProtocolCommands)
          .set({ claimExpiresAt: DateTime.toDate(DateTime.makeUnsafe(0)) })
          .where(
            and(
              eq(rikaHostedThreadProtocolCommands.threadId, threadId),
              eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
            ),
          ),
      )
      const recovered = yield* protocol.claimNextCommand({
        claimToken: "worker-claim-recovered",
        claimMillis: 60_000,
      })
      expect(recovered).toMatchObject({ commandId: input.commandId })
      yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: input.commandId,
        claimToken: "worker-claim-recovered",
        result: { _tag: "Applied" },
        events: [],
        completedAt: later,
      })

      yield* protocol.admitCommand({
        ...command("create-command", "1"),
        command: { _tag: "CreateThread" },
      })
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "worker-claim-create",
          claimMillis: 60_000,
        }),
      ).toMatchObject({
        commandId: "create-command",
        command: { _tag: "CreateThread" },
      })
    }),
  ),
)

it.effect.skipIf(!live)("claims ordinary commands in Thread version order across concurrent workers", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const first = command("ordered-first", "0")
      const second = command("ordered-second", "1")
      yield* protocol.admitCommand(first)
      yield* protocol.admitCommand(second)

      const attempts = ["ordered-worker-a", "ordered-worker-b"]
      const claims = yield* Effect.all(
        attempts.map((claimToken) => protocol.claimNextCommand({ claimToken, claimMillis: 60_000 })),
        { concurrency: "unbounded" },
      )
      expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1)
      expect(claims.find((claim) => claim !== undefined)).toMatchObject({
        commandId: first.commandId,
      })

      const claimedIndex = claims.findIndex((claim) => claim !== undefined)
      yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: first.commandId,
        claimToken: attempts[claimedIndex]!,
        result: { _tag: "Applied" },
        events: [],
        completedAt: now,
      })
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "ordered-worker-next",
          claimMillis: 60_000,
        }),
      ).toMatchObject({ commandId: second.commandId })
    }),
  ),
)

it.effect.skipIf(!live)("keeps same-Thread order and Turn identity stable across worker interruption", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const first = command("interrupted-first", "0")
      const second = command("interrupted-second", "1")
      yield* protocol.admitCommand(first)
      yield* protocol.admitCommand(second)

      const initial = yield* protocol.claimNextCommand({
        claimToken: "interrupted-worker",
        claimMillis: 60_000,
      })
      expect(initial).toMatchObject({ commandId: first.commandId, turnId: first.turnId })
      yield* protocol.releaseCommandClaim({
        ownerId,
        threadId,
        commandId: first.commandId,
        claimToken: "interrupted-worker",
      })

      const recovered = yield* protocol.claimNextCommand({
        claimToken: "recovered-worker",
        claimMillis: 60_000,
      })
      expect(recovered).toMatchObject({ commandId: first.commandId, turnId: first.turnId })
      yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: first.commandId,
        claimToken: "recovered-worker",
        result: { _tag: "Applied" },
        events: [],
        completedAt: later,
      })

      expect(
        yield* protocol.claimNextCommand({
          claimToken: "next-worker",
          claimMillis: 60_000,
        }),
      ).toMatchObject({ commandId: second.commandId, turnId: second.turnId })
    }),
  ),
)

it.effect.skipIf(!live)("claims another Thread while one Thread command lane is locked", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const aggregateDatabase = yield* PgDrizzle.makeWithDefaults()
      const otherThreadId = ThreadId.make("protocol-thread-other")
      yield* aggregateDatabase.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(rikaHostedThreads).values({
            id: otherThreadId,
            ownerId,
            projectId: null,
            workspaceId,
            createdByUserId: userId,
            executorKind: "runner",
            inheritProjectGrants: false,
            createdAt: DateTime.toDate(DateTime.nowUnsafe()),
          })
          yield* tx.insert(rikaThreads).values({
            id: otherThreadId,
            ownerId,
            workspace: workspaceId,
            title: "Other protocol thread",
            createdAt: 2,
            updatedAt: 2,
          })
        }),
      )
      yield* protocol.initializeThread({
        ownerId,
        threadId: otherThreadId,
        actor,
      })
      yield* protocol.admitCommand(command("locked-thread-command", "0"))
      yield* protocol.admitCommand({
        ...command("other-thread-command", "0"),
        threadId: otherThreadId,
      })

      const client = yield* Effect.tryPromise(() => pool.connect())
      yield* Effect.gen(function* () {
        yield* Effect.tryPromise(() => client.query("BEGIN"))
        yield* Effect.tryPromise(() =>
          client.query(`SELECT 1 FROM rika_hosted_thread_protocol_state WHERE thread_id = $1 FOR UPDATE`, [threadId]),
        )
        expect(
          yield* protocol.claimNextCommand({
            claimToken: "other-thread-claim",
            claimMillis: 60_000,
          }),
        ).toMatchObject({
          threadId: otherThreadId,
          commandId: "other-thread-command",
        })
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise(() => client.query("ROLLBACK")).pipe(
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => client.release())),
          ),
        ),
      )
    }),
  ),
)

it.effect.skipIf(!live)("does not let command cancellation overtake a non-prompt command", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const firstInput = command("service-before-cancel", "0")
      const first = {
        ...firstInput,
        command: {
          _tag: "EnsureRepositoryService",
          commandId: firstInput.commandId,
          service: { serviceId: "docs", command: "bun", args: ["run", "dev"], cwd: "." },
        },
      }
      const secondInput = command("cancel-service", "1")
      const second = {
        ...secondInput,
        command: {
          _tag: "Cancel",
          commandId: secondInput.commandId,
          target: { _tag: "Command", commandId: firstInput.commandId },
        },
      }
      yield* protocol.admitCommand(first)
      yield* protocol.admitCommand(second)
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "service-before-cancel-claim",
          claimMillis: 60_000,
        }),
      ).toMatchObject({ commandId: first.commandId })
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "cancel-service-claim",
          claimMillis: 60_000,
        }),
      ).toBeUndefined()
    }),
  ),
)

it.effect.skipIf(!live)("keeps event versions and snapshots monotonic when commands complete out of order", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const firstInput = command("completion-first", "0")
      const first = {
        ...firstInput,
        command: {
          _tag: "SubmitPrompt",
          threadId,
          commandId: firstInput.commandId,
          text: "complete after cancellation",
        },
      }
      const secondInput = command("completion-second", "1")
      const second = {
        ...secondInput,
        command: {
          _tag: "Cancel",
          threadId,
          commandId: secondInput.commandId,
          target: { _tag: "Command", commandId: firstInput.commandId },
        },
      }
      yield* protocol.admitCommand(first)
      yield* protocol.admitCommand(second)
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "completion-first-claim",
          claimMillis: 60_000,
        }),
      ).toMatchObject({ commandId: first.commandId })
      expect(
        yield* protocol.claimNextCommand({
          claimToken: "completion-second-claim",
          claimMillis: 60_000,
        }),
      ).toMatchObject({ commandId: second.commandId })

      const secondCompletion = yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: second.commandId,
        claimToken: "completion-second-claim",
        result: { _tag: "Applied" },
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        snapshot,
        completedAt: timestampAfter(60_000),
      })
      const firstCompletion = yield* protocol.completeCommand({
        ownerId,
        threadId,
        commandId: first.commandId,
        claimToken: "completion-first-claim",
        result: { _tag: "Applied" },
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        snapshot,
        completedAt: timestampAfter(120_000),
      })
      expect(secondCompletion.command).toMatchObject({
        threadVersion: "2",
        cursor: "1",
      })
      expect(firstCompletion.command).toMatchObject({
        threadVersion: "1",
        cursor: "2",
      })

      const events = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        includeSnapshot: false,
        limit: 100,
      })
      expect(events.events.map((event) => [event.cursor, event.threadVersion])).toEqual([
        ["1", "2"],
        ["2", "2"],
      ])
      const snapshots = yield* Effect.tryPromise(() =>
        drizzle({ client: pool })
          .select({
            threadVersion: rikaHostedThreadProtocolSnapshots.threadVersion,
            cursor: rikaHostedThreadProtocolSnapshots.cursor,
          })
          .from(rikaHostedThreadProtocolSnapshots)
          .where(eq(rikaHostedThreadProtocolSnapshots.threadId, threadId)),
      )
      expect(
        snapshots.map(({ threadVersion, cursor }) => ({ version: String(threadVersion), cursor: String(cursor) })),
      ).toMatchObject([{ version: "2", cursor: "1" }])
    }),
  ),
)

it.effect.skipIf(!live)("applies an admitted prompt without client traffic and recovers interrupted completion", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const authority = yield* HostedClientAuthority
      let completionAttempts = 0
      let admissionAttempts = 0
      const admittedEffects = new Set<string>()
      const admittedTurnIds = new Set<string>()
      const workerProtocol = ThreadProtocolStore.of({
        ...protocol,
        completeCommand: (input) => {
          if (input.commandId !== "server-owned-submit") return protocol.completeCommand(input)
          completionAttempts += 1
          return completionAttempts === 1
            ? Effect.fail(
                HostedPersistenceError.make({
                  reason: "database",
                  message: "simulated API interruption",
                }),
              )
            : protocol.completeCommand(input)
        },
      })
      const product: HostedProductService = {
        ready: Effect.void,
        projects: () => Effect.die("unused"),
        createProject: () => Effect.die("unused"),
        createConnection: () => Effect.die("unused"),
        registerRunner: () => Effect.die("unused"),
        setRemoteThreadCreation: () => Effect.die("unused"),
        pollRunner: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
        admitAuthorizedRun: (input) =>
          Effect.sync(() => {
            admissionAttempts += 1
            admittedEffects.add(input.operationKey)
            admittedTurnIds.add(input.turnId)
          }).pipe(Effect.andThen(completeMockPrompt(workerProtocol, input, "accepted"))),
        cancelRunAdmission: () => Effect.die("unused"),
        cancelAuthorizedRunAdmission: () => Effect.die("unused"),
        authorizeOwner: () => Effect.die("unused"),
        authorizeThread: () => Effect.die("unused"),
        threadExecutionContext: () => Effect.die("unused"),
        activatePrincipal: () => Effect.die("unused"),
      }
      const operations: HostedThreadApplicationService = {
        threads: () => Effect.die("unused"),
        preview: () => Effect.die("unused"),
        thread: () => Effect.die("unused"),
        interactive: () => Effect.die("unused"),
        snapshot: () => Effect.succeed(snapshot),
        projectionCommitted: () => Effect.die("unused"),
      }
      yield* Layer.build(
        hostedThreadCommandWorkerLayer({
          claimMillis: 10_000,
          fallbackIntervalMillis: 250,
        }).pipe(
          Layer.provide(hostedWorkerRuntimeLayerTest),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ThreadProtocolStore, workerProtocol),
              Layer.succeed(HostedClientAuthority, authority),
              Layer.succeed(HostedProduct, product),
              Layer.succeed(HostedThreadApplication, operations),
              Layer.succeed(
                HostedWorkspace,
                HostedWorkspace.of({
                  execute: () => Effect.die("unused"),
                  pause: () => Effect.die("unused"),
                  resume: () => Effect.die("unused"),
                  portal: () => Effect.die("unused"),
                }),
              ),
              Layer.succeed(HostedToolPolicy, testToolPolicy),
              BunCrypto.layer,
            ),
          ),
        ),
      )
      const create = {
        ...command("server-owned-create", "0"),
        command: {
          _tag: "CreateThread",
          commandId: CommandId.make("server-owned-create"),
          idempotencyKey: IdempotencyKey.make("server-owned-create-key"),
          expectedThreadVersion: ThreadVersion.make("0"),
          owner: { kind: "personal" },
          executorKind: "runner",
          runnerTarget: { deviceId, checkoutFingerprint: "checkout-1" },
        },
      }
      yield* protocol.admitCommand(create)
      let creationCompleted = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* TestClock.adjust("250 millis")
        yield* Effect.yieldNow
        const current = yield* protocol.admitCommand(create)
        if (current.command.state === "completed") {
          creationCompleted = true
          expect(current.command.result).toEqual({
            _tag: "ThreadCreated",
            threadId,
          })
          break
        }
      }
      expect(creationCompleted).toBe(true)
      const input = {
        ...command("server-owned-submit", "1"),
        command: {
          _tag: "SubmitPrompt",
          threadId,
          commandId: CommandId.make("server-owned-submit"),
          idempotencyKey: IdempotencyKey.make("server-owned-submit-key"),
          expectedThreadVersion: ThreadVersion.make("1"),
          text: "continue after the socket closes",
          submissionId: "submission-1",
        },
      }
      yield* protocol.admitCommand(input)

      let completed: Effect.Success<ReturnType<typeof protocol.admitCommand>>["command"] | undefined
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* TestClock.adjust("250 millis")
        yield* Effect.yieldNow
        const current = yield* protocol.admitCommand(input)
        if (current.command.state === "completed") {
          completed = current.command
          break
        }
      }
      expect(completed).toMatchObject({
        state: "completed",
        result: { _tag: "PromptAdmitted", status: "accepted" },
        cursor: "1",
      })
      expect(completionAttempts).toBe(2)
      expect(admissionAttempts).toBe(2)
      expect(admittedEffects).toEqual(new Set(["server-owned-submit"]))
      expect(admittedTurnIds).toEqual(new Set([input.turnId]))
      const replay = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        includeSnapshot: false,
        limit: 100,
      })
      expect(replay.events).toMatchObject([
        {
          event: { _tag: "SubmissionAdmitted", submissionId: "submission-1" },
        },
      ])
    }),
  ),
)

it.effect.skipIf(!live)("lets command cancellation finish before a delayed prompt application", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const authority = yield* HostedClientAuthority
      const releasePrompt = yield* Deferred.make<void>()
      const cancelledPrompts = new Set<string>()
      const admittedPrompts = new Set<string>()
      const product: HostedProductService = {
        ready: Effect.void,
        projects: () => Effect.die("unused"),
        createProject: () => Effect.die("unused"),
        createConnection: () => Effect.die("unused"),
        registerRunner: () => Effect.die("unused"),
        setRemoteThreadCreation: () => Effect.die("unused"),
        pollRunner: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
        admitAuthorizedRun: (input) =>
          Deferred.await(releasePrompt).pipe(
            Effect.map(() => {
              if (cancelledPrompts.has(input.operationKey))
                return {
                  _tag: "Cancelled" as const,
                  commandId: input.operationKey,
                }
              admittedPrompts.add(input.operationKey)
              return {
                _tag: "Admitted" as const,
                commandId: input.operationKey,
                turnId: `turn-${input.operationKey}`,
                status: "accepted" as const,
              }
            }),
          ),
        cancelRunAdmission: () => Effect.die("unused"),
        cancelAuthorizedRunAdmission: (input) => {
          const cancellation: Parameters<ThreadProtocolStore["Service"]["cancelPrompt"]>[0] = {
            ownerId: input.authority.ownerId,
            threadId: ThreadId.make(input.threadId),
            cancelCommandId: CommandId.make(input.cancelCommandId),
            targetCommandId: CommandId.make(input.targetCommandId),
            actor: input.authority.actor,
            cancelledAt: later,
          }
          if (input.claimToken !== undefined) Object.assign(cancellation, { claimToken: input.claimToken })
          return protocol.cancelPrompt(cancellation).pipe(
            Effect.orDie,
            Effect.tap(() => Effect.sync(() => cancelledPrompts.add(input.targetCommandId))),
            Effect.map((resolution) => (resolution._tag === "Turn" ? { turnId: String(resolution.turnId) } : {})),
          )
        },
        authorizeOwner: () => Effect.die("unused"),
        authorizeThread: () => Effect.die("unused"),
        threadExecutionContext: () => Effect.die("unused"),
        activatePrincipal: () => Effect.die("unused"),
      }
      const operations: HostedThreadApplicationService = {
        threads: () => Effect.die("unused"),
        preview: () => Effect.die("unused"),
        thread: () => Effect.die("unused"),
        interactive: () => Effect.die("unused"),
        snapshot: () => Effect.succeed(snapshot),
        projectionCommitted: () => Effect.die("unused"),
      }
      yield* Layer.build(
        hostedThreadCommandWorkerLayer({
          claimMillis: 10_000,
          fallbackIntervalMillis: 250,
          concurrency: 2,
        }).pipe(
          Layer.provide(hostedWorkerRuntimeLayerTest),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ThreadProtocolStore, protocol),
              Layer.succeed(HostedClientAuthority, authority),
              Layer.succeed(HostedProduct, product),
              Layer.succeed(HostedThreadApplication, operations),
              Layer.succeed(
                HostedWorkspace,
                HostedWorkspace.of({
                  execute: () => Effect.die("unused"),
                  pause: () => Effect.die("unused"),
                  resume: () => Effect.die("unused"),
                  portal: () => Effect.die("unused"),
                }),
              ),
              Layer.succeed(HostedToolPolicy, testToolPolicy),
              BunCrypto.layer,
            ),
          ),
        ),
      )
      const submit = {
        ...command("delayed-submit", "0"),
        command: {
          _tag: "SubmitPrompt",
          threadId,
          commandId: CommandId.make("delayed-submit"),
          idempotencyKey: IdempotencyKey.make("delayed-submit-key"),
          expectedThreadVersion: ThreadVersion.make("0"),
          text: "must remain cancelled",
          submissionId: "submission-1",
        },
      }
      const cancel = {
        ...command("cancel-delayed-submit", "1"),
        command: {
          _tag: "Cancel",
          threadId,
          commandId: CommandId.make("cancel-delayed-submit"),
          idempotencyKey: IdempotencyKey.make("cancel-delayed-submit-key"),
          expectedThreadVersion: ThreadVersion.make("1"),
          target: {
            _tag: "Command",
            commandId: CommandId.make("delayed-submit"),
          },
        },
      }
      yield* protocol.admitCommand(submit)
      yield* protocol.admitCommand(cancel)

      let cancelled = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* TestClock.adjust("250 millis")
        yield* Effect.yieldNow
        if ((yield* protocol.admitCommand(cancel)).command.state === "completed") {
          cancelled = true
          break
        }
      }
      expect(cancelled).toBe(true)
      expect(cancelledPrompts).toEqual(new Set(["delayed-submit"]))
      yield* Deferred.succeed(releasePrompt, undefined)

      let submitCompleted = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* TestClock.adjust("250 millis")
        yield* Effect.yieldNow
        if ((yield* protocol.admitCommand(submit)).command.state === "completed") {
          submitCompleted = true
          break
        }
      }
      expect(submitCompleted).toBe(true)
      expect(admittedPrompts).toEqual(new Set())
      const replay = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        includeSnapshot: false,
        limit: 100,
      })
      expect(replay.events).toMatchObject([
        {
          event: {
            _tag: "ExecutionControlled",
            action: "cancelled",
            agentResponseArrived: false,
          },
        },
      ])
    }),
  ),
)

it.effect.skipIf(!live)("resets compacted replica gaps and pushes contiguous events after listener recovery", () =>
  withDatabase((pool, url) =>
    Effect.gen(function* () {
      const protocolStore = yield* setup(pool)
      const db = drizzle({ client: pool })
      let currentSnapshot: HostedThreadSnapshot = snapshot
      const product: HostedProductService = {
        ready: Effect.void,
        projects: () => Effect.succeed([]),
        createProject: () => Effect.die("unused"),
        activatePrincipal: () => Effect.void,
        createConnection: () => Effect.die("unused"),
        authorizeOwner: () => Effect.die("unused"),
        authorizeThread: () => Effect.succeed({ ownerId, actor }),
        threadExecutionContext: () => Effect.die("unused"),
        registerRunner: () => Effect.die("unused"),
        setRemoteThreadCreation: () => Effect.die("unused"),
        pollRunner: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
        admitAuthorizedRun: () => Effect.die("unused"),
        cancelRunAdmission: () => Effect.die("unused"),
        cancelAuthorizedRunAdmission: () => Effect.die("unused"),
      }
      const operations: HostedThreadApplicationService = {
        threads: () => Effect.die("unused"),
        preview: () => Effect.die("unused"),
        thread: () => Effect.succeed(currentSnapshot.view.thread),
        snapshot: () => Effect.succeed(currentSnapshot),
        interactive: () => Effect.die("unused"),
        projectionCommitted: () => Effect.die("unused"),
      }
      const dependencies = Layer.mergeAll(
        Layer.succeed(HostedProduct, product),
        Layer.succeed(HostedThreadApplication, operations),
        Layer.succeed(
          HostedWorkspace,
          HostedWorkspace.of({
            execute: () => Effect.die("unused"),
            pause: () => Effect.die("unused"),
            resume: () => Effect.die("unused"),
            portal: () => Effect.die("unused"),
          }),
        ),
        Layer.succeed(ThreadProtocolStore, protocolStore),
        Layer.succeed(HostedToolPolicy, testToolPolicy),
        BunCrypto.layer,
      )
      const replica = () =>
        Layer.build(
          hostedThreadProtocolLayerWithOptions({
            databaseUrl: Redacted.make(url),
          }).pipe(Layer.provide(dependencies)),
        ).pipe(Effect.map((context) => Context.get(context, HostedThreadProtocol)))
      const [replicaA, replicaB] = yield* Effect.all([replica(), replica()], {
        concurrency: "unbounded",
      })
      const principal = { userId, clientId, deviceId }
      const open = (protocol: HostedThreadProtocol["Service"], requestId: string) =>
        Effect.gen(function* () {
          const ticket = yield* protocol.issueTicket(principal)
          const connection = yield* protocol.connect(ticket.ticket, threadWebSocketAudience)
          expect(
            yield* connection.receive({
              protocolVersion,
              requestId: RequestId.make(requestId),
              command: {
                _tag: "AttachThread",
                threadId,
                afterCursor: ThreadEventCursor.make("0"),
              },
            }),
          ).toMatchObject([{ payload: { _tag: "ThreadAttached", cursor: "0" } }])
          return connection
        })
      const [connectionA, connectionB] = yield* Effect.all([open(replicaA, "replica-a"), open(replicaB, "replica-b")], {
        concurrency: "unbounded",
      })
      const listenerPids = Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const listeners = yield* Effect.tryPromise(() =>
            pool.query(
              `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN rika_thread_protocol'`,
            ),
          )
          if (listeners.rows.length === 2) return listeners.rows.map((row) => Number(row.pid))
          yield* TestClock.adjust("25 millis")
        }
        return yield* Effect.die("Thread protocol listeners did not become ready")
      })
      const initialListeners = yield* listenerPids
      const publish = (updatedAt: number) =>
        Effect.gen(function* () {
          currentSnapshot = {
            ...currentSnapshot,
            view: {
              ...currentSnapshot.view,
              thread: { ...currentSnapshot.view.thread, updatedAt },
              revision: updatedAt,
            },
          }
          const appended = yield* protocolStore.appendEvents({
            ownerId,
            threadId,
            events: [{ _tag: "ThreadViewSnapshot", snapshot: currentSnapshot.view }],
            createdAt: later,
          })
          yield* protocolStore.saveSnapshot({
            ownerId,
            threadId,
            threadVersion: appended[0]!.threadVersion,
            cursor: appended[0]!.cursor,
            snapshot: currentSnapshot,
            createdAt: later,
          })
        })
      const eventCursors = (frames: ReadonlyArray<ServerFrame>) =>
        frames.flatMap((frame) => (frame.payload._tag === "ThreadEvent" ? [String(frame.payload.event.cursor)] : []))
      yield* publish(2)
      expect(eventCursors(yield* connectionA.outbound)).toEqual(["1"])
      expect(
        yield* connectionA.receive({
          protocolVersion,
          requestId: RequestId.make("replica-a-ack"),
          command: {
            _tag: "AcknowledgeCursor",
            threadId,
            cursor: ThreadEventCursor.make("1"),
          },
        }),
      ).toMatchObject([{ payload: { _tag: "CommandAccepted", cursor: "1" } }])
      const eventCounts = yield* Effect.tryPromise(() =>
        db
          .select({ value: count() })
          .from(rikaHostedThreadProtocolEvents)
          .where(eq(rikaHostedThreadProtocolEvents.threadId, threadId)),
      )
      expect(eventCounts[0]?.value).toBe(0)
      expect(yield* connectionB.outbound).toMatchObject([
        {
          payload: {
            _tag: "ThreadSnapshot",
            cursor: "1",
            snapshot: currentSnapshot,
          },
        },
      ])
      yield* Effect.tryPromise(() =>
        pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY($1::int[])`, [
          initialListeners,
        ]),
      )
      yield* TestClock.adjust("1 second")
      let recoveredListeners: ReadonlyArray<number> = []
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const listeners = yield* Effect.tryPromise(() =>
          pool.query(
            `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN rika_thread_protocol'`,
          ),
        )
        recoveredListeners = listeners.rows.map((row) => Number(row.pid))
        if (recoveredListeners.length === 2 && recoveredListeners.every((pid) => !initialListeners.includes(pid))) break
        yield* TestClock.adjust("25 millis")
      }
      expect(recoveredListeners).toHaveLength(2)
      expect(recoveredListeners.every((pid) => !initialListeners.includes(pid))).toBe(true)
      yield* publish(3)
      const second = yield* Effect.all([connectionA.outbound, connectionB.outbound], { concurrency: "unbounded" })
      expect(second.map(eventCursors)).toEqual([["2"], ["2"]])
    }),
  ),
)

it.effect.skipIf(!live)("converges duplicate, reordered, and delayed replica frames with durable decisions", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocolStore = yield* setup(pool)
      const db = drizzle({ client: pool })
      const checkpoint = {
        version: ExecutionProjection.projectionVersion,
        cursor: "authorization-cursor",
        state: '{"operation":"shell","arguments":"bun test"}',
      }
      let currentSnapshot: HostedThreadSnapshot = snapshot
      const effects: Array<InteractiveCommand> = []
      const runs: Array<Pick<Parameters<HostedProductService["admitRun"]>[0], "threadId" | "operationKey" | "prompt">> =
        []
      const product: HostedProductService = {
        ready: Effect.void,
        projects: () => Effect.succeed([]),
        createProject: () => Effect.die("unused"),
        activatePrincipal: () => Effect.void,
        createConnection: () => Effect.die("unused"),
        authorizeOwner: () => Effect.die("unused"),
        authorizeThread: () => Effect.succeed({ ownerId, actor }),
        threadExecutionContext: () =>
          Effect.succeed({
            workspaceId: "workspace-protocol",
            repository: {
              repositoryId: "repository-1",
              owner: "In-Time-Tec",
              name: "rika",
              branch: "feature/thread-controls",
            },
            branch: "feature/thread-controls",
            executor: {
              assignmentId,
              kind: "orb",
              generation: "7",
              lifecycle: "active",
              executorInstanceId: "executor-1",
            },
          }),
        registerRunner: () => Effect.die("unused"),
        setRemoteThreadCreation: () => Effect.die("unused"),
        pollRunner: () => Effect.die("unused"),
        admitRun: (input) =>
          Effect.sync(() => {
            if (!runs.some((run) => run.operationKey === input.operationKey)) runs.push(input)
            return {
              _tag: "Admitted" as const,
              commandId: input.operationKey,
              turnId: `turn-${input.operationKey}`,
              status: "queued" as const,
            }
          }),
        admitAuthorizedRun: (input) =>
          Effect.sync(() => {
            if (!runs.some((run) => run.operationKey === input.operationKey))
              runs.push({ threadId: input.threadId, operationKey: input.operationKey, prompt: input.prompt })
          }).pipe(Effect.andThen(completeMockPrompt(protocolStore, input, "queued", currentSnapshot))),
        cancelRunAdmission: () => Effect.die("unused"),
        cancelAuthorizedRunAdmission: () => Effect.die("unused"),
      }
      const operations: HostedThreadApplicationService = {
        threads: () => Effect.die("unused"),
        preview: () => Effect.die("unused"),
        thread: () => Effect.succeed(currentSnapshot.view.thread),
        snapshot: () => Effect.succeed(currentSnapshot),
        projectionCommitted: () => Effect.die("unused"),
        interactive: (input, persist) =>
          Effect.suspend(() => {
            effects.push(input.command)
            if (input.command._tag === "ApproveAuthorization" || input.command._tag === "DenyAuthorization") {
              currentSnapshot = {
                ...currentSnapshot,
                pendingAuthorizations: [],
              }
              return persist({ events: [], snapshot: currentSnapshot })
            }
            return persist({
              events: [
                {
                  _tag: "ExecutionControlled" as const,
                  action: "cancelled" as const,
                },
              ],
              snapshot: currentSnapshot,
            })
          }),
      }
      const dependencies = Layer.mergeAll(
        Layer.succeed(HostedProduct, product),
        Layer.succeed(HostedThreadApplication, operations),
        Layer.succeed(
          HostedWorkspace,
          HostedWorkspace.of({
            execute: () => Effect.die("unused"),
            pause: () => Effect.void,
            resume: () => Effect.void,
            portal: () => Effect.die("unused"),
          }),
        ),
        Layer.succeed(ThreadProtocolStore, protocolStore),
        Layer.succeed(HostedToolPolicy, testToolPolicy),
        BunCrypto.layer,
      )
      yield* Layer.build(
        hostedThreadCommandWorkerLayer({
          claimMillis: 10_000,
          fallbackIntervalMillis: 250,
          concurrency: 8,
        }).pipe(Layer.provide(hostedWorkerRuntimeLayerTest), Layer.provide(dependencies)),
      )
      const protocols = yield* Effect.all(
        [
          Layer.build(hostedThreadProtocolLayer.pipe(Layer.provide(dependencies))),
          Layer.build(hostedThreadProtocolLayer.pipe(Layer.provide(dependencies))),
        ].map((builtLayer) => builtLayer.pipe(Effect.map((context) => Context.get(context, HostedThreadProtocol)))),
        { concurrency: "unbounded" },
      )
      const protocolA = protocols[0]!
      const protocolB = protocols[1]!
      const principal = { userId, clientId, deviceId }
      const open = (protocol: HostedThreadProtocol["Service"]) =>
        Effect.gen(function* () {
          const ticket = yield* protocol.issueTicket(principal)
          return yield* protocol.connect(ticket.ticket, threadWebSocketAudience)
        })
      const [controllerA, controllerB] = yield* Effect.all([open(protocolA), open(protocolB)], {
        concurrency: "unbounded",
      })
      const awaitCompletion = Effect.fn("ThreadProtocolStoreLiveTest.awaitCompletion")(function* (
        session: typeof controllerA,
        message: Parameters<typeof controllerA.receive>[0],
      ) {
        let response = yield* session.receive(message)
        for (let attempt = 0; attempt < 40 && response[0]?.payload._tag === "CommandAdmitted"; attempt += 1) {
          yield* TestClock.adjust("250 millis")
          yield* Effect.yieldNow
          response = yield* session.receive({
            ...message,
            requestId: RequestId.make(`${message.requestId}:${attempt}`),
          })
        }
        return response
      })
      for (const [session, requestId] of [
        [controllerA, "attach-a"],
        [controllerB, "attach-b"],
      ] as const)
        expect(
          yield* session.receive({
            protocolVersion,
            requestId: RequestId.make(requestId),
            command: {
              _tag: "AttachThread",
              threadId,
              afterCursor: ThreadEventCursor.make("0"),
            },
          }),
        ).toMatchObject([
          {
            payload: {
              _tag: "ThreadAttached",
              threadVersion: "0",
              cursor: "0",
              events: [],
              participants: [{ status: "viewing" }],
            },
          },
        ])

      const duplicate = {
        protocolVersion,
        requestId: RequestId.make("duplicate-a"),
        command: {
          _tag: "SubmitPrompt" as const,
          threadId,
          commandId: CommandId.make("duplicate-submit"),
          idempotencyKey: IdempotencyKey.make("duplicate-submit-key"),
          expectedThreadVersion: ThreadVersion.make("0"),
          text: "queue once",
        },
      }
      const duplicateResponses = yield* Effect.all(
        [
          controllerA.receive(duplicate),
          controllerB.receive({
            ...duplicate,
            requestId: RequestId.make("duplicate-b"),
          }),
        ],
        { concurrency: "unbounded" },
      )
      expect(
        duplicateResponses
          .flat()
          .filter((frame) => frame.payload._tag === "CommandAdmitted" || frame.payload._tag === "CommandRejected"),
      ).toHaveLength(2)
      expect(yield* awaitCompletion(controllerA, duplicate)).toMatchObject([
        {
          payload: {
            _tag: "CommandAccepted",
            threadVersion: "1",
            cursor: "1",
          },
        },
      ])
      expect(runs.filter((input) => input.operationKey === "duplicate-submit")).toHaveLength(1)
      expect(
        yield* controllerA.receive({
          ...duplicate,
          requestId: RequestId.make("duplicate-after-completion"),
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "CommandAccepted",
            threadVersion: "1",
            cursor: "1",
          },
        },
      ])
      expect(
        yield* controllerA.receive({
          ...duplicate,
          requestId: RequestId.make("duplicate-payload-mismatch"),
          command: { ...duplicate.command, text: "changed payload" },
        }),
      ).toMatchObject([{ payload: { _tag: "CommandRejected", reason: "conflict" } }])
      expect(effects).toHaveLength(0)

      const contender = (id: string, requestId: string) => ({
        protocolVersion,
        requestId: RequestId.make(requestId),
        command: {
          _tag: "SubmitPrompt" as const,
          threadId,
          commandId: CommandId.make(id),
          idempotencyKey: IdempotencyKey.make(`${id}-key`),
          expectedThreadVersion: ThreadVersion.make("1"),
          text: id,
        },
      })
      const contenders = [
        contender("controller-a", "controller-a-request"),
        contender("controller-b", "controller-b-request"),
      ]
      const raced = yield* Effect.all([controllerA.receive(contenders[0]!), controllerB.receive(contenders[1]!)], {
        concurrency: "unbounded",
      })
      const racedPayloads = raced.flat().map((frame) => frame.payload)
      expect(racedPayloads.filter((payload) => payload._tag === "CommandAdmitted")).toHaveLength(1)
      const stale = racedPayloads.find((payload) => payload._tag === "CommandRejected")
      expect(stale).toMatchObject({
        _tag: "CommandRejected",
        reason: "stale-version",
        currentThreadVersion: "2",
      })
      expect(["1", "2"]).toContain(stale?.currentCursor)
      const staleIndex = stale?.requestId === "controller-a-request" ? 0 : 1
      const delayed = contenders[staleIndex]!
      const delayedSession = staleIndex === 0 ? controllerA : controllerB
      expect(
        yield* awaitCompletion(delayedSession, {
          ...delayed,
          requestId: RequestId.make("delayed-resync"),
          command: {
            ...delayed.command,
            expectedThreadVersion: ThreadVersion.make("2"),
          },
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "CommandAccepted",
            threadVersion: "3",
            cursor: "3",
          },
        },
      ])
      expect(
        runs.filter((input) => input.operationKey === "controller-a" || input.operationKey === "controller-b"),
      ).toHaveLength(2)

      currentSnapshot = {
        ...currentSnapshot,
        pendingAuthorizations: [
          {
            threadId,
            turnId: TurnId.make("approval-turn"),
            authorizationId: "authorization-1",
            operation: "shell",
            capability: "process",
            input: "bun test",
            inputTruncated: false,
            checkpoint,
          },
        ],
      }
      yield* protocolStore.checkpoint({
        ownerId,
        threadId,
        threadVersion: ThreadVersion.make("3"),
        cursor: ThreadEventCursor.make("3"),
        snapshot: currentSnapshot,
        createdAt: later,
      })
      const approvalController = yield* open(protocolA)
      expect(
        yield* approvalController.receive({
          protocolVersion,
          requestId: RequestId.make("approval-attach"),
          command: {
            _tag: "AttachThread",
            threadId,
            afterCursor: ThreadEventCursor.make("3"),
          },
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "ThreadAttached",
            threadVersion: "3",
            cursor: "3",
            checkpoint: {
              cursor: "3",
              snapshot: {
                pendingAuthorizations: [
                  {
                    authorizationId: "authorization-1",
                    turnId: "approval-turn",
                  },
                ],
              },
            },
            events: [],
            participants: expect.any(Array),
          },
        },
      ])
      const approval = {
        protocolVersion,
        requestId: RequestId.make("approval-request"),
        command: {
          _tag: "Approve" as const,
          threadId,
          commandId: CommandId.make("approval-command"),
          idempotencyKey: IdempotencyKey.make("approval-key"),
          expectedThreadVersion: ThreadVersion.make("3"),
          turnId: TurnId.make("approval-turn"),
          authorizationId: "authorization-1",
          checkpoint,
        },
      }
      expect(yield* awaitCompletion(approvalController, approval)).toMatchObject([
        {
          payload: {
            _tag: "CommandAccepted",
            threadVersion: "4",
            result: { _tag: "Applied" },
          },
        },
      ])
      expect(
        yield* approvalController.receive({
          ...approval,
          requestId: RequestId.make("approval-retry"),
        }),
      ).toMatchObject([{ payload: { _tag: "CommandAccepted", threadVersion: "4" } }])
      expect(
        effects.filter((input) => input._tag === "ApproveAuthorization" && input.authorizationId === "authorization-1"),
      ).toHaveLength(1)

      currentSnapshot = {
        ...currentSnapshot,
        pendingAuthorizations: [
          {
            threadId: ThreadId.make("cross-thread"),
            turnId: approval.command.turnId,
            authorizationId: approval.command.authorizationId,
            operation: "shell",
            capability: "process",
            input: "bun test",
            inputTruncated: false,
            checkpoint,
          },
        ],
      }
      expect(
        yield* awaitCompletion(approvalController, {
          ...approval,
          requestId: RequestId.make("cross-thread-approval"),
          command: {
            ...approval.command,
            commandId: CommandId.make("cross-thread-approval"),
            idempotencyKey: IdempotencyKey.make("cross-thread-approval-key"),
            expectedThreadVersion: ThreadVersion.make("4"),
          },
        }),
      ).toMatchObject([{ payload: { _tag: "CommandRejected", reason: "conflict" } }])
      expect(effects.filter((input) => input._tag === "ApproveAuthorization")).toHaveLength(1)

      const denialCheckpoint = { ...checkpoint, cursor: "denial-cursor" }
      currentSnapshot = {
        ...currentSnapshot,
        pendingAuthorizations: [
          {
            threadId,
            turnId: TurnId.make("denial-turn"),
            authorizationId: "authorization-2",
            operation: "write-file",
            capability: "filesystem",
            input: '{"path":"README.md"}',
            inputTruncated: false,
            checkpoint: denialCheckpoint,
          },
        ],
      }
      expect(
        yield* awaitCompletion(approvalController, {
          protocolVersion,
          requestId: RequestId.make("denial-request"),
          command: {
            _tag: "Deny",
            threadId,
            commandId: CommandId.make("denial-command"),
            idempotencyKey: IdempotencyKey.make("denial-key"),
            expectedThreadVersion: ThreadVersion.make("5"),
            turnId: TurnId.make("denial-turn"),
            authorizationId: "authorization-2",
            checkpoint: denialCheckpoint,
          },
        }),
      ).toMatchObject([{ payload: { _tag: "CommandAccepted", threadVersion: "6" } }])
      expect(
        effects.filter((input) => input._tag === "DenyAuthorization" && input.authorizationId === "authorization-2"),
      ).toHaveLength(1)

      const audit = yield* Effect.tryPromise(() =>
        db
          .select({
            actor: rikaHostedThreadProtocolCommands.actor,
            command: rikaHostedThreadProtocolCommands.command,
            result: rikaHostedThreadProtocolCommands.result,
          })
          .from(rikaHostedThreadProtocolCommands)
          .where(eq(rikaHostedThreadProtocolCommands.commandId, "approval-command")),
      )
      expect(audit).toMatchObject([
        {
          actor,
          command: {
            _tag: "Approve",
            turnId: "approval-turn",
            authorizationId: "authorization-1",
            checkpoint,
          },
          result: { _tag: "Applied" },
        },
      ])
      const denialAudit = yield* Effect.tryPromise(() =>
        db
          .select({ result: rikaHostedThreadProtocolCommands.result })
          .from(rikaHostedThreadProtocolCommands)
          .where(eq(rikaHostedThreadProtocolCommands.commandId, "denial-command")),
      )
      expect(denialAudit).toMatchObject([
        {
          result: { _tag: "Applied" },
        },
      ])

      yield* protocolStore.saveSnapshot({
        ownerId,
        threadId,
        threadVersion: ThreadVersion.make("6"),
        cursor: ThreadEventCursor.make("3"),
        snapshot: currentSnapshot,
        createdAt: later,
      })
      const replayCommandId = CommandId.make("cursor-replay-command")
      const replayIdempotencyKey = IdempotencyKey.make("cursor-replay-key")
      yield* protocolStore.admitCommand({
        ownerId,
        threadId,
        actor,
        commandId: replayCommandId,
        turnId: TurnId.make("turn-cursor-replay-command"),
        idempotencyKey: replayIdempotencyKey,
        expectedThreadVersion: ThreadVersion.make("6"),
        command: {
          _tag: "SubmitPrompt",
          threadId,
          commandId: replayCommandId,
          idempotencyKey: replayIdempotencyKey,
          expectedThreadVersion: "6",
          text: "exercise cursor replay",
        },
        admittedAt: later,
      })
      const replayClaimToken = "cursor-replay-claim"
      expect(
        yield* protocolStore.claimNextCommand({
          claimToken: replayClaimToken,
          claimMillis: 60_000,
        }),
      ).toMatchObject({ commandId: replayCommandId })
      yield* protocolStore.completeCommand({
        ownerId,
        threadId,
        commandId: replayCommandId,
        claimToken: replayClaimToken,
        result: { _tag: "PromptAdmitted", status: "accepted" },
        events: Array.from({ length: 1_002 }, () => ({
          _tag: "ExecutionControlled" as const,
          action: "cancelled" as const,
        })),
        completedAt: later,
      })
      yield* Effect.tryPromise(() =>
        db
          .delete(rikaHostedThreadProtocolSnapshots)
          .where(
            and(
              eq(rikaHostedThreadProtocolSnapshots.threadId, threadId),
              gt(rikaHostedThreadProtocolSnapshots.cursor, 3),
            ),
          ),
      )
      const replayController = yield* open(protocolB)
      const replay = yield* replayController.receive({
        protocolVersion,
        requestId: RequestId.make("replay-attach"),
        command: {
          _tag: "AttachThread",
          threadId,
          afterCursor: ThreadEventCursor.make("0"),
        },
      })
      expect(replay).toHaveLength(1)
      const attachedReplay = replay[0]!.payload
      expect(attachedReplay).toMatchObject({
        _tag: "ThreadAttached",
        baseCursor: "3",
        checkpoint: { cursor: "3" },
        threadVersion: "7",
        cursor: "1005",
        participants: expect.any(Array),
      })
      if (attachedReplay._tag !== "ThreadAttached") throw new Error("expected ThreadAttached")
      expect(attachedReplay.events).toHaveLength(1_002)
      expect(attachedReplay.events[0]?.cursor).toBe("4")
      expect(attachedReplay.events.at(-1)?.cursor).toBe("1005")
      expect(
        (yield* replayController.receive({
          protocolVersion,
          requestId: RequestId.make("large-replay-ack"),
          command: {
            _tag: "AcknowledgeCursor",
            threadId,
            cursor: ThreadEventCursor.make("1005"),
          },
        }))[0]?.payload,
      ).toMatchObject({ _tag: "CommandAccepted", cursor: "1005" })

      yield* protocolStore.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: later,
      })
      yield* Effect.tryPromise(() =>
        db
          .delete(rikaHostedThreadProtocolSnapshots)
          .where(
            and(
              eq(rikaHostedThreadProtocolSnapshots.threadId, threadId),
              gt(rikaHostedThreadProtocolSnapshots.cursor, 3),
            ),
          ),
      )
      const appendOnlyReplay = yield* replayController.receive({
        protocolVersion,
        requestId: RequestId.make("append-only-replay"),
        command: {
          _tag: "AttachThread",
          threadId,
          afterCursor: ThreadEventCursor.make("1005"),
        },
      })
      expect(appendOnlyReplay).toHaveLength(1)
      const appendOnlyAttachment = appendOnlyReplay[0]!.payload
      expect(appendOnlyAttachment).toMatchObject({
        _tag: "ThreadAttached",
        baseCursor: "1005",
        cursor: "1006",
        events: [{ cursor: "1006" }],
      })
      if (appendOnlyAttachment._tag !== "ThreadAttached") throw new Error("expected ThreadAttached")

      const duplicateControl = {
        protocolVersion,
        requestId: RequestId.make("duplicate-control-a"),
        command: {
          _tag: "Cancel" as const,
          threadId,
          commandId: CommandId.make("duplicate-control"),
          idempotencyKey: IdempotencyKey.make("duplicate-control-key"),
          expectedThreadVersion: ThreadVersion.make("7"),
          target: {
            _tag: "Turn" as const,
            turnId: TurnId.make("denial-turn"),
          },
        },
      }
      const duplicateControlResponses = yield* Effect.all(
        [
          controllerA.receive(duplicateControl),
          controllerB.receive({
            ...duplicateControl,
            requestId: RequestId.make("duplicate-control-b"),
          }),
        ],
        { concurrency: "unbounded" },
      )
      const duplicateControlFrames = duplicateControlResponses.flat()
      expect(duplicateControlFrames.filter((frame) => frame.payload._tag === "CommandAdmitted")).toHaveLength(2)
      expect(yield* awaitCompletion(controllerA, duplicateControl)).toMatchObject([
        { payload: { _tag: "CommandAccepted", threadVersion: "8" } },
      ])

      const durableInteractiveCommands = [
        {
          _tag: "EditQueued" as const,
          commandId: CommandId.make("edit-queued-command"),
          idempotencyKey: IdempotencyKey.make("edit-queued-key"),
          expectedThreadVersion: ThreadVersion.make("8"),
          turnId: TurnId.make("queued-turn"),
          prompt: "rewritten prompt",
        },
        {
          _tag: "Dequeue" as const,
          commandId: CommandId.make("dequeue-command"),
          idempotencyKey: IdempotencyKey.make("dequeue-key"),
          expectedThreadVersion: ThreadVersion.make("9"),
          turnId: TurnId.make("queued-turn"),
        },
        {
          _tag: "ArchiveThread" as const,
          commandId: CommandId.make("archive-command"),
          idempotencyKey: IdempotencyKey.make("archive-key"),
          expectedThreadVersion: ThreadVersion.make("10"),
        },
      ]
      for (const durableCommand of durableInteractiveCommands)
        expect(
          yield* awaitCompletion(controllerA, {
            protocolVersion,
            requestId: RequestId.make(`${durableCommand._tag}-request`),
            command: { ...durableCommand, threadId },
          }),
        ).toMatchObject([
          {
            payload: {
              _tag: "CommandAccepted",
              threadVersion: String(BigInt(durableCommand.expectedThreadVersion) + 1n),
              result: { _tag: "Applied" },
            },
          },
        ])
      expect(effects.slice(-3)).toMatchObject([
        { _tag: "EditQueued", turnId: "queued-turn", prompt: "rewritten prompt" },
        { _tag: "Dequeue", turnId: "queued-turn" },
        { _tag: "ArchiveThread" },
      ])
    }),
  ),
)

it.effect.skipIf(!live)("revokes organization authority without revoking the same client's personal authority", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const db = drizzle({ client: pool })
      const aggregateDatabase = yield* PgDrizzle.makeWithDefaults()
      const authority = yield* HostedClientAuthority
      const presence = yield* HostedPresence
      const organizationId = OrganizationId.make("protocol-organization")
      const membershipId = BetterAuthMemberId.make("protocol-membership")
      const organizationOwnerId = OwnerId.make("protocol-organization-owner")
      const organizationWorkspaceId = WorkspaceId.make("protocol-organization-workspace")
      const organizationThreadId = ThreadId.make("protocol-organization-thread")
      const organizationActor = {
        _tag: "OrganizationActor" as const,
        owner: { _tag: "OrganizationOwner" as const, organizationId },
        userId,
        membershipId,
        clientId,
        deviceId,
      }
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        db.insert(identityOrganization).values({
          id: organizationId,
          name: "Protocol",
          slug: "protocol",
          createdAt,
        }),
      )
      yield* Effect.tryPromise(() =>
        db.insert(identityMember).values({
          id: membershipId,
          organizationId,
          userId,
          role: "owner",
          createdAt,
        }),
      )
      yield* aggregateDatabase.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(rikaHostedOwners).values({ id: organizationOwnerId, kind: "organization", organizationId })
          yield* tx.insert(rikaHostedOwnerCounters).values({ ownerId: organizationOwnerId })
          yield* tx.insert(rikaHostedWorkspaces).values({
            id: organizationWorkspaceId,
            ownerId: organizationOwnerId,
            projectId: null,
            createdByUserId: userId,
            executorKind: "runner",
            inheritProjectGrants: false,
            createdAt,
          })
          yield* tx
            .insert(rikaWorkspaces)
            .values({ ownerId: organizationOwnerId, path: organizationWorkspaceId, createdAt: 1 })
          yield* tx.insert(rikaHostedThreads).values({
            id: organizationThreadId,
            ownerId: organizationOwnerId,
            projectId: null,
            workspaceId: organizationWorkspaceId,
            createdByUserId: userId,
            executorKind: "runner",
            inheritProjectGrants: false,
            createdAt,
          })
          yield* tx.insert(rikaThreads).values({
            id: organizationThreadId,
            ownerId: organizationOwnerId,
            workspace: organizationWorkspaceId,
            title: "Organization protocol thread",
            createdAt: 1,
            updatedAt: 1,
          })
        }),
      )
      yield* authority.grantClientAuthority({
        ownerId: organizationOwnerId,
        actor: organizationActor,
        now,
        expiresAt: authorityExpiresAt,
      })
      yield* protocol.initializeThread({
        ownerId: organizationOwnerId,
        threadId: organizationThreadId,
        actor: organizationActor,
      })
      const organizationAdmission = yield* protocol.admitCommand({
        ownerId: organizationOwnerId,
        threadId: organizationThreadId,
        commandId: CommandId.make("organization-command"),
        turnId: TurnId.make("turn-organization-command"),
        idempotencyKey: IdempotencyKey.make("organization-command-key"),
        expectedThreadVersion: ThreadVersion.make("0"),
        actor: organizationActor,
        command: { _tag: "Cancel" },
        admittedAt: now,
      })
      const organizationClaimToken = "organization-claim"
      expect(
        yield* protocol.claimNextCommand({
          claimToken: organizationClaimToken,
          claimMillis: 60_000,
        }),
      ).toMatchObject({
        commandId: organizationAdmission.command.commandId,
      })
      yield* protocol.completeCommand({
        ownerId: organizationOwnerId,
        threadId: organizationThreadId,
        commandId: organizationAdmission.command.commandId,
        claimToken: organizationClaimToken,
        result: { _tag: "Applied" },
        events: [],
        snapshot: {
          ...snapshot,
          view: {
            ...snapshot.view,
            thread: {
              ...snapshot.view.thread,
              id: ProductThreadId.make(organizationThreadId),
              workspace: organizationWorkspaceId,
            },
          },
        },
        completedAt: later,
      })
      yield* presence.upsert({
        ownerId: organizationOwnerId,
        threadId: organizationThreadId,
        actor: organizationActor,
        status: "controlling",
        now,
        expiresAt: presenceExpiresAt,
      })

      yield* Effect.tryPromise(() => db.delete(identityMember).where(eq(identityMember.id, membershipId)))

      const authorityRecords = yield* Effect.tryPromise(() =>
        db
          .select({
            ownerId: rikaHostedClientAuthorities.ownerId,
            revokedAt: rikaHostedClientAuthorities.revokedAt,
          })
          .from(rikaHostedClientAuthorities)
          .where(eq(rikaHostedClientAuthorities.clientId, clientId))
          .orderBy(rikaHostedClientAuthorities.ownerId),
      )
      expect(
        authorityRecords.map(({ ownerId: recordOwnerId, revokedAt }) => ({
          ownerId: recordOwnerId,
          revoked: revokedAt !== null,
        })),
      ).toEqual([
        { ownerId: organizationOwnerId, revoked: true },
        { ownerId, revoked: false },
      ])
      expect(
        yield* protocol
          .replay({
            ownerId: organizationOwnerId,
            threadId: organizationThreadId,
            actor: organizationActor,
            afterCursor: ThreadEventCursor.make("0"),
            limit: 100,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })
      expect(
        yield* protocol
          .admitCommand({
            ownerId: organizationOwnerId,
            threadId: organizationThreadId,
            commandId: CommandId.make("revoked-command"),
            turnId: TurnId.make("turn-revoked-command"),
            idempotencyKey: IdempotencyKey.make("revoked-command-key"),
            expectedThreadVersion: ThreadVersion.make("1"),
            actor: organizationActor,
            command: { _tag: "Cancel" },
            admittedAt: later,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })
      expect(
        yield* presence
          .list({
            ownerId: organizationOwnerId,
            threadId: organizationThreadId,
            actor: organizationActor,
            now: later,
          })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid-authority" },
      })

      const personalReplay = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 100,
      })
      expect(personalReplay).toMatchObject({
        threadVersion: "0",
        cursor: "0",
      })
      yield* presence.upsert({
        ownerId,
        threadId,
        actor,
        status: "viewing",
        now: later,
        expiresAt: presenceExpiresAt,
      })
      expect(yield* presence.list({ ownerId, threadId, actor, now: later })).toHaveLength(1)
    }),
  ),
)
