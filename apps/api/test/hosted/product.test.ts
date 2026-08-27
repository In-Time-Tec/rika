import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMember, identityMigrations, identityOrganization, identityUser, runMigration } from "@rika/identity"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { PromptPart } from "@rika/product/execution-request"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { BetterAuthUserId, DeviceId, OrganizationId, WorkspaceId } from "@rika/product/hosted-model"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import {
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedProjects,
  rikaHostedThreadCommands,
  rikaHostedThreadGrants,
  rikaHostedThreads,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaThreadQueueState,
  rikaTurnAdmissionOutbox,
  rikaTurns,
} from "@rika/product-store/database-schema"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { asc, count as rowCount, eq, inArray } from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Config, DateTime, Effect, FileSystem, Layer, Random, Redacted, Ref, Schema } from "effect"
import { Pool } from "pg"
import { live as livePlatform } from "../support/live-platform"
import {
  HostedProduct,
  HostedProductError,
  postgresTest,
  type AdmittedRun,
  type AuthenticatedPrincipal,
} from "../../src/hosted/product"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const live = databaseUrl !== ""
const decodeExecutionRoute = Schema.decodeUnknownSync(Schema.fromJsonString(ExecutionRouteSnapshot))
const decodePromptParts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(PromptPart)))
const encodeStartTurn = Schema.encodeSync(Schema.fromJsonString(ExecutionGateway.StartTurn))

const principal = (userId: string): AuthenticatedPrincipal => ({
  userId,
  deviceId: `device-${userId}`,
  clientId: `client-${userId}`,
})

const personal = (userId: string) => ({
  _tag: "PersonalOwner" as const,
  userId: BetterAuthUserId.make(userId),
})
const organization = (organizationId: string) => ({
  _tag: "OrganizationOwner" as const,
  organizationId: OrganizationId.make(organizationId),
})

const failureKind = <A>(effect: Effect.Effect<A, HostedProductError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.kind),
  )

const requireAdmitted = <E, R>(effect: Effect.Effect<AdmittedRun, E, R>) =>
  effect.pipe(
    Effect.flatMap((result) =>
      result._tag === "Admitted" ? Effect.succeed(result) : Effect.die("Prompt was cancelled unexpectedly"),
    ),
  )

const withDatabase = <A, E, R>(
  label: string,
  use: (database: NodePgDatabase) => Effect.Effect<A, E, R | HostedProduct>,
  promptAdmissionReadiness: Effect.Effect<boolean> = Effect.succeed(true),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_hosted_product_${label}_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      let pool: Pool | undefined
      try {
        const activePool = new Pool({ connectionString: url })
        pool = activePool
        for (const migration of [...identityMigrations, ...productMigrations]) {
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
          postgresTest({
            database: { url: Redacted.make(url), maxConnections: 8 },
            templateBuildId: "hosted-product-live",
            providerScope: "hosted-product-live",
            promptAdmissionReadiness,
          }).pipe(Layer.provide(BunCrypto.layer)),
        )
        return yield* use(drizzle({ client: activePool })).pipe(Effect.provide(context))
      } finally {
        const cleanupPool = pool
        yield* cleanupPool === undefined ? Effect.void : Effect.tryPromise(() => cleanupPool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ).pipe(livePlatform)

it.effect.skipIf(!live)("reuses deterministic Thread creation after a lost response", () =>
  withDatabase("create-retry", (database) =>
    Effect.gen(function* () {
      const authenticated = principal("create-retry-user")
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: authenticated.userId,
          name: authenticated.userId,
          email: `${authenticated.userId}@example.test`,
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      const product = yield* HostedProduct
      const input = {
        principal: authenticated,
        owner: personal(authenticated.userId),
        executorKind: "orb" as const,
        threadId: "create-retry-thread",
      }
      const first = yield* product.createConnection(input)
      expect(yield* product.createConnection(input)).toEqual(first)
      expect(
        yield* Effect.all(
          Array.from({ length: 8 }, () => product.createConnection(input)),
          {
            concurrency: "unbounded",
          },
        ),
      ).toEqual(Array.from({ length: 8 }, () => first))
      const [threads, workspaces, assignments] = yield* Effect.all([
        Effect.orDie(
          Effect.tryPromise(() => database.$count(rikaHostedThreads, eq(rikaHostedThreads.id, input.threadId))),
        ),
        Effect.orDie(
          Effect.tryPromise(() =>
            database.$count(rikaHostedWorkspaces, eq(rikaHostedWorkspaces.id, `${input.threadId}-workspace`)),
          ),
        ),
        Effect.orDie(
          Effect.tryPromise(() =>
            database.$count(rikaHostedExecutorAssignments, eq(rikaHostedExecutorAssignments.threadId, input.threadId)),
          ),
        ),
      ])
      expect([{ threads, workspaces, assignments }]).toEqual([{ threads: 1, workspaces: 1, assignments: 1 }])
      const project = yield* product.createProject({
        principal: authenticated,
        owner: personal(authenticated.userId),
        name: "Divergent retry",
      })
      expect(yield* failureKind(product.createConnection({ ...input, projectId: project.id }))).toBe("conflict")
    }),
  ),
)

it.effect.skipIf(!live)("atomically archives a Thread while creating its replacement", () =>
  withDatabase("atomic-replacement", (database) =>
    Effect.gen(function* () {
      const authenticated = principal("atomic-replacement-user")
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: authenticated.userId,
          name: authenticated.userId,
          email: `${authenticated.userId}@example.test`,
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      const product = yield* HostedProduct
      const base = {
        principal: authenticated,
        owner: personal(authenticated.userId),
        executorKind: "orb" as const,
      }
      yield* product.createConnection({ ...base, threadId: "source-thread" })
      yield* product.createConnection({ ...base, threadId: "other-source-thread" })
      const replacement = {
        ...base,
        threadId: "replacement-thread",
        archiveThreadId: "source-thread",
      }
      const created = yield* product.createConnection(replacement)
      expect(yield* product.createConnection(replacement)).toEqual(created)
      expect(
        yield* failureKind(product.createConnection({ ...replacement, archiveThreadId: "other-source-thread" })),
      ).toBe("conflict")
      expect(
        yield* failureKind(
          product.createConnection({ ...base, threadId: "missing-replacement", archiveThreadId: "missing-thread" }),
        ),
      ).toBe("not-found")
      expect(
        yield* failureKind(
          product.createConnection({ ...base, threadId: "self-replacement", archiveThreadId: "self-replacement" }),
        ),
      ).toBe("conflict")
      expect(
        yield* Effect.tryPromise(() =>
          database
            .select({ id: rikaThreads.id, archived: rikaThreads.archived })
            .from(rikaThreads)
            .where(inArray(rikaThreads.id, ["source-thread", "other-source-thread", "replacement-thread"]))
            .orderBy(asc(rikaThreads.id)),
        ),
      ).toEqual([
        { id: "other-source-thread", archived: 0 },
        { id: "replacement-thread", archived: 0 },
        { id: "source-thread", archived: 1 },
      ])
      expect(
        yield* Effect.tryPromise(() =>
          database
            .select({ archiveSourceThreadId: rikaHostedThreads.archiveSourceThreadId })
            .from(rikaHostedThreads)
            .where(eq(rikaHostedThreads.id, "replacement-thread")),
        ),
      ).toEqual([{ archiveSourceThreadId: "source-thread" }])
      expect(
        yield* Effect.tryPromise(() =>
          database.$count(
            rikaHostedThreads,
            inArray(rikaHostedThreads.id, ["missing-replacement", "self-replacement"]),
          ),
        ),
      ).toBe(0)
    }),
  ),
)

it.effect.skipIf(!live)("supports a projectless personal connection for a user with no organizations", () =>
  withDatabase("personal", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: "personal-user",
          name: "personal-user",
          email: "personal-user@example.test",
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      const product = yield* HostedProduct
      expect(yield* product.projects(principal("personal-user"))).toEqual([])
      const connection = yield* product.createConnection({
        principal: principal("personal-user"),
        owner: personal("personal-user"),
        executorKind: "orb",
      })
      const admissionInput = {
        principal: principal("personal-user"),
        threadId: connection.threadId,
        operationKey: "personal-operation",
        prompt: "personal prompt",
      } as const
      const admitted = yield* requireAdmitted(product.admitRun(admissionInput))
      expect(admitted.status).toBe("accepted")
      expect(yield* product.admitRun(admissionInput)).toEqual(admitted)
      expect(yield* failureKind(product.admitRun({ ...admissionInput, prompt: "different prompt" }))).toBe("conflict")
      expect(yield* failureKind(product.admitRun({ ...admissionInput, mode: "low" }))).toBe("conflict")
      const facts = yield* Effect.tryPromise(() =>
        database
          .select({
            owner_id: rikaHostedOwners.id,
            user_id: rikaHostedOwners.userId,
            created_by_user_id: rikaHostedThreads.createdByUserId,
            assignment_id: rikaHostedExecutorAssignments.id,
            actor: rikaHostedThreadCommands.actor,
            turn_id: rikaHostedThreadCommands.turnId,
            status: rikaTurns.status,
            prompt: rikaTurns.prompt,
            memberships: database.$count(identityMember, eq(identityMember.userId, "personal-user")),
            turn_count: database.$count(rikaTurns, eq(rikaTurns.threadId, rikaHostedThreads.id)),
            queued_count: rikaThreadQueueState.queuedCount,
          })
          .from(rikaHostedThreadCommands)
          .innerJoin(rikaHostedThreads, eq(rikaHostedThreads.id, rikaHostedThreadCommands.threadId))
          .innerJoin(rikaHostedExecutorAssignments, eq(rikaHostedExecutorAssignments.threadId, rikaHostedThreads.id))
          .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedThreadCommands.ownerId))
          .innerJoin(rikaTurns, eq(rikaTurns.id, rikaHostedThreadCommands.turnId))
          .innerJoin(rikaThreadQueueState, eq(rikaThreadQueueState.threadId, rikaHostedThreads.id)),
      )
      expect(facts).toHaveLength(1)
      expect(facts[0]?.assignment_id).not.toBe(connection.threadId)
      expect(facts[0]).toMatchObject({
        user_id: "personal-user",
        created_by_user_id: "personal-user",
        memberships: 0,
        turn_id: admitted.turnId,
        status: "accepted",
        prompt: "personal prompt",
        turn_count: 1,
        queued_count: 0,
        actor: {
          _tag: "PersonalActor",
          userId: "personal-user",
          owner: personal("personal-user"),
        },
      })
      const queued = yield* requireAdmitted(
        product.admitRun({
          ...admissionInput,
          operationKey: "personal-operation-queued",
          prompt: "queued prompt",
        }),
      )
      expect(queued.status).toBe("queued")
      expect(
        yield* Effect.tryPromise(() =>
          database
            .select({ id: rikaTurns.id, status: rikaTurns.status, queued_count: rikaThreadQueueState.queuedCount })
            .from(rikaTurns)
            .innerJoin(rikaThreadQueueState, eq(rikaThreadQueueState.threadId, rikaTurns.threadId))
            .where(eq(rikaTurns.id, queued.turnId)),
        ),
      ).toMatchObject([{ id: queued.turnId, status: "queued", queued_count: 1 }])
    }),
  ),
)

it.effect.skipIf(!live)("serializes prompt admission against cancellation in both commit orders", () =>
  withDatabase("prompt-cancellation", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: "cancellation-user",
          name: "cancellation-user",
          email: "cancellation-user@example.test",
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      const authenticated = principal("cancellation-user")
      const product = yield* HostedProduct
      const connection = yield* product.createConnection({
        principal: authenticated,
        owner: personal(authenticated.userId),
        executorKind: "orb",
      })
      expect(
        yield* product.cancelRunAdmission({
          principal: authenticated,
          threadId: connection.threadId,
          cancelCommandId: "cancel-first",
          targetCommandId: "submit-cancelled",
        }),
      ).toEqual({})
      expect(
        yield* product.admitRun({
          principal: authenticated,
          threadId: connection.threadId,
          operationKey: "submit-cancelled",
          prompt: "must never execute",
        }),
      ).toEqual({ _tag: "Cancelled", commandId: "submit-cancelled" })
      const admitted = yield* requireAdmitted(
        product.admitRun({
          principal: authenticated,
          threadId: connection.threadId,
          operationKey: "submit-admitted",
          prompt: "cancel this exact Turn",
        }),
      )
      expect(
        yield* product.cancelRunAdmission({
          principal: authenticated,
          threadId: connection.threadId,
          cancelCommandId: "cancel-second",
          targetCommandId: "submit-admitted",
        }),
      ).toEqual({ turnId: admitted.turnId })
      expect(
        yield* Effect.tryPromise(() =>
          database
            .select({ command_id: rikaHostedThreadCommands.commandId, turn_id: rikaHostedThreadCommands.turnId })
            .from(rikaHostedThreadCommands)
            .where(eq(rikaHostedThreadCommands.threadId, connection.threadId))
            .orderBy(asc(rikaHostedThreadCommands.commandId)),
        ),
      ).toMatchObject([{ command_id: "submit-admitted", turn_id: admitted.turnId }])
    }),
  ),
)

it.effect.skipIf(!live)("rejects new prompts without mutation and replays them through outage and recovery", () =>
  Effect.gen(function* () {
    const ready = yield* Ref.make(false)
    yield* withDatabase(
      "prompt-readiness",
      (database) =>
        Effect.gen(function* () {
          const createdAt = DateTime.toDate(DateTime.nowUnsafe())
          yield* Effect.tryPromise(() =>
            database.insert(identityUser).values({
              id: "prompt-readiness-user",
              name: "prompt-readiness-user",
              email: "prompt-readiness-user@example.test",
              emailVerified: true,
              createdAt,
              updatedAt: createdAt,
            }),
          )
          const product = yield* HostedProduct
          const connection = yield* product.createConnection({
            principal: principal("prompt-readiness-user"),
            owner: personal("prompt-readiness-user"),
            executorKind: "orb",
          })
          const input = {
            principal: principal("prompt-readiness-user"),
            threadId: connection.threadId,
            operationKey: "readiness-command",
            prompt: "ready prompt",
          } as const
          expect(yield* failureKind(product.admitRun(input))).toBe("unavailable")
          const [commands, turns, queues] = yield* Effect.all([
            Effect.orDie(
              Effect.tryPromise(() =>
                database.$count(rikaHostedThreadCommands, eq(rikaHostedThreadCommands.threadId, connection.threadId)),
              ),
            ),
            Effect.orDie(
              Effect.tryPromise(() => database.$count(rikaTurns, eq(rikaTurns.threadId, connection.threadId))),
            ),
            Effect.orDie(
              Effect.tryPromise(() =>
                database.$count(rikaThreadQueueState, eq(rikaThreadQueueState.threadId, connection.threadId)),
              ),
            ),
          ])
          expect([{ commands, turns, queues }]).toMatchObject([{ commands: 0, turns: 0, queues: 0 }])
          yield* Ref.set(ready, true)
          const admitted = yield* product.admitRun(input)
          yield* Ref.set(ready, false)
          expect(yield* product.admitRun(input)).toEqual(admitted)
          expect(
            yield* failureKind(
              product.admitRun({
                ...input,
                operationKey: "new-during-outage",
              }),
            ),
          ).toBe("unavailable")
          yield* Ref.set(ready, true)
          expect((yield* requireAdmitted(product.admitRun({ ...input, operationKey: "after-recovery" }))).status).toBe(
            "queued",
          )
        }),
      Ref.get(ready),
    )
  }),
)

it.effect.skipIf(!live)("admits concurrent duplicate prompts with one mutation", () =>
  Effect.gen(function* () {
    const checks = yield* Ref.make(0)
    const readiness = Ref.update(checks, (count) => count + 1).pipe(Effect.as(true))
    yield* withDatabase(
      "prompt-readiness-race",
      (database) =>
        Effect.gen(function* () {
          const createdAt = DateTime.toDate(DateTime.nowUnsafe())
          yield* Effect.tryPromise(() =>
            database.insert(identityUser).values({
              id: "prompt-readiness-race-user",
              name: "prompt-readiness-race-user",
              email: "prompt-readiness-race-user@example.test",
              emailVerified: true,
              createdAt,
              updatedAt: createdAt,
            }),
          )
          const product = yield* HostedProduct
          const connection = yield* product.createConnection({
            principal: principal("prompt-readiness-race-user"),
            owner: personal("prompt-readiness-race-user"),
            executorKind: "orb",
          })
          const input = {
            principal: principal("prompt-readiness-race-user"),
            threadId: connection.threadId,
            operationKey: "racing-command",
            prompt: "racing prompt",
          } as const
          const results = yield* Effect.all([product.admitRun(input), product.admitRun(input)], { concurrency: 2 })
          expect(results[1]).toEqual(results[0])
          expect(yield* Ref.get(checks)).toBe(2)
          expect(
            yield* Effect.tryPromise(() => database.$count(rikaTurns, eq(rikaTurns.threadId, connection.threadId))),
          ).toBe(1)
        }),
      readiness,
    )
  }),
)

it.effect.skipIf(!live)("serializes the first prompt lane without queue-count drift", () =>
  withDatabase("prompt-lane", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: "prompt-lane-user",
          name: "prompt-lane-user",
          email: "prompt-lane-user@example.test",
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      const product = yield* HostedProduct
      const connection = yield* product.createConnection({
        principal: principal("prompt-lane-user"),
        owner: personal("prompt-lane-user"),
        executorKind: "orb",
      })
      const inputs = Array.from({ length: 8 }, (_, index) => ({
        principal: principal("prompt-lane-user"),
        threadId: connection.threadId,
        operationKey: `concurrent-prompt-${index}`,
        prompt: `concurrent prompt ${index}`,
      }))
      const admitted = yield* Effect.all(
        inputs.map((input) => requireAdmitted(product.admitRun(input))),
        { concurrency: "unbounded" },
      )
      const lanes = yield* Effect.tryPromise(() =>
        database
          .select({ status: rikaTurns.status, count: rowCount() })
          .from(rikaTurns)
          .where(eq(rikaTurns.threadId, connection.threadId))
          .groupBy(rikaTurns.status)
          .orderBy(asc(rikaTurns.status)),
      )
      expect(lanes).toEqual([
        { status: "accepted", count: 1 },
        { status: "queued", count: 7 },
      ])
      expect(
        yield* Effect.tryPromise(() =>
          database
            .select({ queued_count: rikaThreadQueueState.queuedCount })
            .from(rikaThreadQueueState)
            .where(eq(rikaThreadQueueState.threadId, connection.threadId)),
        ),
      ).toMatchObject([{ queued_count: 7 }])
      const accepted = lanes.find((lane) => lane.status === "accepted")
      expect(accepted?.count).toBe(1)
      expect(admitted.map((item) => item.status).toSorted()).toEqual([
        "accepted",
        "queued",
        "queued",
        "queued",
        "queued",
        "queued",
        "queued",
        "queued",
      ])
    }),
  ),
)

it.effect.skipIf(!live)("admits a current local Thread without recovering an unrelated stale admission", () =>
  withDatabase("local-admission", (database) =>
    Effect.gen(function* () {
      const authenticated = principal("local-user")
      const fingerprint = CheckoutFingerprint.make("local-checkout")
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: authenticated.userId,
          name: authenticated.userId,
          email: `${authenticated.userId}@example.test`,
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      const product = yield* HostedProduct
      const workspaceIdentity = yield* Schema.decodeEffect(WorkspaceId)("local-workspace")
      yield* product.registerRunner({
        principal: authenticated,
        checkoutFingerprint: fingerprint,
        registration: {
          workspaceIdentity,
          repository: { identity: "In-Time-Tec/rika", branch: "main" },
          kernel: {
            runtime: "bun",
            runtimeVersion: Bun.version,
            trustMode: "trusted-local",
          },
          capabilities: { cells: true, checkpoints: false, pty: false },
        },
      })
      const deviceId = yield* Schema.decodeEffect(DeviceId)(authenticated.deviceId)
      const createLocal = () =>
        product.createConnection({
          principal: authenticated,
          owner: personal(authenticated.userId),
          executorKind: "runner",
          runnerTarget: { deviceId, checkoutFingerprint: fingerprint },
        })
      const staleThread = yield* createLocal()
      const staleRun = yield* requireAdmitted(
        product.admitRun({
          principal: authenticated,
          threadId: staleThread.threadId,
          operationKey: "stale-operation",
          prompt: "stale prompt",
        }),
      )
      const staleRows = yield* Effect.tryPromise(() =>
        database
          .select({
            workspace_id: rikaHostedThreads.workspaceId,
            execution_route_json: rikaTurns.executionRouteJson,
          })
          .from(rikaTurns)
          .innerJoin(rikaHostedThreads, eq(rikaHostedThreads.id, rikaTurns.threadId))
          .where(eq(rikaTurns.id, staleRun.turnId)),
      )
      const staleRow = staleRows[0]
      if (staleRow === undefined) return yield* Effect.die("Stale Turn was not persisted")
      const staleInput = {
        threadId: staleThread.threadId,
        turnId: staleRun.turnId,
        workspaceId: staleRow.workspace_id,
        prompt: "stale prompt",
        executionRoute: decodeExecutionRoute(staleRow.execution_route_json),
      }
      yield* Effect.tryPromise(() =>
        database.update(rikaTurns).set({ status: "running" }).where(eq(rikaTurns.id, staleRun.turnId)),
      )
      yield* Effect.tryPromise(() =>
        database
          .update(rikaThreadQueueState)
          .set({ queuedCount: 0 })
          .where(eq(rikaThreadQueueState.threadId, staleThread.threadId)),
      )
      yield* Effect.tryPromise(() =>
        database
          .insert(rikaTurnAdmissionOutbox)
          .values({ turnId: staleRun.turnId, startInputJson: encodeStartTurn(staleInput), preparedAt: 1 }),
      )
      yield* Effect.tryPromise(() =>
        database
          .delete(rikaHostedExecutorAssignments)
          .where(eq(rikaHostedExecutorAssignments.threadId, staleThread.threadId)),
      )

      const currentThread = yield* createLocal()
      const promptParts = [
        {
          type: "image" as const,
          mediaType: "image/png",
          data: "aW1hZ2U=",
          filename: "evidence.png",
        },
      ]
      const currentRun = yield* requireAdmitted(
        product.admitRun({
          principal: authenticated,
          threadId: currentThread.threadId,
          operationKey: "current-operation",
          prompt: "current prompt",
          promptParts,
          mode: "high",
        }),
      )
      const turns = yield* Effect.tryPromise(() =>
        database
          .select({
            id: rikaTurns.id,
            status: rikaTurns.status,
            prompt_parts_json: rikaTurns.promptPartsJson,
            execution_route_json: rikaTurns.executionRouteJson,
          })
          .from(rikaTurns)
          .where(inArray(rikaTurns.id, [staleRun.turnId, currentRun.turnId]))
          .orderBy(asc(rikaTurns.id)),
      )
      const stale = turns.find((row) => row.id === staleRun.turnId)
      const current = turns.find((row) => row.id === currentRun.turnId)
      expect(stale).toMatchObject({ status: "running" })
      expect(current).toMatchObject({ status: "accepted" })
      if (current === undefined) return yield* Effect.die("Current Turn was not persisted")
      expect(decodePromptParts(current.prompt_parts_json)).toEqual(promptParts)
      const route = decodeExecutionRoute(current.execution_route_json)
      expect(route.mode).toBe("high")
      expect(
        route.main.candidates.every(
          (candidate) =>
            candidate.providerConnection.provider === "openai" &&
            candidate.providerConnection.authentication === "account" &&
            candidate.providerConnection.credentialIdentity === "openai-account-test" &&
            candidate.providerConnection.accountFingerprint === "openai-fingerprint-test",
        ),
      ).toBe(true)
      expect(
        yield* Effect.tryPromise(() =>
          database.$count(rikaTurnAdmissionOutbox, eq(rikaTurnAdmissionOutbox.turnId, staleRun.turnId)),
        ),
      ).toBe(1)
    }),
  ),
)

it.effect.skipIf(!live)("revokes organization admission immediately without affecting personal threads", () =>
  withDatabase("revocation", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: "member-user",
          name: "member-user",
          email: "member-user@example.test",
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      yield* Effect.tryPromise(() =>
        database
          .insert(identityOrganization)
          .values({ id: "revoked-org", name: "revoked-org", slug: "revoked-org", createdAt }),
      )
      yield* Effect.tryPromise(() =>
        database.insert(identityMember).values({
          id: "revoked-membership",
          organizationId: "revoked-org",
          userId: "member-user",
          role: "member",
          createdAt,
        }),
      )
      const product = yield* HostedProduct
      const personalConnection = yield* product.createConnection({
        principal: principal("member-user"),
        owner: personal("member-user"),
        executorKind: "orb",
      })
      const organizationConnection = yield* product.createConnection({
        principal: principal("member-user"),
        owner: organization("revoked-org"),
        executorKind: "orb",
      })
      yield* product.admitRun({
        principal: principal("member-user"),
        threadId: organizationConnection.threadId,
        operationKey: "org-before-revocation",
        prompt: "allowed",
      })
      yield* Effect.tryPromise(() => database.delete(identityMember).where(eq(identityMember.id, "revoked-membership")))
      expect(
        yield* failureKind(
          product.admitRun({
            principal: principal("member-user"),
            threadId: organizationConnection.threadId,
            operationKey: "org-after-revocation",
            prompt: "denied",
          }),
        ),
      ).toBe("forbidden")
      yield* product.admitRun({
        principal: principal("member-user"),
        threadId: personalConnection.threadId,
        operationKey: "personal-after-revocation",
        prompt: "still allowed",
      })
    }),
  ),
)

it.effect.skipIf(!live)("requires a direct grant for a non-creator organization projectless thread", () =>
  withDatabase("grant", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values([
          {
            id: "creator-user",
            name: "creator-user",
            email: "creator-user@example.test",
            emailVerified: true,
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: "operator-user",
            name: "operator-user",
            email: "operator-user@example.test",
            emailVerified: true,
            createdAt,
            updatedAt: createdAt,
          },
        ]),
      )
      yield* Effect.tryPromise(() =>
        database
          .insert(identityOrganization)
          .values({ id: "grant-org", name: "grant-org", slug: "grant-org", createdAt }),
      )
      yield* Effect.tryPromise(() =>
        database.insert(identityMember).values([
          {
            id: "creator-membership",
            organizationId: "grant-org",
            userId: "creator-user",
            role: "member",
            createdAt,
          },
          {
            id: "operator-membership",
            organizationId: "grant-org",
            userId: "operator-user",
            role: "member",
            createdAt,
          },
        ]),
      )
      const product = yield* HostedProduct
      const connection = yield* product.createConnection({
        principal: principal("creator-user"),
        owner: organization("grant-org"),
        executorKind: "orb",
      })
      const operate = product.admitRun({
        principal: principal("operator-user"),
        threadId: connection.threadId,
        operationKey: "operator-run",
        prompt: "operate",
      })
      expect(yield* failureKind(operate)).toBe("forbidden")
      const owners = yield* Effect.tryPromise(() =>
        database
          .select({ owner_id: rikaHostedThreads.ownerId })
          .from(rikaHostedThreads)
          .where(eq(rikaHostedThreads.id, connection.threadId)),
      )
      const owner = owners[0]
      if (owner === undefined) return yield* Effect.die("Organization Thread owner was not persisted")
      yield* Effect.tryPromise(() =>
        database.insert(rikaHostedThreadGrants).values({
          ownerId: owner.owner_id,
          threadId: connection.threadId,
          membershipId: "operator-membership",
          role: "operator",
          grantedByUserId: "creator-user",
          createdAt,
          updatedAt: createdAt,
        }),
      )
      yield* operate
      const commands = yield* Effect.tryPromise(() =>
        database
          .select({ actor: rikaHostedThreadCommands.actor })
          .from(rikaHostedThreadCommands)
          .where(eq(rikaHostedThreadCommands.commandId, "operator-run")),
      )
      expect(commands[0]?.actor).toMatchObject({
        _tag: "OrganizationActor",
        userId: "operator-user",
        membershipId: "operator-membership",
        owner: organization("grant-org"),
      })
    }),
  ),
)

it.effect.skipIf(!live)("fails closed for forged and cross-owner selections", () =>
  withDatabase("forgery", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values([
          {
            id: "first-user",
            name: "first-user",
            email: "first-user@example.test",
            emailVerified: true,
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: "second-user",
            name: "second-user",
            email: "second-user@example.test",
            emailVerified: true,
            createdAt,
            updatedAt: createdAt,
          },
        ]),
      )
      yield* Effect.tryPromise(() =>
        database
          .insert(identityOrganization)
          .values({ id: "foreign-org", name: "foreign-org", slug: "foreign-org", createdAt }),
      )
      const product = yield* HostedProduct
      expect(
        yield* failureKind(
          product.createConnection({
            principal: principal("first-user"),
            owner: personal("second-user"),
            executorKind: "orb",
          }),
        ),
      ).toBe("forbidden")
      expect(
        yield* failureKind(
          product.createConnection({
            principal: principal("first-user"),
            owner: organization("foreign-org"),
            executorKind: "orb",
          }),
        ),
      ).toBe("forbidden")
      const secondConnection = yield* product.createConnection({
        principal: principal("second-user"),
        owner: personal("second-user"),
        executorKind: "orb",
      })
      expect(
        yield* failureKind(
          product.admitRun({
            principal: principal("first-user"),
            threadId: secondConnection.threadId,
            operationKey: "foreign-thread",
            prompt: "denied",
          }),
        ),
      ).toBe("forbidden")
      yield* product.projects(principal("first-user"))
      const secondOwners = yield* Effect.tryPromise(() =>
        database
          .select({ id: rikaHostedOwners.id })
          .from(rikaHostedOwners)
          .where(eq(rikaHostedOwners.userId, "second-user")),
      )
      const secondOwner = secondOwners[0]
      if (secondOwner === undefined) return yield* Effect.die("Second personal owner was not persisted")
      yield* Effect.tryPromise(() =>
        database.insert(rikaHostedProjects).values({
          id: "foreign-project",
          ownerId: secondOwner.id,
          name: "Foreign",
          createdByUserId: "second-user",
          createdAt,
          updatedAt: createdAt,
        }),
      )
      expect(
        yield* failureKind(
          product.createConnection({
            principal: principal("first-user"),
            owner: personal("first-user"),
            projectId: "foreign-project",
            executorKind: "orb",
          }),
        ),
      ).toBe("not-found")
    }),
  ),
)

it.effect.skipIf(!live)("provisions stable opaque personal and organization owners under concurrency", () =>
  withDatabase("owners", (database) =>
    Effect.gen(function* () {
      const createdAt = DateTime.toDate(DateTime.nowUnsafe())
      yield* Effect.tryPromise(() =>
        database.insert(identityUser).values({
          id: "owner-user",
          name: "owner-user",
          email: "owner-user@example.test",
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        }),
      )
      yield* Effect.tryPromise(() =>
        database
          .insert(identityOrganization)
          .values({ id: "owner-org", name: "owner-org", slug: "owner-org", createdAt }),
      )
      yield* Effect.tryPromise(() =>
        database.insert(identityMember).values({
          id: "owner-membership",
          organizationId: "owner-org",
          userId: "owner-user",
          role: "member",
          createdAt,
        }),
      )
      const product = yield* HostedProduct
      yield* Effect.all(
        Array.from({ length: 8 }, () => product.projects(principal("owner-user"))),
        {
          concurrency: "unbounded",
        },
      )
      const owners = yield* Effect.tryPromise(() =>
        database
          .select({ id: rikaHostedOwners.id, kind: rikaHostedOwners.kind })
          .from(rikaHostedOwners)
          .orderBy(asc(rikaHostedOwners.kind)),
      )
      expect(owners).toHaveLength(2)
      expect(owners.map(({ kind }) => kind).sort()).toEqual(["organization", "personal"])
      expect(owners.every(({ id }) => id !== "owner-user" && id !== "owner-org")).toBe(true)
      yield* product.projects(principal("owner-user"))
      const repeated = yield* Effect.tryPromise(() =>
        database
          .select({ id: rikaHostedOwners.id, kind: rikaHostedOwners.kind })
          .from(rikaHostedOwners)
          .orderBy(asc(rikaHostedOwners.kind)),
      )
      expect(repeated).toEqual(owners)
    }),
  ),
)
