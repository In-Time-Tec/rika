import * as PgClient from "@effect/sql-pg/PgClient"
import {
  cliRegistration,
  identityMember,
  identityMigrations,
  oauthClient,
  identityOrganization,
  identityUser,
  runMigration,
} from "@rika/identity"
import {
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedExecutorAssignments,
  rikaHostedExecutorOperations,
  rikaHostedOwnerCounters,
  rikaHostedOwners,
  rikaHostedProjects,
  rikaHostedRunnerAdmissions,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolState,
  rikaHostedThreadEvents,
  rikaHostedThreads,
  rikaHostedWorkspaceCapabilityAdmissions,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaTurns,
  rikaWorkspaces,
} from "@rika/product-store/database-schema"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { and, count, eq, sql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import type { PgInsertValue } from "drizzle-orm/pg-core"
import { FileSystem, Effect, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"
import { live as livePlatform } from "../../support/live-platform"
import {
  assignmentId,
  toolRequest,
  databaseUrl,
  deviceId,
  environmentDigest,
  operationDigest,
  sessionDigest,
  threadId,
  workspaceCapabilities,
} from "./harness"

export const migrate = (url: string) =>
  Effect.gen(function* () {
    const pool = yield* Effect.sync(() => new Pool({ connectionString: url }))
    for (const migration of [...identityMigrations, ...productMigrations]) {
      const migrationSql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(migration.url.pathname),
      )
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql: migrationSql })
    }
    return pool
  })

export const seed = (
  databaseClient: NodePgDatabase,
  operationKey: string,
  options?: {
    readonly ownerKind?: "organization" | "personal"
    readonly leaseEpoch?: number
    readonly deadlineAt?: string
    readonly state?: "accepted" | "dispatched"
    readonly leaseExpires?: "past" | "future"
    readonly request?: Parameters<typeof operationDigest>[0]
  },
) =>
  Effect.gen(function* () {
    const state = options?.state ?? "dispatched"
    const deadlineAt = options?.deadlineAt ?? "2999-01-01T00:00:00.000Z"
    const request = options?.request ?? toolRequest(operationKey, deadlineAt)
    const digest = operationDigest(request)
    const ownerKind = options?.ownerKind ?? "organization"
    const ownerId = `${ownerKind}-owner-local-gateway`
    const now = sql`transaction_timestamp()`
    const future = sql`transaction_timestamp() + interval '5 minutes'`
    const aggregateDatabase = yield* PgDrizzle.makeWithDefaults()
    yield* Effect.tryPromise(() =>
      databaseClient.insert(identityUser).values({
        id: "user-local-gateway",
        name: "Local",
        email: "local-gateway@example.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      }),
    )
    if (ownerKind === "organization") {
      yield* Effect.tryPromise(() =>
        databaseClient.insert(identityOrganization).values({
          id: "organization-local-gateway",
          name: "Local",
          slug: "local-gateway",
          createdAt: now,
        }),
      )
      yield* Effect.tryPromise(() =>
        databaseClient.insert(identityMember).values({
          id: "member-local-gateway",
          organizationId: "organization-local-gateway",
          userId: "user-local-gateway",
          role: "owner",
          createdAt: now,
        }),
      )
    }
    yield* Effect.tryPromise(() =>
      databaseClient.insert(oauthClient).values({
        id: "oauth-local-gateway",
        clientId: "client-local-gateway",
        redirectUris: [],
        createdAt: now,
      }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(cliRegistration).values({
        clientId: "client-local-gateway",
        deviceId,
        publicJwk: {
          kty: "EC",
          crv: "P-256",
          x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          y: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
        jwkThumbprint: "thumbprint-local-gateway",
        userId: "user-local-gateway",
      }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(rikaHostedOwners).values({
        id: ownerId,
        kind: ownerKind,
        userId: ownerKind === "personal" ? "user-local-gateway" : null,
        organizationId: ownerKind === "organization" ? "organization-local-gateway" : null,
      }),
    )
    yield* Effect.tryPromise(() => databaseClient.insert(rikaHostedOwnerCounters).values({ ownerId }))
    yield* Effect.tryPromise(() =>
      databaseClient.insert(rikaHostedProjects).values({
        id: "project-local-gateway",
        ownerId,
        name: "Local",
        createdByUserId: "user-local-gateway",
        createdAt: now,
        updatedAt: now,
      }),
    )
    yield* aggregateDatabase.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.insert(rikaHostedWorkspaces).values({
          id: "workspace-local-gateway",
          ownerId,
          projectId: "project-local-gateway",
          createdByUserId: "user-local-gateway",
          executorKind: "runner",
          inheritProjectGrants: false,
          createdAt: now,
        })
        yield* tx.insert(rikaWorkspaces).values({ ownerId, path: "workspace-local-gateway", createdAt: 1 })
        yield* tx.insert(rikaHostedThreads).values({
          id: "thread-local-gateway",
          ownerId,
          projectId: "project-local-gateway",
          workspaceId: "workspace-local-gateway",
          createdByUserId: "user-local-gateway",
          executorKind: "runner",
          inheritProjectGrants: false,
          nextEventSequence: 1,
          createdAt: now,
        })
        yield* tx.insert(rikaThreads).values({
          id: "thread-local-gateway",
          ownerId,
          workspace: "workspace-local-gateway",
          title: "Local",
          createdAt: 1,
          updatedAt: 1,
        })
      }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(rikaTurns).values({
        id: "turn-local-gateway",
        threadId: "thread-local-gateway",
        prompt: "restart",
        status: "accepted",
        createdAt: 1,
        updatedAt: 1,
        executionRouteJson: "{}",
      }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(rikaHostedDevices).values({
        id: deviceId,
        userId: "user-local-gateway",
        displayName: "Local",
        publicKeyFingerprint: "sha256:local-gateway",
        createdAt: now,
        lastSeenAt: now,
      }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(rikaHostedClients).values({
        id: "client-local-gateway",
        userId: "user-local-gateway",
        deviceId,
        authenticatedAt: now,
        lastSeenAt: now,
        expiresAt: future,
      }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(rikaHostedExecutorAssignments).values({
        id: assignmentId,
        ownerId,
        threadId,
        executorKind: "runner",
        placement: { _tag: "RunnerPlacement", deviceId },
        checkout: null,
        generation: 1,
        revision: 1,
        lastLeaseEpoch: 1,
        lifecycle: "active",
        providerInstanceId: deviceId,
        executorInstanceId: "executor-local-gateway",
        processIncarnation: "process-local-gateway",
        sessionDigest,
        leaseEpoch: 1,
        leaseExpiresAt: options?.leaseExpires === "past" ? sql`transaction_timestamp() - interval '1 second'` : future,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
        workspaceId: "workspace-local-gateway",
        capabilityGeneration: 1,
        capabilitySnapshot: workspaceCapabilities,
      }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(rikaHostedRunnerAdmissions).values({
        id: "admission-local-gateway",
        assignmentId,
        ownerId,
        deviceId,
        clientId: "client-local-gateway",
        userId: "user-local-gateway",
        processIncarnation: "process-local-gateway",
        generation: 1,
        workspaceFingerprint: "workspace-local",
        ticketDigest: "ticket-digest",
        expiresAt: future,
        consumedAt: now,
      }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(rikaHostedWorkspaceCapabilityAdmissions).values({
        threadId,
        turnId: "turn-local-gateway",
        assignmentId,
        workspaceId: "workspace-local-gateway",
        assignmentGeneration: 1,
        environmentDigest,
        requiredCapabilities: ["filesystem", "nativeTools", "git", "process", "workspaceLifecycle"],
      }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(rikaHostedThreadProtocolState).values({ ownerId, threadId, version: 1 }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient.insert(rikaHostedThreadProtocolCommands).values({
        ownerId,
        threadId,
        commandId: `${operationKey}-command`,
        idempotencyKey: `${operationKey}-submission`,
        actor:
          ownerKind === "personal"
            ? {
                _tag: "PersonalActor",
                owner: { _tag: "PersonalOwner", userId: "user-local-gateway" },
                userId: "user-local-gateway",
                clientId: "client-local-gateway",
                deviceId,
              }
            : {
                _tag: "OrganizationActor",
                owner: { _tag: "OrganizationOwner", organizationId: "organization-local-gateway" },
                userId: "user-local-gateway",
                membershipId: "member-local-gateway",
                clientId: "client-local-gateway",
                deviceId,
              },
        expectedVersion: 0,
        threadVersion: 1,
        commitCursor: 1,
        command: { _tag: "SubmitPrompt", prompt: "restart" },
        state: "admitted",
        admittedAt: now,
        turnId: "turn-local-gateway",
      }),
    )
    yield* Effect.tryPromise(() =>
      databaseClient
        .update(rikaHostedOwnerCounters)
        .set({ nextCommitCursor: 2 })
        .where(eq(rikaHostedOwnerCounters.ownerId, ownerId)),
    )
    const operation: PgInsertValue<typeof rikaHostedExecutorOperations> = {
      assignmentId,
      ownerId,
      operationKey,
      requestDigest: digest,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      threadId: request.threadId,
      turnId: request.turnId,
      runId: request.runId,
      rootRunId: request.rootRunId,
      toolCallId: request.toolCallId,
      code: request.code,
      attempt: request.attempt,
      replayPolicy: request.replayPolicy,
      deadlineAt: sql`${deadlineAt}::timestamptz`,
      updatedAt: now,
    }
    if (state === "accepted") {
      yield* Effect.tryPromise(() =>
        databaseClient.insert(rikaHostedExecutorOperations).values({ ...operation, state: "accepted" }),
      )
      return
    }
    yield* Effect.tryPromise(() =>
      databaseClient.insert(rikaHostedExecutorOperations).values({
        ...operation,
        state: "dispatched",
        dispatchedGeneration: 1,
        dispatchedLeaseEpoch: options?.leaseEpoch ?? 1,
        dispatchedExecutorInstanceId: "executor-local-gateway",
        dispatchedProcessIncarnation: "process-local-gateway",
      }),
    )
  })

export const seedOperation = (
  databaseClient: NodePgDatabase,
  request: ReturnType<typeof toolRequest>,
  state: "accepted" | "dispatched" = "accepted",
) => {
  const operation: PgInsertValue<typeof rikaHostedExecutorOperations> = {
    assignmentId,
    ownerId: "organization-owner-local-gateway",
    operationKey: request.operationKey,
    requestDigest: operationDigest(request),
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    threadId: request.threadId,
    turnId: request.turnId,
    runId: request.runId,
    rootRunId: request.rootRunId,
    toolCallId: request.toolCallId,
    code: request.code,
    attempt: request.attempt,
    replayPolicy: request.replayPolicy,
    deadlineAt: sql`${request.deadlineAt}::timestamptz`,
    updatedAt: sql`transaction_timestamp()`,
  }
  return Effect.tryPromise(() =>
    databaseClient.insert(rikaHostedExecutorOperations).values(
      state === "accepted"
        ? { ...operation, state }
        : {
            ...operation,
            state,
            dispatchedGeneration: 1,
            dispatchedLeaseEpoch: 1,
            dispatchedExecutorInstanceId: "executor-local-gateway",
            dispatchedProcessIncarnation: "process-local-gateway",
          },
    ),
  ).pipe(Effect.asVoid)
}

export const operationState = (databaseClient: NodePgDatabase, operationKey: string) =>
  Effect.tryPromise(() =>
    databaseClient
      .select({ state: rikaHostedExecutorOperations.state, events: count(rikaHostedThreadEvents.eventId) })
      .from(rikaHostedExecutorOperations)
      .leftJoin(
        rikaHostedThreadEvents,
        eq(rikaHostedThreadEvents.idempotencyKey, rikaHostedExecutorOperations.operationKey),
      )
      .where(eq(rikaHostedExecutorOperations.operationKey, operationKey))
      .groupBy(rikaHostedExecutorOperations.state),
  )

export const eventually = <A>(read: () => A | undefined): Effect.Effect<A> =>
  Effect.suspend(() => {
    const value = read()
    return value === undefined ? Effect.yieldNow.pipe(Effect.andThen(eventually(read))) : Effect.succeed(value)
  })

export const pauseAssignment = (databaseClient: NodePgDatabase) =>
  Effect.tryPromise(() =>
    databaseClient
      .update(rikaHostedExecutorAssignments)
      .set({
        revision: sql`${rikaHostedExecutorAssignments.revision} + 1`,
        lifecycle: "paused",
        bootstrapDigest: null,
        bootstrapExpiresAt: null,
        executorInstanceId: null,
        processIncarnation: null,
        sessionDigest: null,
        leaseEpoch: null,
        leaseExpiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(eq(rikaHostedExecutorAssignments.id, assignmentId), eq(rikaHostedExecutorAssignments.lifecycle, "active")),
      ),
  )

export const isolated = <A, E, R>(
  run: (input: { readonly url: string; readonly databaseClient: NodePgDatabase }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const database = `rika_local_gateway_${Math.abs(yield* Random.nextInt)}`
    const admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl)
    parsed.pathname = `/${database}`
    const url = parsed.toString()
    let pool: Pool | undefined
    try {
      const activePool = yield* migrate(url)
      pool = activePool
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }))
          return yield* run({ url, databaseClient: drizzle({ client: activePool }) }).pipe(Effect.provide(context))
        }),
      )
    } finally {
      const cleanupPool = pool
      yield* cleanupPool === undefined ? Effect.void : Effect.tryPromise(() => cleanupPool.end())
      yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}"`))
      yield* Effect.tryPromise(() => admin.end())
    }
  }).pipe(livePlatform)
