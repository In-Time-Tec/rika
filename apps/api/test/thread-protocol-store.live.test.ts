import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMigrations, runMigration } from "@rika/identity"
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
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedStore } from "@rika/product/hosted-store"
import type { HostedThreadSnapshot } from "@rika/product/client-protocol"
import type { InteractiveCommand } from "@rika/product/interactive-command"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { TurnId } from "@rika/product/turn-record"
import { migrations } from "@rika/product-store/migrations"
import { layer } from "@rika/product-store/postgres-layer"
import { Context, DateTime, Effect, Layer, Random, Redacted } from "effect"
import { Pool } from "pg"
import { HostedThreadApplication, type HostedThreadApplicationService } from "../src/hosted-thread-application"
import { HostedProduct, type HostedProductService } from "../src/hosted-product"
import {
  HostedThreadProtocol,
  layer as hostedThreadProtocolLayer,
  threadWebSocketAudience,
} from "../src/hosted-thread-protocol"
import { HostedToolPolicy } from "../src/hosted-tool-policy"
import { HostedWorkspace } from "../src/hosted-workspace"
import { testToolPolicy } from "./hosted-tool-policy-fixture"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
const live = databaseUrl !== undefined
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
      expiresAt: authorityExpiresAt,
    })
    yield* hosted.grantClientAuthority({
      ownerId,
      actor,
      now,
      expiresAt: authorityExpiresAt,
    })
    yield* hosted.createWorkspace({
      id: workspaceId,
      ownerId,
      createdByUserId: userId,
      executorKind: "runner",
      now,
    })
    yield* hosted.createThread({
      id: threadId,
      ownerId,
      workspaceId,
      createdByUserId: userId,
      executorKind: "runner",
      now,
    })
    const protocol = yield* ThreadProtocolStore
    yield* protocol.initializeThread({ ownerId, threadId, actor })
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
      const replay = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 100,
      })
      expect(replay).toMatchObject({ threadVersion: "2", cursor: "2", snapshot: { cursor: "1" } })
      expect(replay.events.map((event) => event.cursor)).toEqual(["2"])
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

it.effect.skipIf(!live)("converges duplicate, reordered, and delayed controller frames with durable decisions", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocolStore = yield* setup(pool)
      const checkpoint = {
        version: ExecutionProjection.projectionVersion,
        cursor: "authorization-cursor",
        state: '{"operation":"shell","arguments":"bun test"}',
      }
      let currentSnapshot: HostedThreadSnapshot = snapshot
      const effects: Array<InteractiveCommand> = []
      const runs: Array<Parameters<HostedProductService["admitRun"]>[0]> = []
      const product: HostedProductService = {
        ready: Effect.void,
        projects: () => Effect.succeed([]),
        createProject: () => Effect.die("unused"),
        activatePrincipal: () => Effect.void,
        createConnection: () => Effect.die("unused"),
        authorizeThread: () => Effect.succeed({ ownerId, actor }),
        threadExecutionContext: () =>
          Effect.succeed({
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
            return { commandId: input.operationKey, turnId: `turn-${input.operationKey}`, status: "queued" as const }
          }),
      }
      const operations: HostedThreadApplicationService = {
        thread: () => Effect.succeed(currentSnapshot.thread),
        snapshot: () => Effect.succeed(currentSnapshot),
        interactive: (input) =>
          Effect.sync(() => {
            effects.push(input.command)
            if (input.command._tag === "ApproveAuthorization" || input.command._tag === "DenyAuthorization") {
              currentSnapshot = { ...currentSnapshot, pendingAuthorizations: [] }
              return []
            }
            return [{ _tag: "ExecutionControlled" as const, selectionEpoch: 0, action: "cancelled" as const }]
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
      const protocol = Context.get(
        yield* Layer.build(hostedThreadProtocolLayer.pipe(Layer.provide(dependencies))),
        HostedThreadProtocol,
      )
      const principal = { userId, clientId, deviceId }
      const open = Effect.gen(function* () {
        const ticket = yield* protocol.issueTicket(principal)
        return yield* protocol.connect(ticket.ticket, threadWebSocketAudience)
      })
      const [controllerA, controllerB] = yield* Effect.all([open, open], { concurrency: "unbounded" })
      for (const [session, requestId] of [
        [controllerA, "attach-a"],
        [controllerB, "attach-b"],
      ] as const)
        expect(
          yield* session.receive({
            protocolVersion: 1,
            requestId: requestId as never,
            command: { _tag: "AttachThread", threadId, afterCursor: ThreadEventCursor.make("0") },
          }),
        ).toMatchObject([{ payload: { _tag: "ThreadSnapshot", threadVersion: "0", cursor: "0" } }])

      const duplicate = {
        protocolVersion: 1 as const,
        requestId: "duplicate-a" as never,
        command: {
          _tag: "SubmitPrompt" as const,
          commandId: CommandId.make("duplicate-submit"),
          idempotencyKey: IdempotencyKey.make("duplicate-submit-key"),
          expectedThreadVersion: ThreadVersion.make("0"),
          text: "queue once",
        },
      }
      const duplicateResponses = yield* Effect.all(
        [controllerA.receive(duplicate), controllerB.receive({ ...duplicate, requestId: "duplicate-b" as never })],
        { concurrency: "unbounded" },
      )
      expect(
        duplicateResponses
          .flat()
          .filter((frame) => frame.payload._tag === "CommandAccepted" || frame.payload._tag === "CommandRejected"),
      ).toHaveLength(2)
      expect(runs.filter((input) => input.operationKey === "duplicate-submit")).toHaveLength(1)
      expect(
        yield* controllerA.receive({ ...duplicate, requestId: "duplicate-after-completion" as never }),
      ).toMatchObject([{ payload: { _tag: "CommandAccepted", threadVersion: "1", cursor: "1" } }])
      expect(effects).toHaveLength(0)

      const contender = (id: string, requestId: string) => ({
        protocolVersion: 1 as const,
        requestId: requestId as never,
        command: {
          _tag: "SubmitPrompt" as const,
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
      expect(racedPayloads.filter((payload) => payload._tag === "CommandAccepted")).toHaveLength(1)
      const stale = racedPayloads.find((payload) => payload._tag === "CommandRejected")
      expect(stale).toMatchObject({
        _tag: "CommandRejected",
        reason: "stale-version",
        currentThreadVersion: "2",
      })
      expect(stale?.currentCursor).toBe("1")
      const staleIndex = stale?.requestId === "controller-a-request" ? 0 : 1
      const delayed = contenders[staleIndex]!
      const delayedSession = staleIndex === 0 ? controllerA : controllerB
      expect(
        yield* delayedSession.receive({
          ...delayed,
          requestId: "delayed-resync" as never,
          command: { ...delayed.command, expectedThreadVersion: ThreadVersion.make("2") },
        }),
      ).toMatchObject([
        { payload: { _tag: "CommandAccepted", threadVersion: "3", cursor: "3" } },
        {
          payload: {
            _tag: "ThreadEvent",
            event: {
              cursor: "3",
              event: { _tag: "SubmissionAdmitted", submissionId: delayed.command.commandId },
            },
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
      const approvalController = yield* open
      expect(
        yield* approvalController.receive({
          protocolVersion: 1,
          requestId: "approval-attach" as never,
          command: { _tag: "AttachThread", threadId, afterCursor: ThreadEventCursor.make("3") },
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "ThreadSnapshot",
            threadVersion: "3",
            cursor: "3",
            snapshot: { pendingAuthorizations: [{ authorizationId: "authorization-1", checkpoint }] },
          },
        },
      ])
      const approval = {
        protocolVersion: 1 as const,
        requestId: "approval-request" as never,
        command: {
          _tag: "Approve" as const,
          commandId: CommandId.make("approval-command"),
          idempotencyKey: IdempotencyKey.make("approval-key"),
          expectedThreadVersion: ThreadVersion.make("3"),
          turnId: TurnId.make("approval-turn"),
          authorizationId: "authorization-1",
          checkpoint,
        },
      }
      expect(yield* approvalController.receive(approval)).toMatchObject([
        { payload: { _tag: "CommandAccepted", threadVersion: "4", result: { _tag: "Applied" } } },
      ])
      expect(yield* approvalController.receive({ ...approval, requestId: "approval-retry" as never })).toMatchObject([
        { payload: { _tag: "CommandAccepted", threadVersion: "4" } },
      ])
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
        yield* approvalController.receive({
          ...approval,
          requestId: "cross-thread-approval" as never,
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
        yield* approvalController.receive({
          protocolVersion: 1,
          requestId: "denial-request" as never,
          command: {
            _tag: "Deny",
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

      const audit = yield* query(
        pool,
        `SELECT actor, command, result FROM rika_hosted_thread_protocol_commands WHERE command_id = $1`,
        ["approval-command"],
      )
      expect(audit.rows).toMatchObject([
        {
          actor,
          command: {
            _tag: "Approve",
            turnId: "approval-turn",
            authorizationId: "authorization-1",
            checkpoint,
          },
          result: {
            _tag: "Applied",
            authorization: {
              actor,
              turnId: "approval-turn",
              authorizationId: "authorization-1",
              checkpoint,
              operation: "shell",
              capability: "process",
              arguments: "bun test",
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
              decision: "approve",
              result: { _tag: "Delivered" },
            },
          },
        },
      ])
      const denialAudit = yield* query(
        pool,
        `SELECT result FROM rika_hosted_thread_protocol_commands WHERE command_id = $1`,
        ["denial-command"],
      )
      expect(denialAudit.rows).toMatchObject([
        {
          result: {
            _tag: "Applied",
            authorization: {
              actor,
              turnId: "denial-turn",
              authorizationId: "authorization-2",
              checkpoint: denialCheckpoint,
              operation: "write-file",
              capability: "filesystem",
              arguments: '{"path":"README.md"}',
              repository: { repositoryId: "repository-1", branch: "feature/thread-controls" },
              branch: "feature/thread-controls",
              executor: { assignmentId, generation: "7", executorInstanceId: "executor-1" },
              decision: "deny",
              result: { _tag: "Delivered" },
            },
          },
        },
      ])

      yield* protocolStore.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: later,
      })
      const replayController = yield* open
      const replay = yield* replayController.receive({
        protocolVersion: 1,
        requestId: "replay-attach" as never,
        command: { _tag: "AttachThread", threadId, afterCursor: ThreadEventCursor.make("0") },
      })
      expect(replay).toMatchObject([
        { payload: { _tag: "ThreadSnapshot", threadVersion: "6", cursor: "3" } },
        {
          payload: {
            _tag: "ThreadEvent",
            event: { cursor: "4", event: { _tag: "ExecutionControlled", action: "cancelled" } },
          },
        },
      ])
    }),
  ),
)

it.effect.skipIf(!live)("revokes organization authority without revoking the same client's personal authority", () =>
  withDatabase((pool) =>
    Effect.gen(function* () {
      const protocol = yield* setup(pool)
      const hosted = yield* HostedStore
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
      yield* query(
        pool,
        `INSERT INTO "organization" (id, name, slug, created_at)
          VALUES ($1, 'Protocol', 'protocol', now())`,
        [organizationId],
      )
      yield* query(
        pool,
        `INSERT INTO member (id, organization_id, user_id, role, created_at)
          VALUES ($1, $2, $3, 'owner', now())`,
        [membershipId, organizationId, userId],
      )
      yield* hosted.putOwner({ id: organizationOwnerId, identity: organizationActor.owner, now })
      yield* hosted.grantClientAuthority({
        ownerId: organizationOwnerId,
        actor: organizationActor,
        now,
        expiresAt: authorityExpiresAt,
      })
      yield* hosted.createWorkspace({
        id: organizationWorkspaceId,
        ownerId: organizationOwnerId,
        createdByUserId: userId,
        executorKind: "runner",
        now,
      })
      yield* hosted.createThread({
        id: organizationThreadId,
        ownerId: organizationOwnerId,
        workspaceId: organizationWorkspaceId,
        createdByUserId: userId,
        executorKind: "runner",
        now,
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
        idempotencyKey: IdempotencyKey.make("organization-command-key"),
        expectedThreadVersion: ThreadVersion.make("0"),
        actor: organizationActor,
        command: { _tag: "Cancel" },
        admittedAt: now,
      })
      yield* protocol.completeCommand({
        ownerId: organizationOwnerId,
        threadId: organizationThreadId,
        commandId: organizationAdmission.command.commandId,
        result: { _tag: "Applied" },
        events: [],
        snapshot: {
          ...snapshot,
          thread: {
            ...snapshot.thread,
            id: ProductThreadId.make(organizationThreadId),
            workspace: organizationWorkspaceId,
          },
        },
        completedAt: later,
      })
      yield* hosted.upsertPresence({
        ownerId: organizationOwnerId,
        threadId: organizationThreadId,
        actor: organizationActor,
        status: "controlling",
        now,
        expiresAt: presenceExpiresAt,
      })

      yield* query(pool, `DELETE FROM member WHERE id = $1`, [membershipId])

      const authorities = yield* query(
        pool,
        `SELECT owner_id AS "ownerId", revoked_at IS NOT NULL AS revoked
          FROM rika_hosted_client_authorities WHERE client_id = $1 ORDER BY owner_id`,
        [clientId],
      )
      expect(authorities.rows).toEqual([
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
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })
      expect(
        yield* protocol
          .admitCommand({
            ownerId: organizationOwnerId,
            threadId: organizationThreadId,
            commandId: CommandId.make("revoked-command"),
            idempotencyKey: IdempotencyKey.make("revoked-command-key"),
            expectedThreadVersion: ThreadVersion.make("1"),
            actor: organizationActor,
            command: { _tag: "Cancel" },
            admittedAt: later,
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })
      expect(
        yield* hosted
          .listPresence({
            ownerId: organizationOwnerId,
            threadId: organizationThreadId,
            actor: organizationActor,
            now: later,
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-authority" } })

      const personalReplay = yield* protocol.replay({
        ownerId,
        threadId,
        actor,
        afterCursor: ThreadEventCursor.make("0"),
        limit: 100,
      })
      expect(personalReplay).toMatchObject({ threadVersion: "0", cursor: "0" })
      yield* hosted.upsertPresence({
        ownerId,
        threadId,
        actor,
        status: "viewing",
        now: later,
        expiresAt: presenceExpiresAt,
      })
      expect(yield* hosted.listPresence({ ownerId, threadId, actor, now: later })).toHaveLength(1)
    }),
  ),
)
