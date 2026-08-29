import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as PgClient from "@effect/sql-pg/PgClient"
import { expect, it } from "@effect/vitest"
import { ControllerError } from "@rika/e2b-executor/controller"
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
  rikaHostedRunnerRegistrations,
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
import * as HostedPostgres from "@rika/product-store/layer"
import {
  ApiMessage,
  BindingRequest,
  RunnerMessage,
  type AccessWire,
  type CellResponse,
} from "@rika/remote-execution/protocol"
import { CellTerminalSettlementGraceMillis } from "@rika/remote-execution/cells"
import { NestedOperation, ToolContext } from "tenetkit"
import { HostBindingRegistry } from "tenetkit/repl"
import { and, count, eq, sql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { type PgInsertValue } from "drizzle-orm/pg-core"
import { FileSystem, Config, Context, Deferred, Effect, Fiber, Layer, Random, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { createHash } from "node:crypto"
import { Pool } from "pg"
import { live as livePlatform } from "../support/live-platform"
import { makeRunnerGateway as makeRunnerGatewayService, type RunnerGateway } from "../../src/runner/gateway"
import type { RunnerExecutorAuthority } from "../../src/runner/executor"
import type { BindingAuthority, Socket } from "../../src/executor/gateway"
import { testToolPolicy } from "../hosted/execution/tool-policy.fixture"
import * as CellAuthority from "@rika/kernel/test-cell-authority"

const makeRunnerGateway = (authority: RunnerExecutorAuthority) => makeRunnerGatewayService(authority, testToolPolicy)

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const live = databaseUrl !== ""
const encode = Schema.encodeSync(Schema.fromJsonString(RunnerMessage))
const decode = Schema.decodeSync(Schema.fromJsonString(ApiMessage))
const encodeBindingRequest = Schema.encodeSync(Schema.fromJsonString(BindingRequest))
const bindingRequestDigest = (request: BindingRequest) =>
  createHash("sha256").update(encodeBindingRequest(request)).digest("hex")
const code = 'printf "restart"'
const emptyCellContext = Effect.runSync(CellAuthority.capture())
const bindings: BindingAuthority = {
  registry: HostBindingRegistry.HostBindingRegistry.of({
    descriptors: [],
    resolve: (input) => Effect.fail(HostBindingRegistry.HostBindingNotFound.make({ module: input.module })),
    invoke: (input) => Effect.fail(HostBindingRegistry.HostBindingNotFound.make({ module: input.module })),
  }),
  context: emptyCellContext,
  manifest: { digest: "a".repeat(64), descriptors: [] },
}
const sessionToken = "session-local-gateway"
const sessionDigest = createHash("sha256").update(sessionToken).digest("hex")
const deviceId = "11111111-1111-4111-8111-111111111111"
const assignmentId = "assignment-local-gateway"
const threadId = "thread-local-gateway"
const cellRequest = (operationKey: string, deadlineAt = "2999-01-01T00:00:00.000Z") => ({
  assignmentId,
  operationKey,
  workspaceId: "workspace-local-gateway",
  sessionId: assignmentId,
  threadId,
  turnId: "turn-local-gateway",
  runId: "run-local-gateway",
  rootRunId: "run-local-gateway",
  toolCallId: "call-local-gateway",
  code,
  attempt: 0,
  replayPolicy: "pure" as const,
  admittedAt: null,
  deadlineAt,
  bindings,
})
const operationDigest = (request: ReturnType<typeof cellRequest>) =>
  createHash("sha256")
    .update(
      JSON.stringify({
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
      }),
    )
    .digest("hex")

const access: AccessWire = {
  version: 1,
  fence: {
    target: "runner",
    assignmentId,
    assignmentGeneration: 1,
    instanceId: deviceId,
    executorId: "executor-local-gateway",
    processIncarnation: "process-local-gateway",
  },
  leaseEpoch: 1,
  sessionToken,
}

const response = {
  _tag: "Success" as const,
  result: { stdout: "restart", stderr: "", exitCode: 0 },
}
const cancelledResponse = {
  _tag: "DomainFailure" as const,
  failure: { kind: "cancelled" as const, message: "Cell operation was cancelled" },
}
const environmentDigest = `sha256:${"0".repeat(64)}`
const workspaceCapabilities = {
  environmentDigest,
  capturedAt: "2026-08-21T00:00:00.000Z",
  filesystem: { _tag: "Ready", detail: "filesystem ready" },
  typescriptKernel: { _tag: "Ready", detail: "TypeScript kernel ready" },
  git: { _tag: "Ready", detail: "Git ready" },
  process: { _tag: "Ready", detail: "process ready" },
  pty: { _tag: "Ready", detail: "PTY ready" },
  browser: { _tag: "Ready", detail: "browser ready" },
  services: { _tag: "Unavailable", reason: "repository services unavailable" },
  workspaceLifecycle: { _tag: "Ready", detail: "workspace lifecycle ready" },
}

const operationAttribution = (operationKey: string) => {
  const operation = cellRequest(operationKey)
  return {
    operationKey,
    workspaceId: operation.workspaceId,
    sessionId: operation.sessionId,
    threadId: operation.threadId,
    turnId: operation.turnId,
    runId: operation.runId,
    rootRunId: operation.rootRunId,
    toolCallId: operation.toolCallId,
    attempt: operation.attempt,
  }
}

const persistTerminal = (
  gateway: RunnerGateway,
  target: Socket,
  presented: AccessWire,
  operationKey: string,
  terminalResponse: CellResponse = response,
  terminalOutcome: "completed" | "failed" | "cancelled" | "unknown" = "completed",
) =>
  Effect.gen(function* () {
    const attribution = operationAttribution(operationKey)
    for (const frame of [
      { _tag: "Accepted" as const, attribution, cursor: 1 },
      { _tag: "Started" as const, attribution, cursor: 2 },
      {
        _tag: "Terminal" as const,
        attribution,
        cursor: 3,
        outcome: terminalOutcome,
        response: terminalResponse,
      },
    ])
      yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access: presented, frame }))
  })

const socket = (): Socket & {
  failSend: boolean
  readonly sent: Array<string>
  readonly closed: Array<readonly [number | undefined, string | undefined]>
} => {
  const sent: Array<string> = []
  const closed: Array<readonly [number | undefined, string | undefined]> = []
  return {
    failSend: false,
    sent,
    closed,
    send(message: string) {
      sent.push(message)
      if (this.failSend) throw new Error("test delivery stop")
    },
    close: (status?: number, reason?: string) => closed.push([status, reason]),
  }
}

const authority = (input?: {
  readonly renewedLeaseEpoch?: number
  readonly release?: RunnerExecutorAuthority["release"]
  readonly validateAccess?: RunnerExecutorAuthority["validateAccess"]
}): RunnerExecutorAuthority => ({
  admit: () => Effect.die("unused"),
  hello: () => Effect.die("unused"),
  reconnect: (presented) =>
    Effect.succeed({
      version: 1,
      fence: presented.fence,
      leaseEpoch: input?.renewedLeaseEpoch ?? presented.leaseEpoch,
      leaseExpiresAt: 4_102_444_800_000,
      heartbeatIntervalMillis: 20_000,
      cursor: { sequence: 0, value: "" },
    }),
  validateAccess: input?.validateAccess ?? (() => Effect.void),
  workspaceIdentity: () => Effect.succeed("workspace-local-gateway"),
  heartbeat: () => Effect.die("unused"),
  release: input?.release ?? (() => Effect.void),
})

const migrate = (url: string) =>
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

const seed = (
  databaseClient: NodePgDatabase,
  operationKey: string,
  options?: {
    readonly ownerKind?: "organization" | "personal"
    readonly leaseEpoch?: number
    readonly deadlineAt?: string
    readonly state?: "accepted" | "dispatched"
    readonly leaseExpires?: "past" | "future"
  },
) =>
  Effect.gen(function* () {
    const state = options?.state ?? "dispatched"
    const deadlineAt = options?.deadlineAt ?? "2999-01-01T00:00:00.000Z"
    const digest = operationDigest(cellRequest(operationKey, deadlineAt))
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
        workspaceFingerprint: "workspace-binding",
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
        requiredCapabilities: ["filesystem", "typescriptKernel", "git", "process", "workspaceLifecycle"],
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
      workspaceId: "workspace-local-gateway",
      sessionId: assignmentId,
      threadId,
      turnId: "turn-local-gateway",
      runId: "run-local-gateway",
      rootRunId: "run-local-gateway",
      toolCallId: "call-local-gateway",
      code,
      attempt: 0,
      replayPolicy: "pure",
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

const operationState = (databaseClient: NodePgDatabase, operationKey: string) =>
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

const eventually = <A>(read: () => A | undefined): Effect.Effect<A> =>
  Effect.suspend(() => {
    const value = read()
    return value === undefined ? Effect.yieldNow.pipe(Effect.andThen(eventually(read))) : Effect.succeed(value)
  })

const pauseAssignment = (databaseClient: NodePgDatabase) =>
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

const isolated = <A, E, R>(
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

it.effect.skipIf(!live)(
  "keeps a dispatched operation after a passive disconnect and accepts the retained result after restart",
  () =>
    isolated(({ url, databaseClient }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(databaseClient, "operation-restart")
          const context = yield* Layer.build(
            Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
          )
          const first = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
          const firstSocket = socket()
          yield* first.receive(firstSocket, encode({ _tag: "ExecutorReconnect", access }))
          const attribution = operationAttribution("operation-restart")
          yield* first.receive(
            firstSocket,
            encode({ _tag: "CellLifecycle", access, frame: { _tag: "Accepted", attribution, cursor: 1 } }),
          )
          yield* first.receive(
            firstSocket,
            encode({ _tag: "CellLifecycle", access, frame: { _tag: "Started", attribution, cursor: 2 } }),
          )
          yield* first.disconnected(firstSocket)
          expect(
            yield* Effect.tryPromise(() =>
              databaseClient
                .select({ state: rikaHostedExecutorOperations.state })
                .from(rikaHostedExecutorOperations)
                .where(eq(rikaHostedExecutorOperations.operationKey, "operation-restart")),
            ),
          ).toEqual([{ state: "dispatched" }])

          const restarted = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
          const secondSocket = socket()
          yield* restarted.receive(secondSocket, encode({ _tag: "ExecutorReconnect", access }))
          expect(
            secondSocket.sent.map((value) => decode(value)).find((message) => message._tag === "CellReplay"),
          ).toEqual({
            _tag: "CellReplay",
            access,
            operationKey: "operation-restart",
            attempt: 0,
            afterCursor: 2,
          })
          const reattached = yield* Effect.forkChild(
            restarted.execute({
              ...cellRequest("operation-restart", "2026-08-25T00:02:00.000Z"),
              admittedAt: "2026-08-25T00:00:00.000Z",
            }),
          )
          expect(
            yield* eventually(() =>
              secondSocket.sent
                .map((value) => decode(value))
                .find(
                  (message) => message._tag === "CellExecute" && message.request.operationKey === "operation-restart",
                ),
            ),
          ).toMatchObject({
            _tag: "CellExecute",
            request: {
              operationKey: "operation-restart",
              admittedAt: null,
              deadlineAt: "2999-01-01T00:00:00.000Z",
            },
          })
          const bindingRequest = {
            module: "missing",
            operation: "missing",
            input: {},
            sessionId: assignmentId,
            cellId: "call-local-gateway",
          } as const
          yield* restarted.receive(
            secondSocket,
            encode({
              _tag: "BindingInvoke",
              access,
              operationKey: "operation-restart",
              attempt: 0,
              callId: "operation-restart:binding:0",
              requestDigest: bindingRequestDigest(bindingRequest),
              request: bindingRequest,
            }),
          )
          expect(
            secondSocket.sent.map((value) => decode(value)).filter((message) => message._tag === "BindingResult"),
          ).toHaveLength(1)
          yield* restarted.receive(
            secondSocket,
            encode({
              _tag: "CellLifecycle",
              access,
              frame: { _tag: "Terminal", attribution, cursor: 3, outcome: "completed", response },
            }),
          )
          const result = encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-restart",
            attempt: 0,
            response,
          })
          yield* restarted.receive(secondSocket, result)
          yield* restarted.receive(secondSocket, result)
          expect(yield* Fiber.join(reattached)).toMatchObject({ response, outcome: "completed" })
          expect(secondSocket.closed).toEqual([])
          expect(
            secondSocket.sent.map((value) => decode(value)).filter((message) => message._tag === "LocalCellReceipt"),
          ).toHaveLength(2)
          expect(yield* operationState(databaseClient, "operation-restart")).toEqual([
            { state: "completed", events: 1 },
          ])
        }),
      ),
    ),
)

it.effect.skipIf(!live)("replays the exact durable cancelled terminal without dispatching", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-cancelled")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        const cancelled = {
          _tag: "DomainFailure" as const,
          failure: { kind: "cancelled", message: "Cell operation was cancelled" },
        }
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* persistTerminal(gateway, target, access, "operation-cancelled", cancelled, "cancelled")
        const first = yield* gateway.execute(cellRequest("operation-cancelled"))
        const replay = yield* gateway.execute(cellRequest("operation-cancelled"))
        expect(first).toMatchObject({ response: cancelled, outcome: "cancelled", eventPersisted: true })
        expect(replay).toEqual(first)
        expect(
          target.sent
            .map((value) => decode(value))
            .filter(
              (message) => message._tag === "CellExecute" && message.request.operationKey === "operation-cancelled",
            ),
        ).toEqual([])
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({
                state: rikaHostedExecutorOperations.state,
                terminalOutcome: rikaHostedExecutorOperations.terminalOutcome,
                response: rikaHostedExecutorOperations.response,
              })
              .from(rikaHostedExecutorOperations)
              .where(eq(rikaHostedExecutorOperations.operationKey, "operation-cancelled")),
          ),
        ).toEqual([{ state: "completed", terminalOutcome: "cancelled", response: cancelled }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("terminalizes repeated cancellation before Runner dispatch", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "operation-cancel-accepted"
        yield* seed(databaseClient, operationKey, { state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))

        const first = yield* gateway.cancel(cellRequest(operationKey))
        const repeated = yield* gateway.cancel(cellRequest(operationKey))

        expect(repeated).toEqual(first)
        expect(first).toMatchObject({ outcome: "cancelled", eventPersisted: true })
        expect(
          target.sent
            .map((value) => decode(value))
            .filter(
              (message) =>
                (message._tag === "CellExecute" && message.request.operationKey === operationKey) ||
                (message._tag === "CellCancel" && message.operationKey === operationKey),
            ),
        ).toEqual([])
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("waits for a dispatched Runner cancellation terminal and redelivers after restart", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "operation-cancel-restart"
        const cancelled = {
          _tag: "DomainFailure" as const,
          failure: { kind: "cancelled", message: "Cell operation was cancelled" },
        }
        yield* seed(databaseClient, operationKey)
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const first = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const firstSocket = socket()
        yield* first.receive(firstSocket, encode({ _tag: "ExecutorReconnect", access }))
        const interrupted = yield* Effect.forkChild(first.cancel(cellRequest(operationKey)))
        yield* eventually(() =>
          firstSocket.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellCancel" && message.operationKey === operationKey),
        )
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "dispatched", events: 0 }])
        yield* first.disconnected(firstSocket)
        yield* Fiber.interrupt(interrupted)

        const restarted = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const secondSocket = socket()
        yield* restarted.receive(secondSocket, encode({ _tag: "ExecutorReconnect", access }))
        const cancelling = yield* Effect.forkChild(restarted.cancel(cellRequest(operationKey)))
        yield* eventually(() =>
          secondSocket.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellCancel" && message.operationKey === operationKey),
        )
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "dispatched", events: 0 }])

        yield* persistTerminal(restarted, secondSocket, access, operationKey, cancelled, "cancelled")
        yield* TestClock.adjust("100 millis")
        expect(yield* Fiber.join(cancelling)).toMatchObject({
          response: cancelled,
          outcome: "cancelled",
          eventPersisted: true,
        })
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("accepts the Runner terminal that arrives after the caller deadline", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const deadlineAt = "1970-01-01T00:00:01.000Z"
        yield* seed(databaseClient, "operation-deadline-first", { deadlineAt })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        const cancelled = {
          _tag: "DomainFailure" as const,
          failure: { kind: "cancelled", message: "Cell operation was cancelled" },
        }
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        const running = yield* Effect.forkChild(gateway.execute(cellRequest("operation-deadline-first", deadlineAt)))
        yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find(
              (message) =>
                message._tag === "CellExecute" && message.request.operationKey === "operation-deadline-first",
            ),
        )
        yield* TestClock.adjust("1 second")
        expect(running.pollUnsafe()).toBeUndefined()
        expect(
          target.sent
            .map((value) => decode(value))
            .some((message) => message._tag === "CellCancel" && message.operationKey === "operation-deadline-first"),
        ).toBe(false)
        yield* TestClock.adjust("100 millis")
        yield* persistTerminal(gateway, target, access, "operation-deadline-first", cancelled, "cancelled")
        expect(yield* Fiber.join(running)).toMatchObject({
          response: cancelled,
          outcome: "cancelled",
          eventPersisted: true,
        })
        yield* gateway.receive(
          target,
          encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-deadline-first",
            attempt: 0,
            response: cancelled,
          }),
        )
        expect(target.closed).toEqual([])
        expect(
          target.sent
            .map((value) => decode(value))
            .some(
              (message) =>
                message._tag === "CellTerminalReceipt" && message.operationKey === "operation-deadline-first",
            ),
        ).toBe(true)
        expect(
          target.sent
            .map((value) => decode(value))
            .some(
              (message) => message._tag === "LocalCellReceipt" && message.operationKey === "operation-deadline-first",
            ),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({
                state: rikaHostedExecutorOperations.state,
                terminalOutcome: rikaHostedExecutorOperations.terminalOutcome,
                response: rikaHostedExecutorOperations.response,
              })
              .from(rikaHostedExecutorOperations)
              .where(eq(rikaHostedExecutorOperations.operationKey, "operation-deadline-first")),
          ),
        ).toEqual([{ state: "completed", terminalOutcome: "cancelled", response: cancelled }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("atomically persists one accepted deadline result across concurrent gateways", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const deadlineAt = "1970-01-01T00:00:00.000Z"
        const operationKey = "operation-accepted-deadline"
        yield* seed(databaseClient, operationKey, { deadlineAt, state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        yield* Effect.tryPromise(() =>
          databaseClient.execute(sql`CREATE FUNCTION rika_test_reject_deadline_event() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'injected deadline event failure'; END
          $$;
          CREATE TRIGGER rika_test_reject_deadline_event
            BEFORE INSERT ON rika_hosted_thread_events
            FOR EACH ROW EXECUTE FUNCTION rika_test_reject_deadline_event()`),
        )
        const faulty = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        expect((yield* Effect.result(faulty.execute(cellRequest(operationKey, deadlineAt))))._tag).toBe("Failure")
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "accepted", events: 0 }])
        yield* Effect.tryPromise(() =>
          databaseClient.execute(sql`DROP TRIGGER rika_test_reject_deadline_event ON rika_hosted_thread_events;
          DROP FUNCTION rika_test_reject_deadline_event()`),
        )
        const first = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const second = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const results = yield* Effect.all(
          [first.execute(cellRequest(operationKey, deadlineAt)), second.execute(cellRequest(operationKey, deadlineAt))],
          { concurrency: "unbounded" },
        )
        const timeout = {
          _tag: "DomainFailure" as const,
          failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
        }
        expect(results).toEqual([
          { response: timeout, outcome: "failed", eventPersisted: true },
          { response: timeout, outcome: "failed", eventPersisted: true },
        ])

        const restarted = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        expect(yield* restarted.execute(cellRequest(operationKey, deadlineAt))).toEqual(results[0])
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "completed", events: 1 }])
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ event: rikaHostedThreadEvents.event })
              .from(rikaHostedThreadEvents)
              .where(eq(rikaHostedThreadEvents.idempotencyKey, operationKey)),
          ),
        ).toEqual([{ event: { _tag: "CellResult", operationKey, response: timeout } }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("settles active Local Runner machine work before accepting a cancelled Cell terminal", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "operation-cancelled-machine"
        yield* seed(databaseClient, operationKey, { state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        const running = yield* Effect.forkChild(gateway.execute(cellRequest(operationKey)))
        yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellExecute" && message.request.operationKey === operationKey),
        )
        const machine = yield* Effect.forkChild(
          gateway.machine(assignmentId, operationKey, 0, {
            _tag: "CodingTool",
            request: { _tag: "Bash", command: "sleep 30" },
          }),
        )
        const machineRequest = yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "MachineExecute" && message.operationKey === operationKey),
        )
        if (machineRequest._tag !== "MachineExecute") return yield* Effect.die("machine request was not sent")

        for (const frame of [
          { _tag: "Accepted" as const, attribution: operationAttribution(operationKey), cursor: 1 },
          { _tag: "Started" as const, attribution: operationAttribution(operationKey), cursor: 2 },
        ])
          yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access, frame }))
        yield* Fiber.interrupt(running)
        const cancelling = yield* Effect.forkChild(gateway.cancel(cellRequest(operationKey)))
        yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellCancel" && message.operationKey === operationKey),
        )
        yield* gateway.receive(
          target,
          encode({
            _tag: "CellLifecycle",
            access,
            frame: {
              _tag: "Terminal",
              attribution: operationAttribution(operationKey),
              cursor: 3,
              outcome: "cancelled",
              response: cancelledResponse,
            },
          }),
        )
        expect(machine.pollUnsafe()).toBeDefined()
        expect(yield* Fiber.join(machine)).toEqual({ _tag: "Cancelled" })
        expect(yield* Fiber.join(cancelling)).toEqual({
          access,
          response: cancelledResponse,
          outcome: "cancelled",
          eventPersisted: true,
        })

        const nextOperationKey = "operation-after-cancelled-machine"
        yield* Effect.tryPromise(() =>
          databaseClient.insert(rikaHostedExecutorOperations).values({
            assignmentId,
            ownerId: "organization-owner-local-gateway",
            operationKey: nextOperationKey,
            requestDigest: operationDigest(cellRequest(nextOperationKey)),
            workspaceId: "workspace-local-gateway",
            sessionId: assignmentId,
            threadId,
            turnId: "turn-local-gateway",
            runId: "run-local-gateway",
            rootRunId: "run-local-gateway",
            toolCallId: "call-local-gateway",
            code,
            attempt: 0,
            replayPolicy: "pure",
            deadlineAt: sql`'2999-01-01T00:00:00.000Z'::timestamptz`,
            state: "accepted",
            updatedAt: sql`transaction_timestamp()`,
          }),
        )
        const next = yield* Effect.forkChild(gateway.execute(cellRequest(nextOperationKey)))
        yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellExecute" && message.request.operationKey === nextOperationKey),
        )
        const nextMachine = yield* Effect.forkChild(
          gateway.machine(assignmentId, nextOperationKey, 0, {
            _tag: "ProcessStop",
            processId: "process-after-cancel",
          }),
        )
        const nextMachineRequest = yield* eventually(() =>
          target.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "MachineExecute" && message.operationKey === nextOperationKey),
        )
        if (nextMachineRequest._tag !== "MachineExecute") return yield* Effect.die("next machine request was not sent")
        yield* gateway.receive(
          target,
          encode({
            _tag: "MachineResult",
            access,
            operationKey: nextOperationKey,
            attempt: 0,
            machineId: nextMachineRequest.machineId,
            requestDigest: nextMachineRequest.requestDigest,
            outcome: { _tag: "Success", value: { _tag: "ProcessStopped" } },
          }),
        )
        expect(yield* Fiber.join(nextMachine)).toEqual({ _tag: "Success", value: { _tag: "ProcessStopped" } })
        yield* persistTerminal(gateway, target, access, nextOperationKey)
        expect(yield* Fiber.join(next)).toMatchObject({ response, outcome: "completed", eventPersisted: true })

        yield* gateway.receive(
          target,
          encode({
            _tag: "MachineResult",
            access,
            operationKey,
            attempt: 0,
            machineId: machineRequest.machineId,
            requestDigest: machineRequest.requestDigest,
            outcome: {
              _tag: "Success",
              value: { _tag: "CodingTool", result: { text: "late", truncated: false } },
            },
          }),
        )
        expect(target.closed).toEqual([])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("bounds reconnected binding and machine work by the parent deadline", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const deadlineAt = "1970-01-01T00:00:01.000Z"
        const operationKey = "operation-machine-reconnect"
        const invocationStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const releaseCleanup = yield* Deferred.make<void>()
        const cleanupCompleted = yield* Deferred.make<void>()
        const signal = yield* Effect.abortSignal
        const bindingContext = Context.empty().pipe(
          Context.add(
            ToolContext.ToolContext,
            ToolContext.ToolContext.of({
              signal,
              emit: () => Effect.void,
              sessionId: assignmentId,
              runId: "run-local-gateway",
              toolCallId: "call-local-gateway",
              operationKey,
            }),
          ),
          Context.add(
            NestedOperation.NestedOperations,
            NestedOperation.NestedOperations.of({ run: (_request, operation) => operation }),
          ),
        )
        const registry = HostBindingRegistry.HostBindingRegistry.of({
          descriptors: [{ module: "workspace", operations: ["read"] }],
          resolve: () => Effect.die("unused"),
          invoke: () =>
            Deferred.succeed(invocationStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(cleanupStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCleanup)),
                  Effect.andThen(Deferred.succeed(cleanupCompleted, undefined)),
                ),
              ),
            ),
        })
        const operationBindings: BindingAuthority = {
          registry,
          context: Context.merge(bindingContext, emptyCellContext),
          manifest: { digest: "c".repeat(64), descriptors: registry.descriptors },
        }
        yield* seed(databaseClient, operationKey, { deadlineAt, state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const first = socket()
        yield* gateway.receive(first, encode({ _tag: "ExecutorReconnect", access }))
        const running = yield* Effect.forkChild(
          gateway.execute({ ...cellRequest(operationKey, deadlineAt), bindings: operationBindings }),
        )
        yield* eventually(() =>
          first.sent
            .map((value) => decode(value))
            .find((message) => message._tag === "CellExecute" && message.request.operationKey === operationKey),
        )
        const machine = yield* Effect.forkChild(
          gateway.machine(assignmentId, operationKey, 0, { _tag: "ProcessStop", processId: "process-1" }),
        )
        const machineRequest = yield* eventually(() =>
          first.sent.map((value) => decode(value)).find((message) => message._tag === "MachineExecute"),
        )
        if (machineRequest._tag !== "MachineExecute") return yield* Effect.die("machine request was not sent")

        yield* gateway.disconnected(first)
        const second = socket()
        yield* gateway.receive(second, encode({ _tag: "ExecutorReconnect", access }))
        expect(
          second.sent.map((value) => decode(value)).filter((message) => message._tag === "MachineExecute"),
        ).toEqual([
          expect.objectContaining({
            _tag: "MachineExecute",
            operationKey,
            machineId: machineRequest.machineId,
          }),
        ])

        const bindingRequest = {
          module: "workspace",
          operation: "read",
          input: { path: "README.md" },
          sessionId: assignmentId,
          cellId: "call-local-gateway",
        } as const
        const binding = yield* Effect.forkChild(
          gateway.receive(
            second,
            encode({
              _tag: "BindingInvoke",
              access,
              operationKey,
              attempt: 0,
              callId: `${operationKey}:binding:0`,
              requestDigest: bindingRequestDigest(bindingRequest),
              request: bindingRequest,
            }),
          ),
        )
        yield* Deferred.await(invocationStarted)
        const advancing = yield* Effect.forkChild(TestClock.adjust("1 second"))
        yield* Deferred.await(cleanupStarted)
        expect(yield* Fiber.join(machine)).toEqual({
          _tag: "Unknown",
          message: "Machine outcome is unknown at the operation deadline",
        })
        expect(running.pollUnsafe()).toBeUndefined()
        expect(binding.pollUnsafe()).toBeUndefined()
        expect(second.sent.map((value) => decode(value)).filter((message) => message._tag === "BindingResult")).toEqual(
          [],
        )
        yield* Deferred.succeed(releaseCleanup, undefined)
        yield* Deferred.await(cleanupCompleted)
        yield* Fiber.join(binding)
        yield* Fiber.join(advancing)
        yield* TestClock.adjust(CellTerminalSettlementGraceMillis)
        expect(yield* Fiber.join(running)).toMatchObject({ outcome: "unknown", eventPersisted: false })
        expect(second.sent.map((value) => decode(value)).filter((message) => message._tag === "BindingResult")).toEqual(
          [
            expect.objectContaining({
              _tag: "BindingResult",
              outcome: { _tag: "Unknown", message: "Cell binding outcome is unknown at the operation deadline" },
            }),
          ],
        )

        yield* gateway.disconnected(second)
        const third = socket()
        yield* gateway.receive(third, encode({ _tag: "ExecutorReconnect", access }))
        expect(third.sent.map((value) => decode(value)).filter((message) => message._tag === "MachineExecute")).toEqual(
          [],
        )
        yield* gateway.receive(
          third,
          encode({
            _tag: "MachineResult",
            access,
            operationKey,
            attempt: 0,
            machineId: machineRequest.machineId,
            requestDigest: machineRequest.requestDigest,
            outcome: { _tag: "Success", value: { _tag: "ProcessStopped" } },
          }),
        )
        expect(third.closed).toEqual([])
        expect(third.sent.map((value) => decode(value)).filter((message) => message._tag === "BindingResult")).toEqual(
          [],
        )
      }),
    ),
  ),
)

it.effect.skipIf(!live)("fences organization dispatch immediately after membership deletion", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-revoked-membership", { state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* Effect.tryPromise(() =>
          databaseClient.delete(identityMember).where(eq(identityMember.id, "member-local-gateway")),
        )
        const error = yield* gateway.execute(cellRequest("operation-revoked-membership")).pipe(Effect.flip)
        expect(error).toMatchObject({
          kind: "fenced",
          message: "Runner fence is no longer current",
        })
        expect(yield* operationState(databaseClient, "operation-revoked-membership")).toEqual([
          { state: "accepted", events: 0 },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("durably revokes a Runner immediately after device revocation", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-revoked-device", { state: "accepted" })
        yield* Effect.tryPromise(() =>
          databaseClient.insert(rikaHostedRunnerRegistrations).values({
            deviceId,
            userId: "user-local-gateway",
            checkoutFingerprint: "checkout-local-gateway",
            workspaceId: "workspace-local-gateway",
            repository: {},
            kernelProfile: {},
            capabilities: {},
          }),
        )
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        let active = true
        const gateway = yield* makeRunnerGateway(
          authority({
            validateAccess: () =>
              active ? Effect.void : Effect.fail(ControllerError.make({ kind: "fenced", message: "revoked" })),
          }),
        ).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* Effect.yieldNow
        expect(yield* gateway.active(target)).toBe(true)

        yield* Effect.tryPromise(() =>
          databaseClient
            .update(cliRegistration)
            .set({ revokedAt: sql`transaction_timestamp()` })
            .where(eq(cliRegistration.clientId, "client-local-gateway")),
        )

        active = false
        expect(yield* gateway.active(target)).toBe(false)
        yield* gateway.receive(
          target,
          encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-revoked-device",
            attempt: 0,
            response,
          }),
        )
        yield* Effect.yieldNow
        expect(target.closed).toContainEqual([1008, "fenced"])
        const revoked = yield* Effect.tryPromise(() =>
          databaseClient
            .select({
              deviceRevokedAt: rikaHostedDevices.revokedAt,
              clientRevokedAt: rikaHostedClients.revokedAt,
              admissionRevokedAt: rikaHostedRunnerAdmissions.revokedAt,
              lifecycle: rikaHostedExecutorAssignments.lifecycle,
              generation: rikaHostedExecutorAssignments.generation,
            })
            .from(rikaHostedDevices)
            .innerJoin(rikaHostedClients, eq(rikaHostedClients.deviceId, rikaHostedDevices.id))
            .innerJoin(rikaHostedRunnerAdmissions, eq(rikaHostedRunnerAdmissions.clientId, rikaHostedClients.id))
            .innerJoin(
              rikaHostedExecutorAssignments,
              eq(rikaHostedExecutorAssignments.id, rikaHostedRunnerAdmissions.assignmentId),
            )
            .where(eq(rikaHostedDevices.id, deviceId)),
        )
        const registered = yield* Effect.tryPromise(() =>
          databaseClient.select({ count: count() }).from(rikaHostedRunnerRegistrations),
        )
        expect(
          revoked.map((row) => ({
            deviceRevoked: row.deviceRevokedAt !== null,
            clientRevoked: row.clientRevokedAt !== null,
            admissionRevoked: row.admissionRevokedAt !== null,
            lifecycle: row.lifecycle,
            generation: row.generation,
            runnerRegistered: (registered[0]?.count ?? 0) !== 0,
          })),
        ).toEqual([
          {
            deviceRevoked: true,
            clientRevoked: true,
            admissionRevoked: true,
            lifecycle: "terminated",
            generation: 2,
            runnerRegistered: false,
          },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("rejects dispatch after the admitted workspace environment digest changes", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-environment-changed", { state: "accepted" })
        yield* Effect.tryPromise(() =>
          databaseClient
            .update(rikaHostedExecutorAssignments)
            .set({ capabilitySnapshot: { ...workspaceCapabilities, environmentDigest: `sha256:${"1".repeat(64)}` } })
            .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
        )
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        expect(yield* gateway.execute(cellRequest("operation-environment-changed")).pipe(Effect.flip)).toMatchObject({
          kind: "fenced",
          message: "Runner fence is no longer current",
        })
        expect(yield* operationState(databaseClient, "operation-environment-changed")).toEqual([
          { state: "accepted", events: 0 },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("keeps uncertain delivery dispatched for receipt replay", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-personal", { ownerKind: "personal", state: "accepted" })
        expect(yield* Effect.tryPromise(() => databaseClient.select({ count: count() }).from(identityMember))).toEqual([
          { count: 0 },
        ])
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        target.failSend = true
        const running = yield* Effect.forkChild(gateway.execute(cellRequest("operation-personal")))
        yield* eventually(() =>
          target.sent.map((value) => decode(value)).find((message) => message._tag === "CellExecute"),
        )
        yield* Fiber.interrupt(running)
        expect(target.sent.map((value) => decode(value)).some((message) => message._tag === "CellCancel")).toBe(false)
        expect(yield* operationState(databaseClient, "operation-personal")).toEqual([
          { state: "dispatched", events: 0 },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)(
  "rejects a completion whose current assignment lease does not match the presented session",
  () =>
    isolated(({ url, databaseClient }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(databaseClient, "operation-stale", { leaseEpoch: 1 })
          const context = yield* Layer.build(
            Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
          )
          const gateway = yield* makeRunnerGateway(authority({ renewedLeaseEpoch: 2 })).pipe(Effect.provide(context))
          const target = socket()
          const renewed = { ...access, leaseEpoch: 2 }
          yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access: renewed }))
          yield* persistTerminal(gateway, target, renewed, "operation-stale")
          expect(target.closed).toEqual([[1008, "fenced"]])
          expect(
            yield* Effect.tryPromise(() =>
              databaseClient
                .select({ state: rikaHostedExecutorOperations.state })
                .from(rikaHostedExecutorOperations)
                .where(eq(rikaHostedExecutorOperations.operationKey, "operation-stale")),
            ),
          ).toEqual([{ state: "dispatched" }])
        }),
      ),
    ),
)

it.effect.skipIf(!live)("accepts a retained completion after reconnect renews the assignment lease", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-renewed")
        yield* Effect.tryPromise(() =>
          databaseClient
            .update(rikaHostedExecutorAssignments)
            .set({ lastLeaseEpoch: 2, leaseEpoch: 2 })
            .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
        )
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority({ renewedLeaseEpoch: 2 })).pipe(Effect.provide(context))
        const target = socket()
        const renewed = { ...access, leaseEpoch: 2 }
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access: renewed }))
        yield* persistTerminal(gateway, target, renewed, "operation-renewed")
        yield* gateway.receive(
          target,
          encode({
            _tag: "LocalCellResult",
            access: renewed,
            operationKey: "operation-renewed",
            attempt: 0,
            response,
          }),
        )
        expect(target.closed).toEqual([])
        expect(
          target.sent.map((value) => decode(value)).filter((message) => message._tag === "LocalCellReceipt"),
        ).toHaveLength(1)
        expect(yield* operationState(databaseClient, "operation-renewed")).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("rejects a conflicting completion after a durable result already exists", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-conflict")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* persistTerminal(gateway, target, access, "operation-conflict")
        yield* gateway.receive(
          target,
          encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-conflict",
            attempt: 0,
            response,
          }),
        )
        yield* gateway.receive(
          target,
          encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-conflict",
            attempt: 0,
            response: { _tag: "Success", result: { stdout: "other", stderr: "", exitCode: 1 } },
          }),
        )
        expect(target.closed).toEqual([[1008, "fenced"]])
        expect(yield* operationState(databaseClient, "operation-conflict")).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("reports an overdue dispatch without replacing the Runner's terminal authority", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const deadlineAt = "1970-01-01T00:00:01.000Z"
        yield* seed(databaseClient, "operation-overdue", { deadlineAt })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const left = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const right = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        yield* TestClock.adjust("1 second")
        const waiting = yield* Effect.forkChild(
          Effect.all(
            [
              left.execute(cellRequest("operation-overdue", deadlineAt)),
              right.execute(cellRequest("operation-overdue", deadlineAt)),
            ],
            { concurrency: 2 },
          ),
        )
        yield* TestClock.adjust(CellTerminalSettlementGraceMillis)
        const results = yield* Fiber.join(waiting)
        expect(results.map((result) => result.response)).toEqual([
          {
            _tag: "DomainFailure",
            failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
          },
          {
            _tag: "DomainFailure",
            failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
          },
        ])
        expect(results.map((result) => result.eventPersisted)).toEqual([false, false])
        expect(yield* operationState(databaseClient, "operation-overdue")).toEqual([{ state: "dispatched", events: 0 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("does not infer an operation outcome from assignment lease expiry", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-expired-lease", { leaseExpires: "past" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        expect(yield* operationState(databaseClient, "operation-expired-lease")).toEqual([
          { state: "dispatched", events: 0 },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("publishes a durable terminal receipt after the assignment lease expires", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "operation-terminal-expired-lease"
        yield* seed(databaseClient, operationKey)
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const connected = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* connected.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* persistTerminal(connected, target, access, operationKey)
        yield* Effect.tryPromise(() =>
          databaseClient
            .update(rikaHostedExecutorAssignments)
            .set({ leaseExpiresAt: sql`transaction_timestamp() - interval '1 second'` })
            .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
        )

        const restarted = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        expect(yield* restarted.execute(cellRequest(operationKey))).toMatchObject({
          response,
          outcome: "completed",
          eventPersisted: true,
        })
        expect(yield* operationState(databaseClient, operationKey)).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("releases the assignment without inventing terminal work on explicit goodbye", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-goodbye")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(
          authority({
            release: () =>
              pauseAssignment(databaseClient).pipe(
                Effect.asVoid,
                Effect.mapError((error) => ControllerError.make({ kind: "checkpoint", message: error.message })),
              ),
          }),
        ).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* gateway.receive(target, encode({ _tag: "RunnerGoodbye", access }))
        expect(target.closed).toEqual([[1000, "shutdown"]])
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ lifecycle: rikaHostedExecutorAssignments.lifecycle })
              .from(rikaHostedExecutorAssignments)
              .where(eq(rikaHostedExecutorAssignments.id, assignmentId)),
          ),
        ).toEqual([{ lifecycle: "paused" }])
        expect(yield* operationState(databaseClient, "operation-goodbye")).toEqual([{ state: "dispatched", events: 0 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("accepts a retained completion on the same gateway after a passive disconnect", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-live")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const firstSocket = socket()
        yield* gateway.receive(firstSocket, encode({ _tag: "ExecutorReconnect", access }))
        yield* gateway.disconnected(firstSocket)
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ state: rikaHostedExecutorOperations.state })
              .from(rikaHostedExecutorOperations)
              .where(eq(rikaHostedExecutorOperations.operationKey, "operation-live")),
          ),
        ).toEqual([{ state: "dispatched" }])
        const secondSocket = socket()
        yield* gateway.receive(secondSocket, encode({ _tag: "ExecutorReconnect", access }))
        yield* persistTerminal(gateway, secondSocket, access, "operation-live")
        yield* gateway.receive(
          secondSocket,
          encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-live",
            attempt: 0,
            response,
          }),
        )
        expect(secondSocket.closed).toEqual([])
        expect(yield* operationState(databaseClient, "operation-live")).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("closes a local PTY frame as malformed", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(databaseClient, "operation-pty")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* gateway.receive(
          target,
          '{"_tag":"PtyOpened","access":{"version":1,"fence":{"target":"runner","assignmentId":"assignment-local-gateway","assignmentGeneration":1,"instanceId":"11111111-1111-4111-8111-111111111111","executorId":"executor-local-gateway","processIncarnation":"process-local-gateway"},"leaseEpoch":1,"sessionToken":"session-local-gateway"},"pty":{"ptyId":"pty-1","command":"bash","cwd":"/tmp","cols":80,"rows":24}}',
        )
        expect(target.closed).toEqual([[1007, "malformed"]])
        expect(
          yield* Effect.tryPromise(() =>
            databaseClient
              .select({ state: rikaHostedExecutorOperations.state })
              .from(rikaHostedExecutorOperations)
              .where(eq(rikaHostedExecutorOperations.operationKey, "operation-pty")),
          ),
        ).toEqual([{ state: "dispatched" }])
      }),
    ),
  ),
)
