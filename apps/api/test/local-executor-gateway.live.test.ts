import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { ControllerError } from "@rika/e2b-executor/controller"
import { identityMigrations, runMigration } from "@rika/identity"
import { ActorAttribution } from "@rika/product/hosted-model"
import { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as HostedPostgres from "@rika/product-store/postgres-layer"
import { ApiMessage, LocalExecutorMessage, type AccessWire } from "@rika/remote-execution/protocol"
import { HostBindingRegistry } from "tenetkit/repl"
import { Context, Effect, Layer, Random, Redacted, Schema } from "effect"
import { createHash } from "node:crypto"
import { Pool } from "pg"
import { makeLocalGateway, type LocalGateway } from "../src/local-executor-gateway"
import type { LocalExecutorAuthority } from "../src/local-executor"
import type { BindingAuthority, Socket } from "../src/executor-gateway"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
const live = databaseUrl !== undefined
const encode = Schema.encodeSync(Schema.fromJsonString(LocalExecutorMessage))
const decode = Schema.decodeSync(Schema.fromJsonString(ApiMessage))
const encodeActor = Schema.encodeUnknownSync(Schema.fromJsonString(ActorAttribution))
const encodeWorkspaceCapabilities = Schema.encodeUnknownSync(Schema.fromJsonString(WorkspaceCapabilitySnapshot))
const code = 'printf "restart"'
const bindings = {
  registry: HostBindingRegistry.HostBindingRegistry.of({
    descriptors: [],
    resolve: (input) => Effect.fail(HostBindingRegistry.HostBindingNotFound.make({ module: input.module })),
    invoke: (input) => Effect.fail(HostBindingRegistry.HostBindingNotFound.make({ module: input.module })),
  }),
  context: Context.empty(),
  manifest: { digest: "a".repeat(64), descriptors: [] },
} as unknown as BindingAuthority
const sessionToken = "session-local-gateway"
const sessionDigest = createHash("sha256").update(sessionToken).digest("hex")
const deviceId = "11111111-1111-4111-8111-111111111111"
const assignmentId = "thread-local-gateway"
const cellRequest = (operationKey: string) => ({
  assignmentId,
  operationKey,
  workspaceId: "workspace-local-gateway",
  sessionId: assignmentId,
  threadId: assignmentId,
  turnId: "turn-local-gateway",
  runId: "run-local-gateway",
  rootRunId: "run-local-gateway",
  toolCallId: "call-local-gateway",
  code,
  attempt: 0,
  replayPolicy: "pure" as const,
  admittedAt: null,
  deadline: null,
  bindings,
})
const request = cellRequest("operation")
const digest = createHash("sha256")
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
      admittedAt: request.admittedAt,
      deadline: request.deadline,
    }),
  )
  .digest("hex")

const access: AccessWire = {
  version: 1,
  fence: {
    target: "local_device",
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

const persistTerminal = (
  gateway: LocalGateway,
  target: Socket,
  presented: AccessWire,
  operationKey: string,
  terminalResponse = response,
) =>
  Effect.gen(function* () {
    const operation = cellRequest(operationKey)
    const attribution = {
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
    for (const frame of [
      { _tag: "Accepted" as const, attribution, cursor: 1 },
      { _tag: "Started" as const, attribution, cursor: 2 },
      {
        _tag: "Terminal" as const,
        attribution,
        cursor: 3,
        outcome: "completed" as const,
        response: terminalResponse,
      },
    ])
      yield* gateway.receive(target, encode({ _tag: "CellLifecycle", access: presented, frame }))
  })

const socket = () => {
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
  } as Socket & {
    failSend: boolean
    readonly sent: Array<string>
    readonly closed: Array<readonly [number | undefined, string | undefined]>
  }
}

const authority = (input?: {
  readonly renewedLeaseEpoch?: number
  readonly release?: LocalExecutorAuthority["release"]
  readonly validateAccess?: LocalExecutorAuthority["validateAccess"]
}): LocalExecutorAuthority => ({
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
      const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    return pool
  })

const query = (pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.promise(() => pool.query(text, [...values]))

const seed = (
  pool: Pool,
  operationKey: string,
  options?: {
    readonly ownerKind?: "organization" | "personal"
    readonly leaseEpoch?: number
    readonly deadline?: "past" | "future"
    readonly state?: "accepted" | "dispatched"
    readonly leaseExpires?: "past" | "future"
  },
) =>
  Effect.gen(function* () {
    const state = options?.state ?? "dispatched"
    const ownerKind = options?.ownerKind ?? "organization"
    const ownerId = `${ownerKind}-owner-local-gateway`
    yield* query(
      pool,
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('user-local-gateway', 'Local', 'local-gateway@example.test', true, now(), now())`,
    )
    if (ownerKind === "organization") {
      yield* query(
        pool,
        `INSERT INTO "organization" (id, name, slug, created_at)
        VALUES ('organization-local-gateway', 'Local', 'local-gateway', now())`,
      )
      yield* query(
        pool,
        `INSERT INTO member (id, organization_id, user_id, role, created_at)
        VALUES ('member-local-gateway', 'organization-local-gateway', 'user-local-gateway', 'owner', now())`,
      )
    }
    yield* query(
      pool,
      `INSERT INTO oauth_client (id, client_id, redirect_uris, created_at)
      VALUES ('oauth-local-gateway', 'client-local-gateway', '[]'::jsonb, now())`,
    )
    yield* query(
      pool,
      `INSERT INTO rika_cli_registration (client_id, device_id, public_jwk, jwk_thumbprint, user_id)
      VALUES ('client-local-gateway', $1::uuid,
        '{"kty":"EC","crv":"P-256","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
        'thumbprint-local-gateway', 'user-local-gateway')`,
      [deviceId],
    )
    yield* query(
      pool,
      `INSERT INTO rika_hosted_owners (id, kind, user_id, organization_id)
      VALUES ($1, $2, CASE WHEN $2 = 'personal' THEN 'user-local-gateway' END,
        CASE WHEN $2 = 'organization' THEN 'organization-local-gateway' END)`,
      [ownerId, ownerKind],
    )
    yield* query(pool, `INSERT INTO rika_hosted_owner_counters (owner_id) VALUES ($1)`, [ownerId])
    yield* query(
      pool,
      `INSERT INTO rika_hosted_projects
      (id, owner_id, name, created_by_user_id, created_at, updated_at)
      VALUES ('project-local-gateway', $1, 'Local', 'user-local-gateway', now(), now())`,
      [ownerId],
    )
    yield* query(
      pool,
      `INSERT INTO rika_hosted_workspaces
      (id, owner_id, project_id, created_by_user_id, executor_kind, inherit_project_grants, created_at)
      VALUES ('workspace-local-gateway', $1, 'project-local-gateway',
        'user-local-gateway', 'local_device', false, now())`,
      [ownerId],
    )
    yield* query(
      pool,
      `INSERT INTO rika_hosted_threads
      (id, owner_id, project_id, workspace_id, created_by_user_id, executor_kind,
        inherit_project_grants, next_command_sequence, next_event_sequence, created_at)
      VALUES ('thread-local-gateway', $1, 'project-local-gateway',
        'workspace-local-gateway', 'user-local-gateway', 'local_device', false, 2, 1, now())`,
      [ownerId],
    )
    yield* query(
      pool,
      `INSERT INTO rika_hosted_devices
      (id, user_id, display_name, public_key_fingerprint, created_at, last_seen_at)
      VALUES ($1, 'user-local-gateway', 'Local', 'sha256:local-gateway', now(), now())`,
      [deviceId],
    )
    yield* query(
      pool,
      `INSERT INTO rika_hosted_clients
      (id, user_id, device_id, authenticated_at, last_seen_at, expires_at)
      VALUES ('client-local-gateway', 'user-local-gateway', $1, now(), now(), now() + interval '5 minutes')`,
      [deviceId],
    )
    yield* query(
      pool,
      `INSERT INTO rika_hosted_executor_assignments
      (id, owner_id, thread_id, executor_kind, placement, checkout, generation, revision,
        last_lease_epoch, lifecycle, provider_instance_id, executor_instance_id, process_incarnation,
        session_digest, lease_epoch, lease_expires_at, last_active_at, created_at, updated_at, workspace_id,
        capability_generation, capability_snapshot)
      VALUES ('thread-local-gateway', $4, 'thread-local-gateway', 'local_device',
        '{"_tag":"LocalDevicePlacement","deviceId":"11111111-1111-4111-8111-111111111111"}'::jsonb, NULL, 1, 1, 1, 'active',
        $1, 'executor-local-gateway', 'process-local-gateway', $2, 1,
        CASE WHEN $3 = 'past' THEN now() - interval '1 second' ELSE now() + interval '5 minutes' END,
        now(), now(), now(), 'workspace-local-gateway', 1, $5::jsonb)`,
      [
        deviceId,
        sessionDigest,
        options?.leaseExpires ?? "future",
        ownerId,
        encodeWorkspaceCapabilities(workspaceCapabilities),
      ],
    )
    yield* query(
      pool,
      `INSERT INTO rika_hosted_local_executor_admissions
      (id, assignment_id, owner_id, device_id, client_id, user_id, process_incarnation,
        generation, workspace_fingerprint, ticket_digest, expires_at, consumed_at)
      VALUES ('admission-local-gateway', 'thread-local-gateway', $2, $1,
        'client-local-gateway', 'user-local-gateway', 'process-local-gateway',
        1, 'workspace-binding', 'ticket-digest', now() + interval '5 minutes', now())`,
      [deviceId, ownerId],
    )
    yield* query(
      pool,
      `INSERT INTO rika_hosted_workspace_capability_admissions
      (thread_id, turn_id, assignment_id, workspace_id, assignment_generation,
        environment_digest, required_capabilities)
      VALUES ('thread-local-gateway', 'turn-local-gateway', 'thread-local-gateway',
        'workspace-local-gateway', 1, $1, '["filesystem","typescriptKernel","git","process","workspaceLifecycle"]')`,
      [environmentDigest],
    )
    yield* query(
      pool,
      `INSERT INTO rika_hosted_thread_commands
      (owner_id, thread_id, command_id, idempotency_key, actor, sequence, commit_cursor, command, admitted_at)
      VALUES ($3, 'thread-local-gateway', $1, $1, $2::jsonb,
        1, 1, '{"_tag":"SubmitPrompt","prompt":"restart"}', now())`,
      [
        operationKey,
        encodeActor(
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
        ),
        ownerId,
      ],
    )
    yield* query(pool, `UPDATE rika_hosted_owner_counters SET next_commit_cursor = 2 WHERE owner_id = $1`, [ownerId])
    if (state === "accepted") {
      yield* query(
        pool,
        `INSERT INTO rika_hosted_executor_operations
        (assignment_id, owner_id, operation_key, request_digest, workspace_id, session_id, thread_id,
          turn_id, run_id, root_run_id, tool_call_id, code, attempt, replay_policy, state, updated_at)
        VALUES ('thread-local-gateway', $4, $1, $2, 'workspace-local-gateway', 'thread-local-gateway',
          'thread-local-gateway', 'turn-local-gateway', 'run-local-gateway', 'run-local-gateway',
          'call-local-gateway', $3, 0, 'pure', 'accepted', now())`,
        [operationKey, digest, code, ownerId],
      )
      return
    }
    yield* query(
      pool,
      `INSERT INTO rika_hosted_executor_operations
      (assignment_id, owner_id, operation_key, request_digest, workspace_id, session_id, thread_id,
        turn_id, run_id, root_run_id, tool_call_id, code, attempt, state, dispatched_generation,
        replay_policy, dispatched_lease_epoch, dispatched_executor_instance_id, dispatched_process_incarnation,
        dispatch_deadline_at, updated_at)
      VALUES ('thread-local-gateway', $6, $1, $2, 'workspace-local-gateway', 'thread-local-gateway',
        'thread-local-gateway', 'turn-local-gateway', 'run-local-gateway', 'run-local-gateway',
        'call-local-gateway', $3, 0, 'dispatched', 1, 'pure', $4,
        'executor-local-gateway', 'process-local-gateway',
        CASE WHEN $5 = 'past' THEN now() - interval '1 second' ELSE now() + interval '5 minutes' END, now())`,
      [operationKey, digest, code, options?.leaseEpoch ?? 1, options?.deadline ?? "future", ownerId],
    )
  })

const operationState = (pool: Pool, operationKey: string) =>
  query(
    pool,
    `SELECT operation.state, count(event.event_id)::int AS events
      FROM rika_hosted_executor_operations operation
      LEFT JOIN rika_hosted_thread_events event ON event.idempotency_key = operation.operation_key
      WHERE operation.operation_key = $1
      GROUP BY operation.state`,
    [operationKey],
  )

const pauseAssignment = (pool: Pool) =>
  query(
    pool,
    `UPDATE rika_hosted_executor_assignments SET
      revision = revision + 1, lifecycle = 'paused', bootstrap_digest = NULL, bootstrap_expires_at = NULL,
      executor_instance_id = NULL, process_incarnation = NULL, session_digest = NULL,
      lease_epoch = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
      WHERE id = $1 AND lifecycle = 'active'`,
    [assignmentId],
  )

const isolated = <A, E, R>(run: (input: { readonly url: string; readonly pool: Pool }) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = `rika_local_gateway_${Math.abs(yield* Random.nextInt)}`
    const admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.promise(() => admin.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl!)
    parsed.pathname = `/${database}`
    const url = parsed.toString()
    let pool: Pool | undefined
    try {
      pool = yield* migrate(url)
      return yield* run({ url, pool })
    } finally {
      yield* Effect.promise(() => pool?.end() ?? Promise.resolve())
      yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.promise(() => admin.end())
    }
  })

it.effect.skipIf(!live)(
  "keeps a dispatched operation after a passive disconnect and accepts the retained result after restart",
  () =>
    isolated(({ url, pool }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(pool, "operation-restart")
          const context = yield* Layer.build(
            Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
          )
          const first = yield* makeLocalGateway(authority()).pipe(Effect.provide(context))
          const firstSocket = socket()
          yield* first.receive(firstSocket, encode({ _tag: "ExecutorReconnect", access }))
          yield* first.disconnected(firstSocket)
          expect(
            (yield* query(
              pool,
              `SELECT state FROM rika_hosted_executor_operations WHERE operation_key = 'operation-restart'`,
            )).rows,
          ).toEqual([{ state: "dispatched" }])

          const restarted = yield* makeLocalGateway(authority()).pipe(Effect.provide(context))
          const secondSocket = socket()
          yield* restarted.receive(secondSocket, encode({ _tag: "ExecutorReconnect", access }))
          yield* persistTerminal(restarted, secondSocket, access, "operation-restart")
          const result = encode({
            _tag: "LocalCellResult",
            access,
            operationKey: "operation-restart",
            attempt: 0,
            response,
          })
          yield* restarted.receive(secondSocket, result)
          yield* restarted.receive(secondSocket, result)
          expect(secondSocket.closed).toEqual([])
          expect(
            secondSocket.sent.map((value) => decode(value)).filter((message) => message._tag === "LocalCellReceipt"),
          ).toHaveLength(2)
          expect((yield* operationState(pool, "operation-restart")).rows).toEqual([{ state: "completed", events: 1 }])
        }),
      ),
    ),
)

it.effect.skipIf(!live)("fences organization dispatch immediately after membership deletion", () =>
  isolated(({ url, pool }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(pool, "operation-revoked-membership", { state: "accepted" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeLocalGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* query(pool, `DELETE FROM member WHERE id = 'member-local-gateway'`)
        const error = yield* gateway.execute(cellRequest("operation-revoked-membership")).pipe(Effect.flip)
        expect(error).toMatchObject({
          kind: "fenced",
          message: "Local executor fence is no longer current",
        })
        expect((yield* operationState(pool, "operation-revoked-membership")).rows).toEqual([
          { state: "accepted", events: 0 },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("durably revokes a local executor immediately after device revocation", () =>
  isolated(({ url, pool }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(pool, "operation-revoked-device", { state: "accepted" })
        yield* query(
          pool,
          `INSERT INTO rika_hosted_local_runner_registrations
            (device_id, user_id, checkout_fingerprint, workspace_id, repository, kernel_profile, capabilities)
            VALUES ($1, 'user-local-gateway', 'checkout-local-gateway', 'workspace-local-gateway',
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
          [deviceId],
        )
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        let active = true
        const gateway = yield* makeLocalGateway(
          authority({
            validateAccess: () =>
              active ? Effect.void : Effect.fail(ControllerError.make({ kind: "fenced", message: "revoked" })),
          }),
        ).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* Effect.yieldNow
        expect(yield* gateway.active(target)).toBe(true)

        yield* query(
          pool,
          `UPDATE rika_cli_registration SET revoked_at = transaction_timestamp()
            WHERE client_id = 'client-local-gateway'`,
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
        expect(
          (yield* query(
            pool,
            `SELECT device.revoked_at IS NOT NULL AS "deviceRevoked",
                  client_record.revoked_at IS NOT NULL AS "clientRevoked",
                  admission.revoked_at IS NOT NULL AS "admissionRevoked",
                  assignment.lifecycle, assignment.generation::int AS generation,
                  EXISTS (SELECT 1 FROM rika_hosted_local_runner_registrations) AS "runnerRegistered"
                FROM rika_hosted_devices device
                JOIN rika_hosted_clients client_record ON client_record.device_id = device.id
                JOIN rika_hosted_local_executor_admissions admission ON admission.client_id = client_record.id
                JOIN rika_hosted_executor_assignments assignment ON assignment.id = admission.assignment_id
                WHERE device.id = $1`,
            [deviceId],
          )).rows,
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
  isolated(({ url, pool }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(pool, "operation-environment-changed", { state: "accepted" })
        yield* query(
          pool,
          `UPDATE rika_hosted_executor_assignments
            SET capability_snapshot = jsonb_set(capability_snapshot, '{environmentDigest}', to_jsonb($1::text))
            WHERE id = $2`,
          [`sha256:${"1".repeat(64)}`, assignmentId],
        )
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeLocalGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        expect(yield* gateway.execute(cellRequest("operation-environment-changed")).pipe(Effect.flip)).toMatchObject({
          kind: "fenced",
          message: "Local executor fence is no longer current",
        })
        expect((yield* operationState(pool, "operation-environment-changed")).rows).toEqual([
          { state: "accepted", events: 0 },
        ])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("dispatches a personal-owner operation without any organization membership", () =>
  isolated(({ url, pool }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(pool, "operation-personal", { ownerKind: "personal", state: "accepted" })
        expect((yield* query(pool, `SELECT count(*)::int AS count FROM member`)).rows).toEqual([{ count: 0 }])
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeLocalGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        target.failSend = true
        const result = yield* gateway.execute(cellRequest("operation-personal"))
        expect(target.sent.map((value) => decode(value)).some((message) => message._tag === "CellExecute")).toBe(true)
        expect(result.response).toEqual({
          _tag: "DomainFailure",
          failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
        })
        expect((yield* operationState(pool, "operation-personal")).rows).toEqual([{ state: "unknown", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)(
  "rejects a completion whose current assignment lease does not match the presented session",
  () =>
    isolated(({ url, pool }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed(pool, "operation-stale", { leaseEpoch: 1 })
          const context = yield* Layer.build(
            Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
          )
          const gateway = yield* makeLocalGateway(authority({ renewedLeaseEpoch: 2 })).pipe(Effect.provide(context))
          const target = socket()
          const renewed = { ...access, leaseEpoch: 2 }
          yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access: renewed }))
          yield* persistTerminal(gateway, target, renewed, "operation-stale")
          yield* gateway.receive(
            target,
            encode({
              _tag: "LocalCellResult",
              access: renewed,
              operationKey: "operation-stale",
              attempt: 0,
              response,
            }),
          )
          expect(target.closed).toEqual([[1008, "fenced"]])
          expect(
            (yield* query(
              pool,
              `SELECT state FROM rika_hosted_executor_operations WHERE operation_key = 'operation-stale'`,
            )).rows,
          ).toEqual([{ state: "dispatched" }])
        }),
      ),
    ),
)

it.effect.skipIf(!live)("accepts a retained completion after reconnect renews the assignment lease", () =>
  isolated(({ url, pool }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(pool, "operation-renewed")
        yield* query(
          pool,
          `UPDATE rika_hosted_executor_assignments SET last_lease_epoch = 2, lease_epoch = 2 WHERE id = $1`,
          [assignmentId],
        )
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeLocalGateway(authority({ renewedLeaseEpoch: 2 })).pipe(Effect.provide(context))
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
        expect((yield* operationState(pool, "operation-renewed")).rows).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("rejects a conflicting completion after a durable result already exists", () =>
  isolated(({ url, pool }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(pool, "operation-conflict")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeLocalGateway(authority()).pipe(Effect.provide(context))
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
        expect((yield* operationState(pool, "operation-conflict")).rows).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("recovers an overdue dispatch once across concurrent gateway reapers", () =>
  isolated(({ url, pool }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(pool, "operation-overdue", { deadline: "past" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const left = yield* makeLocalGateway(authority()).pipe(Effect.provide(context))
        const right = yield* makeLocalGateway(authority()).pipe(Effect.provide(context))
        const results = yield* Effect.all(
          [left.execute(cellRequest("operation-overdue")), right.execute(cellRequest("operation-overdue"))],
          { concurrency: 2 },
        )
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
        expect((yield* operationState(pool, "operation-overdue")).rows).toEqual([{ state: "unknown", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("recovers a dispatched operation after the assignment lease expires", () =>
  isolated(({ url, pool }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(pool, "operation-expired-lease", { leaseExpires: "past" })
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeLocalGateway(authority()).pipe(Effect.provide(context))
        const result = yield* gateway.execute(cellRequest("operation-expired-lease"))
        expect(result.response).toEqual({
          _tag: "DomainFailure",
          failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
        })
        expect((yield* operationState(pool, "operation-expired-lease")).rows).toEqual([{ state: "unknown", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("terminalizes unresolved work and releases the assignment on explicit goodbye", () =>
  isolated(({ url, pool }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(pool, "operation-goodbye")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeLocalGateway(
          authority({
            release: () => pauseAssignment(pool).pipe(Effect.asVoid),
          }),
        ).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* gateway.receive(target, encode({ _tag: "LocalExecutorGoodbye", access }))
        expect(target.closed).toEqual([[1000, "shutdown"]])
        expect(
          (yield* query(pool, `SELECT lifecycle FROM rika_hosted_executor_assignments WHERE id = $1`, [assignmentId]))
            .rows,
        ).toEqual([{ lifecycle: "paused" }])
        const recovered = yield* gateway.execute(cellRequest("operation-goodbye"))
        expect(recovered.response).toEqual({
          _tag: "DomainFailure",
          failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
        })
        expect((yield* operationState(pool, "operation-goodbye")).rows).toEqual([{ state: "unknown", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("accepts a retained completion on the same gateway after a passive disconnect", () =>
  isolated(({ url, pool }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(pool, "operation-live")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeLocalGateway(authority()).pipe(Effect.provide(context))
        const firstSocket = socket()
        yield* gateway.receive(firstSocket, encode({ _tag: "ExecutorReconnect", access }))
        yield* gateway.disconnected(firstSocket)
        expect(
          (yield* query(
            pool,
            `SELECT state FROM rika_hosted_executor_operations WHERE operation_key = 'operation-live'`,
          )).rows,
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
        expect((yield* operationState(pool, "operation-live")).rows).toEqual([{ state: "completed", events: 1 }])
      }),
    ),
  ),
)

it.effect.skipIf(!live)("closes a local PTY frame as malformed", () =>
  isolated(({ url, pool }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed(pool, "operation-pty")
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeLocalGateway(authority()).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(target, encode({ _tag: "ExecutorReconnect", access }))
        yield* gateway.receive(
          target,
          '{"_tag":"PtyOpened","access":{"version":1,"fence":{"target":"local_device","assignmentId":"thread-local-gateway","assignmentGeneration":1,"instanceId":"11111111-1111-4111-8111-111111111111","executorId":"executor-local-gateway","processIncarnation":"process-local-gateway"},"leaseEpoch":1,"sessionToken":"session-local-gateway"},"pty":{"ptyId":"pty-1","command":"bash","cwd":"/tmp","cols":80,"rows":24}}',
        )
        expect(target.closed).toEqual([[1007, "malformed"]])
        expect(
          (yield* query(
            pool,
            `SELECT state FROM rika_hosted_executor_operations WHERE operation_key = 'operation-pty'`,
          )).rows,
        ).toEqual([{ state: "dispatched" }])
      }),
    ),
  ),
)
