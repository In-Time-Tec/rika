import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMigrations, runMigration } from "@rika/identity"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { PromptPart } from "@rika/product/execution-request"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { BetterAuthUserId, OrganizationId } from "@rika/product/hosted-model"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import { FileSystem, Config, Effect, Layer, Random, Redacted, Ref, Schema } from "effect"
import { Pool, type QueryResult } from "pg"
import { live as livePlatform } from "./live-platform"
import {
  HostedProduct,
  HostedProductError,
  postgresTest,
  type AdmittedRun,
  type AuthenticatedPrincipal,
} from "../src/hosted-product"

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

const personal = (userId: string) => ({ _tag: "PersonalOwner" as const, userId: BetterAuthUserId.make(userId) })
const organization = (organizationId: string) => ({
  _tag: "OrganizationOwner" as const,
  organizationId: OrganizationId.make(organizationId),
})

const query = (pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.tryPromise(() => pool.query(text, [...values]))

const user = (pool: Pool, id: string) =>
  query(
    pool,
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ($1, $1, $2, true, now(), now())`,
    [id, `${id}@example.test`],
  )

const org = (pool: Pool, id: string) =>
  query(pool, `INSERT INTO "organization" (id, name, slug, created_at) VALUES ($1, $1, $1, now())`, [id])

const member = (pool: Pool, id: string, organizationId: string, userId: string) =>
  query(
    pool,
    `INSERT INTO "member" (id, organization_id, user_id, role, created_at)
      VALUES ($1, $2, $3, 'member', now())`,
    [id, organizationId, userId],
  )

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
  use: (pool: Pool) => Effect.Effect<A, E, R | HostedProduct>,
  promptAdmissionReadiness: Effect.Effect<boolean> = Effect.succeed(true),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const suffix = String(yield* Random.nextInt).replaceAll("-", "n")
      const database = `rika_hosted_product_${label}_${suffix}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* query(admin, `CREATE DATABASE "${database}"`)
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
          yield* runMigration({ pool: activePool, id: migration.id, checksum: migration.checksum, sql })
        }
        const context = yield* Layer.build(
          postgresTest({
            database: { url: Redacted.make(url), maxConnections: 8 },
            templateBuildId: "hosted-product-live",
            providerScope: "hosted-product-live",
            promptAdmissionReadiness,
          }).pipe(Layer.provide(BunCrypto.layer)),
        )
        return yield* use(activePool).pipe(Effect.provide(context))
      } finally {
        const cleanupPool = pool
        yield* cleanupPool === undefined ? Effect.void : Effect.tryPromise(() => cleanupPool.end())
        yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.tryPromise(() => admin.end())
      }
    }),
  ).pipe(livePlatform)

it.effect.skipIf(!live)("reuses deterministic Thread creation after a lost response", () =>
  withDatabase("create-retry", (pool) =>
    Effect.gen(function* () {
      const authenticated = principal("create-retry-user")
      yield* user(pool, authenticated.userId)
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
      const records = yield* query(
        pool,
        `SELECT
          (SELECT count(*)::int FROM rika_hosted_threads WHERE id = $1) AS threads,
          (SELECT count(*)::int FROM rika_hosted_workspaces WHERE id = $2) AS workspaces,
          (SELECT count(*)::int FROM rika_hosted_executor_assignments WHERE thread_id = $1) AS assignments`,
        [input.threadId, `${input.threadId}-workspace`],
      )
      expect(records.rows).toEqual([{ threads: 1, workspaces: 1, assignments: 1 }])
      const project = yield* product.createProject({
        principal: authenticated,
        owner: personal(authenticated.userId),
        name: "Divergent retry",
      })
      expect(yield* failureKind(product.createConnection({ ...input, projectId: project.id }))).toBe("conflict")
    }),
  ),
)

it.effect.skipIf(!live)("supports a projectless personal connection for a user with no organizations", () =>
  withDatabase("personal", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "personal-user")
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
      const facts = yield* query(
        pool,
        `SELECT owner_record.id AS owner_id, owner_record.user_id, thread.created_by_user_id,
          assignment.id AS assignment_id,
          command.actor, command.turn_id, turn.status, turn.prompt,
          (SELECT count(*)::int FROM "member" WHERE user_id = $1) AS memberships,
          (SELECT count(*)::int FROM rika_turns WHERE thread_id = thread.id) AS turn_count,
          (SELECT queued_count FROM rika_thread_queue_state WHERE thread_id = thread.id) AS queued_count
        FROM rika_hosted_thread_commands command
        JOIN rika_hosted_threads thread ON thread.id = command.thread_id
        JOIN rika_hosted_executor_assignments assignment ON assignment.thread_id = thread.id
        JOIN rika_hosted_owners owner_record ON owner_record.id = command.owner_id
        JOIN rika_turns turn ON turn.id = command.turn_id`,
        ["personal-user"],
      )
      expect(facts.rows).toHaveLength(1)
      expect(facts.rows[0].assignment_id).not.toBe(connection.threadId)
      expect(facts.rows[0]).toMatchObject({
        user_id: "personal-user",
        created_by_user_id: "personal-user",
        memberships: 0,
        turn_id: admitted.turnId,
        status: "accepted",
        prompt: "personal prompt",
        turn_count: 1,
        queued_count: 0,
        actor: { _tag: "PersonalActor", userId: "personal-user", owner: personal("personal-user") },
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
        yield* query(
          pool,
          `SELECT turn.id, turn.status, queue.queued_count
            FROM rika_turns turn
            JOIN rika_thread_queue_state queue ON queue.thread_id = turn.thread_id
            WHERE turn.id = $1`,
          [queued.turnId],
        ),
      ).toMatchObject({ rows: [{ id: queued.turnId, status: "queued", queued_count: 1 }] })
    }),
  ),
)

it.effect.skipIf(!live)("serializes prompt admission against cancellation in both commit orders", () =>
  withDatabase("prompt-cancellation", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "cancellation-user")
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
        yield* query(
          pool,
          `SELECT command_id, turn_id FROM rika_hosted_thread_commands WHERE thread_id = $1 ORDER BY command_id`,
          [connection.threadId],
        ),
      ).toMatchObject({ rows: [{ command_id: "submit-admitted", turn_id: admitted.turnId }] })
    }),
  ),
)

it.effect.skipIf(!live)("rejects new prompts without mutation and replays them through outage and recovery", () =>
  Effect.gen(function* () {
    const ready = yield* Ref.make(false)
    yield* withDatabase(
      "prompt-readiness",
      (pool) =>
        Effect.gen(function* () {
          yield* user(pool, "prompt-readiness-user")
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
          expect(
            yield* query(
              pool,
              `SELECT
                (SELECT count(*)::int FROM rika_hosted_thread_commands WHERE thread_id = $1) AS commands,
                (SELECT count(*)::int FROM rika_turns WHERE thread_id = $1) AS turns,
                (SELECT count(*)::int FROM rika_thread_queue_state WHERE thread_id = $1) AS queues`,
              [connection.threadId],
            ),
          ).toMatchObject({ rows: [{ commands: 0, turns: 0, queues: 0 }] })
          yield* Ref.set(ready, true)
          const admitted = yield* product.admitRun(input)
          yield* Ref.set(ready, false)
          expect(yield* product.admitRun(input)).toEqual(admitted)
          expect(yield* failureKind(product.admitRun({ ...input, operationKey: "new-during-outage" }))).toBe(
            "unavailable",
          )
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
      (pool) =>
        Effect.gen(function* () {
          yield* user(pool, "prompt-readiness-race-user")
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
            yield* query(pool, `SELECT count(*)::int AS count FROM rika_turns WHERE thread_id = $1`, [
              connection.threadId,
            ]),
          ).toMatchObject({ rows: [{ count: 1 }] })
        }),
      readiness,
    )
  }),
)

it.effect.skipIf(!live)("serializes the first prompt lane without queue-count drift", () =>
  withDatabase("prompt-lane", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "prompt-lane-user")
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
      const lanes = yield* query(
        pool,
        `SELECT status, count(*)::int AS count
          FROM rika_turns WHERE thread_id = $1 GROUP BY status ORDER BY status`,
        [connection.threadId],
      )
      expect(lanes.rows).toEqual([
        { status: "accepted", count: 1 },
        { status: "queued", count: 7 },
      ])
      expect(
        yield* query(pool, `SELECT queued_count FROM rika_thread_queue_state WHERE thread_id = $1`, [
          connection.threadId,
        ]),
      ).toMatchObject({ rows: [{ queued_count: 7 }] })
      const accepted = lanes.rows.find((lane) => lane.status === "accepted")
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
  withDatabase("local-admission", (pool) =>
    Effect.gen(function* () {
      const authenticated = principal("local-user")
      const fingerprint = CheckoutFingerprint.make("local-checkout")
      yield* user(pool, authenticated.userId)
      const product = yield* HostedProduct
      yield* product.registerRunner({
        principal: authenticated,
        checkoutFingerprint: fingerprint,
        registration: {
          workspaceIdentity: "local-workspace" as never,
          repository: { identity: "In-Time-Tec/rika", branch: "main" },
          kernel: { runtime: "bun", runtimeVersion: Bun.version, trustMode: "trusted-local" },
          capabilities: { cells: true, checkpoints: false, pty: false },
        },
      })
      const createLocal = () =>
        product.createConnection({
          principal: authenticated,
          owner: personal(authenticated.userId),
          executorKind: "runner",
          runnerTarget: { deviceId: authenticated.deviceId as never, checkoutFingerprint: fingerprint },
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
      const staleRows = yield* query(
        pool,
        `SELECT hosted.workspace_id, turn.execution_route_json
          FROM rika_turns turn
          JOIN rika_hosted_threads hosted ON hosted.id = turn.thread_id
          WHERE turn.id = $1`,
        [staleRun.turnId],
      )
      const staleInput = {
        threadId: staleThread.threadId,
        turnId: staleRun.turnId,
        workspaceId: staleRows.rows[0].workspace_id,
        prompt: "stale prompt",
        executionRoute: decodeExecutionRoute(staleRows.rows[0].execution_route_json),
      }
      yield* query(pool, `UPDATE rika_turns SET status = 'running' WHERE id = $1`, [staleRun.turnId])
      yield* query(pool, `UPDATE rika_thread_queue_state SET queued_count = 0 WHERE thread_id = $1`, [
        staleThread.threadId,
      ])
      yield* query(
        pool,
        `INSERT INTO rika_turn_admission_outbox (turn_id, start_input_json, prepared_at) VALUES ($1, $2, 1)`,
        [staleRun.turnId, encodeStartTurn(staleInput)],
      )
      yield* query(pool, `DELETE FROM rika_hosted_executor_assignments WHERE thread_id = $1`, [staleThread.threadId])

      const currentThread = yield* createLocal()
      const promptParts = [
        { type: "image" as const, mediaType: "image/png", data: "aW1hZ2U=", filename: "evidence.png" },
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
      const turns = yield* query(
        pool,
        `SELECT id, status, prompt_parts_json, execution_route_json
          FROM rika_turns WHERE id IN ($1, $2) ORDER BY id`,
        [staleRun.turnId, currentRun.turnId],
      )
      const stale = turns.rows.find((row) => row.id === staleRun.turnId)
      const current = turns.rows.find((row) => row.id === currentRun.turnId)
      expect(stale).toMatchObject({ status: "running" })
      expect(current).toMatchObject({ status: "accepted" })
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
        yield* query(pool, `SELECT count(*)::int AS count FROM rika_turn_admission_outbox WHERE turn_id = $1`, [
          staleRun.turnId,
        ]),
      ).toMatchObject({ rows: [{ count: 1 }] })
    }),
  ),
)

it.effect.skipIf(!live)("revokes organization admission immediately without affecting personal threads", () =>
  withDatabase("revocation", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "member-user")
      yield* org(pool, "revoked-org")
      yield* member(pool, "revoked-membership", "revoked-org", "member-user")
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
      yield* query(pool, `DELETE FROM "member" WHERE id = 'revoked-membership'`)
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
  withDatabase("grant", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "creator-user")
      yield* user(pool, "operator-user")
      yield* org(pool, "grant-org")
      yield* member(pool, "creator-membership", "grant-org", "creator-user")
      yield* member(pool, "operator-membership", "grant-org", "operator-user")
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
      const owner = yield* query(pool, `SELECT owner_id FROM rika_hosted_threads WHERE id = $1`, [connection.threadId])
      yield* query(
        pool,
        `INSERT INTO rika_hosted_thread_grants
          (owner_id, thread_id, membership_id, role, granted_by_user_id, created_at, updated_at)
          VALUES ($1, $2, 'operator-membership', 'operator', 'creator-user', now(), now())`,
        [owner.rows[0].owner_id, connection.threadId],
      )
      yield* operate
      const command = yield* query(
        pool,
        `SELECT actor FROM rika_hosted_thread_commands WHERE command_id = 'operator-run'`,
      )
      expect(command.rows[0].actor).toMatchObject({
        _tag: "OrganizationActor",
        userId: "operator-user",
        membershipId: "operator-membership",
        owner: organization("grant-org"),
      })
    }),
  ),
)

it.effect.skipIf(!live)("fails closed for forged and cross-owner selections", () =>
  withDatabase("forgery", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "first-user")
      yield* user(pool, "second-user")
      yield* org(pool, "foreign-org")
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
      const secondOwner = yield* query(pool, `SELECT id FROM rika_hosted_owners WHERE user_id = 'second-user'`)
      yield* query(
        pool,
        `INSERT INTO rika_hosted_projects (id, owner_id, name, created_by_user_id, created_at, updated_at)
          VALUES ('foreign-project', $1, 'Foreign', 'second-user', now(), now())`,
        [secondOwner.rows[0].id],
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
  withDatabase("owners", (pool) =>
    Effect.gen(function* () {
      yield* user(pool, "owner-user")
      yield* org(pool, "owner-org")
      yield* member(pool, "owner-membership", "owner-org", "owner-user")
      const product = yield* HostedProduct
      yield* Effect.all(
        Array.from({ length: 8 }, () => product.projects(principal("owner-user"))),
        {
          concurrency: "unbounded",
        },
      )
      const owners: QueryResult<{ id: string; kind: string }> = yield* query(
        pool,
        `SELECT id, kind FROM rika_hosted_owners ORDER BY kind`,
      )
      expect(owners.rows).toHaveLength(2)
      expect(owners.rows.map(({ kind }) => kind).sort()).toEqual(["organization", "personal"])
      expect(owners.rows.every(({ id }) => id !== "owner-user" && id !== "owner-org")).toBe(true)
      yield* product.projects(principal("owner-user"))
      const repeated = yield* query(pool, `SELECT id, kind FROM rika_hosted_owners ORDER BY kind`)
      expect(repeated.rows).toEqual(owners.rows)
    }),
  ),
)
