import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import * as PgClient from "@effect/sql-pg/PgClient"
import { identityMigrations, identityUser, runMigration } from "@rika/identity"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRoute from "@rika/product/execution-route-snapshot"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import { ServerFrame, protocolVersion } from "@rika/product/client-protocol"
import { OwnerId, ThreadEventCursor, ThreadId as HostedThreadId, ThreadVersion } from "@rika/product/hosted-model"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { ThreadId } from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as ProductRepositories from "@rika/product-store/product-repositories"
import { layer as hostedClientAuthorityLayer } from "@rika/product-store/client-authority"
import {
  rikaHostedOwners,
  rikaHostedThreads,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaTurns,
  rikaWorkspaces,
} from "@rika/product-store/database-schema"
import { eq } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import { Config, Context, DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Random, Redacted, Schema } from "effect"
import { Pool } from "pg"
import { live as livePlatform } from "../../support/live-platform"
import { testLayer as hostedModelRegistryTestLayer } from "../../../src/hosted/environment/model-registry"
import { HostedThreadApplication, layer as hostedThreadApplicationLayer } from "../../../src/hosted/thread/application"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const JsonRoute = Schema.fromJsonString(ExecutionRoute.ExecutionRouteSnapshot)
const JsonExecutionLink = Schema.fromJsonString(ExecutionGateway.ExecutionLink)

it.effect.skipIf(databaseUrl === "")("reconstructs a complete owner-scoped hosted projection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_hosted_operations_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      const pool = new Pool({ connectionString: url })
      try {
        for (const migration of [...identityMigrations, ...productMigrations]) {
          const sql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.readFileString(migration.url.pathname),
          )
          yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
        }
        const db = drizzle({ client: pool })
        const createdAt = DateTime.toDate(DateTime.nowUnsafe())
        yield* Effect.tryPromise(() =>
          db.insert(identityUser).values([
            {
              id: "owner-user",
              name: "Owner",
              email: "owner@example.test",
              emailVerified: true,
              createdAt,
              updatedAt: createdAt,
            },
            {
              id: "other-user",
              name: "Other",
              email: "other@example.test",
              emailVerified: true,
              createdAt,
              updatedAt: createdAt,
            },
          ]),
        )
        yield* Effect.tryPromise(() =>
          db.insert(rikaHostedOwners).values([
            { id: "personal-owner", kind: "personal", userId: "owner-user" },
            { id: "other-owner", kind: "personal", userId: "other-user" },
          ]),
        )
        const cancellations: Array<{ readonly runId: string; readonly reason: string }> = []
        const xCancellationEntered = yield* Deferred.make<void>()
        const releaseXCancellation = yield* Deferred.make<void>()
        const yCancellationEntered = yield* Deferred.make<void>()
        const gateway = Context.get(yield* Layer.build(ExecutionGateway.layerTest()), ExecutionGateway.Service)
        const databaseLayer = PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })
        const dependencies = Layer.mergeAll(
          databaseLayer,
          hostedClientAuthorityLayer.pipe(Layer.provide(databaseLayer)),
          BunCrypto.layer,
          Layer.succeed(ExecutionGateway.Service, {
            ...gateway,
            cancelTurn: (link, reason) =>
              Effect.gen(function* () {
                cancellations.push({ runId: link.runId, reason })
                if (link.runId === "authorization-run") {
                  yield* Deferred.succeed(xCancellationEntered, undefined)
                  yield* Deferred.await(releaseXCancellation)
                } else yield* Deferred.succeed(yCancellationEntered, undefined)
                return yield* ExecutionGateway.CancelTurnFailure.make({ message: "Cancellation backend unavailable" })
              }),
          }),
          ExecutionSessionLifecycle.layerTest(),
          hostedModelRegistryTestLayer,
          Layer.succeed(ThreadProtocolStore, {
            initializeThread: () => Effect.die("unused"),
            admitCommand: () => Effect.die("unused"),
            admitServerCommand: () => Effect.die("unused"),
            applyPrompt: () => Effect.die("unused"),
            cancelPrompt: () => Effect.die("unused"),
            claimNextCommand: () => Effect.die("unused"),
            renewCommandClaim: () => Effect.die("unused"),
            releaseCommandClaim: () => Effect.die("unused"),
            completeCommand: () => Effect.die("unused"),
            appendEvents: () => Effect.die("unused"),
            saveSnapshot: () => Effect.die("unused"),
            replay: () => Effect.die("unused"),
            acknowledgeCursor: () => Effect.die("unused"),
            issueTicket: () => Effect.die("unused"),
            redeemTicket: () => Effect.die("unused"),
            revokeTicket: () => Effect.die("unused"),
          }),
        )
        const context = yield* Layer.build(hostedThreadApplicationLayer.pipe(Layer.provideMerge(dependencies)))
        const application = Context.get(context, HostedThreadApplication)
        const aggregateDatabase = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(context))
        yield* aggregateDatabase.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(rikaHostedWorkspaces).values({
              id: "workspace-1",
              ownerId: "personal-owner",
              projectId: null,
              createdByUserId: "owner-user",
              executorKind: "runner",
              inheritProjectGrants: false,
              createdAt,
            })
            yield* tx.insert(rikaWorkspaces).values({ ownerId: "personal-owner", path: "workspace-1", createdAt: 1 })
            yield* tx.insert(rikaHostedThreads).values({
              id: "owner-thread",
              ownerId: "personal-owner",
              projectId: null,
              workspaceId: "workspace-1",
              createdByUserId: "owner-user",
              executorKind: "runner",
              inheritProjectGrants: false,
              createdAt,
            })
            yield* tx.insert(rikaThreads).values({
              id: "owner-thread",
              ownerId: "personal-owner",
              workspace: "workspace-1",
              title: "New thread",
              createdAt: 1,
              updatedAt: 1,
            })
          }),
        )
        const threadId = ThreadId.make("owner-thread")
        const thread = yield* application.thread(OwnerId.make("personal-owner"), threadId)
        expect(thread).toMatchObject({ workspace: "workspace-1", title: "New thread" })
        expect(yield* application.thread(OwnerId.make("other-owner"), threadId)).toBeUndefined()
        yield* aggregateDatabase.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(rikaHostedWorkspaces).values({
              id: "read-only-workspace",
              ownerId: "other-owner",
              projectId: null,
              createdByUserId: "other-user",
              executorKind: "orb",
              inheritProjectGrants: false,
              createdAt,
            })
            yield* tx
              .insert(rikaWorkspaces)
              .values({ ownerId: "other-owner", path: "read-only-workspace", createdAt: 1 })
            yield* tx.insert(rikaHostedThreads).values({
              id: "read-only-thread",
              ownerId: "other-owner",
              projectId: null,
              workspaceId: "read-only-workspace",
              createdByUserId: "other-user",
              executorKind: "orb",
              inheritProjectGrants: false,
              createdAt,
            })
            yield* tx.insert(rikaThreads).values({
              id: "read-only-thread",
              ownerId: "other-owner",
              workspace: "read-only-workspace",
              title: "Read only",
              createdAt: 1,
              updatedAt: 1,
            })
          }),
        )
        const sql = Context.get(context, PgClient.PgClient)
        const snapshot = yield* sql.withTransaction(
          sql`SET TRANSACTION READ ONLY`.pipe(
            Effect.andThen(application.snapshot(OwnerId.make("other-owner"), ThreadId.make("read-only-thread"))),
          ),
        )
        expect(snapshot).toMatchObject({
          executorKind: "orb",
          view: {
            thread: { id: "read-only-thread" },
            turns: [],
            pending: [],
          },
          pendingAuthorizations: [],
        })
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ServerFrame))({
          protocolVersion,
          payload: {
            _tag: "ThreadSnapshot",
            threadId: yield* Schema.decodeEffect(HostedThreadId)("read-only-thread"),
            threadVersion: yield* Schema.decodeEffect(ThreadVersion)("0"),
            cursor: yield* Schema.decodeEffect(ThreadEventCursor)("0"),
            snapshot,
          },
        })
        expect(yield* Schema.decodeEffect(Schema.fromJsonString(ServerFrame))(encoded)).toMatchObject({
          payload: { _tag: "ThreadSnapshot", snapshot },
        })
        const route = ExecutionRoute.testExecutionRoute()
        const turn: Turn.AgentExecutionTurn = {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("authorization-turn"),
          threadId: ThreadId.make("read-only-thread"),
          prompt: "Update the README",
          status: "waiting",
          executionRoute: route,
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          createdAt: 2,
          updatedAt: 3,
        }
        const executionRouteJson = yield* Schema.encodeEffect(JsonRoute)(route)
        yield* Effect.tryPromise(() =>
          db.insert(rikaTurns).values({
            id: turn.id,
            threadId: turn.threadId,
            prompt: turn.prompt,
            status: turn.status,
            createdAt: turn.createdAt,
            updatedAt: turn.updatedAt,
            executionRouteJson,
          }),
        )
        const repositoryContext = yield* Layer.build(
          ProductRepositories.layer(OwnerId.make("other-owner")).pipe(Layer.provide(databaseLayer)),
        )
        const usage = {
          ...ExecutionProjection.emptyUsageState(),
          costNanoUsd: 42,
          tokens: { total: 3, input: { total: 2 }, output: { total: 1 } },
          pricedAttempts: 1,
          countedAttempts: 1,
          sourceComplete: true,
          context: { requestOrdinal: 1, purpose: "conversation" as const, inputTokens: 2 },
          active: { _tag: "Available" as const, accumulatedMillis: 25 },
        }
        const checkpoint = {
          version: ExecutionProjection.projectionVersion,
          cursor: "authorization-cursor",
          state: '{"operation":"write","path":"README.md"}',
        }
        const pendingSteering = {
          runId: "run-1",
          entryId: "entry-1",
          requestId: "request-1",
          sequence: 1,
          text: "keep the exact API",
        }
        expect(
          yield* Context.get(repositoryContext, TranscriptRepository.Service).commitProjection(turn, {
            _tag: "ProjectionSnapshot",
            revision: 7,
            checkpoint,
            units: [
              {
                key: "authorization:1",
                turnId: String(turn.id),
                order: [{ sequence: 0, part: 0, key: "authorization:1" }],
                revision: 4,
                content: {
                  _tag: "Block",
                  block: {
                    _tag: "AuthorizationCard",
                    id: "authorization-1",
                    operation: "write",
                    capability: "workspace",
                    input: '{"path":"README.md"}',
                    inputTruncated: false,
                    status: "pending",
                  },
                },
              },
            ],
            hasOlder: false,
            state: {
              status: "waiting",
              usage,
              steering: { steeringMessages: 1, followUpMessages: 0, pending: [pendingSteering] },
            },
          }),
        ).toBe("committed")
        const projected = yield* application.snapshot(OwnerId.make("other-owner"), ThreadId.make("read-only-thread"))
        expect(projected).toMatchObject({
          view: {
            turns: [
              {
                projectionRevision: 7,
                usage: { costNanoUsd: 42 },
                pendingSteering: [{ text: "keep the exact API" }],
                units: [
                  {
                    content: {
                      block: { _tag: "AuthorizationCard", id: "authorization-1", status: "pending" },
                    },
                  },
                ],
              },
            ],
            usage: { state: { costNanoUsd: 42 } },
          },
          pendingAuthorizations: [
            {
              threadId: "read-only-thread",
              turnId: "authorization-turn",
              authorizationId: "authorization-1",
              checkpoint,
            },
          ],
        })
        const executionLink = yield* Schema.encodeEffect(JsonExecutionLink)({
          runId: "authorization-run",
          turnId: turn.id,
          threadId: turn.threadId,
        })
        yield* Effect.tryPromise(() =>
          db.update(rikaTurns).set({ executionLinkJson: executionLink }).where(eq(rikaTurns.id, turn.id)),
        )
        yield* aggregateDatabase.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(rikaHostedThreads).values({
              id: "parallel-thread",
              ownerId: "other-owner",
              projectId: null,
              workspaceId: "read-only-workspace",
              createdByUserId: "other-user",
              executorKind: "orb",
              inheritProjectGrants: false,
              createdAt,
            })
            yield* tx.insert(rikaThreads).values({
              id: "parallel-thread",
              ownerId: "other-owner",
              workspace: "read-only-workspace",
              title: "Parallel",
              createdAt: 1,
              updatedAt: 1,
            })
          }),
        )
        const parallelTurn: Turn.AgentExecutionTurn = {
          ...turn,
          id: Turn.TurnId.make("parallel-turn"),
          threadId: ThreadId.make("parallel-thread"),
          prompt: "Progress independently",
        }
        const parallelExecutionLink = yield* Schema.encodeEffect(JsonExecutionLink)({
          runId: "parallel-run",
          turnId: parallelTurn.id,
          threadId: parallelTurn.threadId,
        })
        yield* Effect.tryPromise(() =>
          db.insert(rikaTurns).values({
            id: parallelTurn.id,
            threadId: parallelTurn.threadId,
            prompt: parallelTurn.prompt,
            status: parallelTurn.status,
            executionRouteJson,
            executionLinkJson: parallelExecutionLink,
            createdAt: parallelTurn.createdAt,
            updatedAt: parallelTurn.updatedAt,
          }),
        )
        const cancellationFiber = yield* Effect.forkChild(
          application.interactive(
            {
              ownerId: OwnerId.make("other-owner"),
              threadId: ThreadId.make("read-only-thread"),
              commandId: "cancel-authorization-turn",
              turnId: Turn.TurnId.make("cancel-authorization-turn"),
              command: { _tag: "Cancel", targetTurnId: turn.id },
            },
            Effect.succeed,
          ),
        )
        yield* Deferred.await(xCancellationEntered).pipe(Effect.timeout("5 seconds"))
        const parallelCancellationFiber = yield* Effect.forkChild(
          application.interactive(
            {
              ownerId: OwnerId.make("other-owner"),
              threadId: parallelTurn.threadId,
              commandId: "cancel-parallel-turn",
              turnId: Turn.TurnId.make("cancel-parallel-turn"),
              command: { _tag: "Cancel", targetTurnId: parallelTurn.id },
            },
            Effect.succeed,
          ),
        )
        const parallelProgress = yield* Deferred.await(yCancellationEntered).pipe(Effect.timeoutOption("5 seconds"))
        yield* Deferred.succeed(releaseXCancellation, undefined)
        const cancellation = yield* Fiber.join(cancellationFiber)
        yield* Fiber.join(parallelCancellationFiber)
        expect(parallelProgress._tag).toBe("Some")
        expect(cancellations).toContainEqual({ runId: "authorization-run", reason: "Cancelled by user" })
        expect(cancellations).toContainEqual({ runId: "parallel-run", reason: "Cancelled by user" })
        expect(cancellation.events).toContainEqual({
          _tag: "ExecutionControlFailed",
          threadId: "read-only-thread",
          turnId: "authorization-turn",
          action: "cancel",
          failure: expect.objectContaining({ message: "Cancellation backend unavailable" }),
        })
      } finally {
        yield* Effect.tryPromise(() => pool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ).pipe(livePlatform),
)
