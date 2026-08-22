import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMigrations, runMigration } from "@rika/identity"
import { ActorAttribution } from "@rika/product/hosted-model"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as HostedPostgres from "@rika/product-store/postgres-layer"
import { Context, Crypto, Effect, Layer, Random, Redacted, Schema } from "effect"
import { Pool } from "pg"
import {
  HostedToolPolicy,
  argumentsDigest,
  layer as toolPolicyLayer,
  organizationOwner,
  personalOwner,
  policyFor,
  toolAuthorizationRequest,
} from "../src/hosted-tool-policy"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
const query = (pool: Pool, text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.promise(() => pool.query(text, [...values]))

const personalActor = Schema.decodeSync(ActorAttribution)({
  _tag: "PersonalActor",
  owner: { _tag: "PersonalOwner", userId: "personal-user" },
  userId: "personal-user",
  clientId: "personal-client",
  deviceId: "personal-device",
})

const organizationActor = Schema.decodeSync(ActorAttribution)({
  _tag: "OrganizationActor",
  owner: { _tag: "OrganizationOwner", organizationId: "organization-1" },
  userId: "organization-user",
  membershipId: "organization-member",
  clientId: "organization-client",
  deviceId: "organization-device",
})

const access = (assignmentId: string, instanceId: string) => ({
  version: 1 as const,
  fence: {
    target: "e2b" as const,
    assignmentId,
    assignmentGeneration: 1,
    instanceId,
    executorId: `${assignmentId}-executor`,
    processIncarnation: `${assignmentId}-process`,
  },
  leaseEpoch: 1,
  sessionToken: `${assignmentId}-session`,
})

const seed = (pool: Pool) =>
  query(
    pool,
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('personal-user', 'personal-user', 'personal@example.test', true, now(), now()),
      ('foreign-user', 'foreign-user', 'foreign@example.test', true, now(), now()),
      ('organization-user', 'organization-user', 'organization@example.test', true, now(), now());
     INSERT INTO "organization" (id, name, slug, created_at)
      VALUES ('organization-1', 'organization-1', 'organization-1', now());
     INSERT INTO "member" (id, organization_id, user_id, role, created_at)
      VALUES ('organization-member', 'organization-1', 'organization-user', 'member', now());
     INSERT INTO rika_hosted_owners (id, kind, user_id, organization_id) VALUES
      ('personal-owner', 'personal', 'personal-user', NULL),
      ('organization-owner', 'organization', NULL, 'organization-1');
     INSERT INTO rika_hosted_projects
      (id, owner_id, name, created_by_user_id, created_at, updated_at) VALUES
      ('personal-project', 'personal-owner', 'personal-project', 'personal-user', now(), now()),
      ('organization-project', 'organization-owner', 'organization-project', 'organization-user', now(), now());
     INSERT INTO rika_hosted_workspaces
      (id, owner_id, project_id, created_by_user_id, executor_kind, inherit_project_grants, created_at) VALUES
      ('personal-workspace', 'personal-owner', 'personal-project', 'personal-user', 'e2b', false, now()),
      ('organization-workspace', 'organization-owner', 'organization-project', 'organization-user', 'e2b', false, now());
     INSERT INTO rika_hosted_threads
      (id, owner_id, project_id, workspace_id, created_by_user_id, executor_kind, inherit_project_grants, created_at) VALUES
      ('personal-thread', 'personal-owner', 'personal-project', 'personal-workspace', 'personal-user', 'e2b', false, now()),
      ('organization-thread', 'organization-owner', 'organization-project', 'organization-workspace', 'organization-user', 'e2b', false, now());
     INSERT INTO rika_hosted_project_repositories
      (project_id, owner_id, repository_id, installation_id, installation_account_id,
       installation_account_login, installation_account_type, repository_owner, repository_name,
       default_ref, private) VALUES
      ('personal-project', 'personal-owner', 'repository-personal', 'installation', 'account-personal',
       'owner', 'Organization', 'owner', 'repo', 'main', true),
      ('organization-project', 'organization-owner', 'repository-organization', 'installation',
       'account-organization', 'owner', 'Organization', 'owner', 'repo', 'main', true);
     INSERT INTO rika_hosted_devices
      (id, user_id, display_name, public_key_fingerprint, created_at, last_seen_at) VALUES
      ('personal-device', 'personal-user', 'personal', 'personal-key', now(), now()),
      ('organization-device', 'organization-user', 'organization', 'organization-key', now(), now());
     INSERT INTO rika_hosted_clients
      (id, user_id, device_id, authenticated_at, last_seen_at, expires_at) VALUES
      ('personal-client', 'personal-user', 'personal-device', now(), now(), now() + interval '4 minutes'),
      ('organization-client', 'organization-user', 'organization-device', now(), now(), now() + interval '4 minutes');
     INSERT INTO rika_hosted_client_authorities (client_id, owner_id, issued_at, expires_at) VALUES
      ('personal-client', 'personal-owner', now(), now() + interval '4 minutes'),
      ('organization-client', 'organization-owner', now(), now() + interval '4 minutes');
     INSERT INTO rika_hosted_executor_assignments
      (id, owner_id, thread_id, workspace_id, executor_kind, placement, checkout, generation, revision,
       last_lease_epoch, lifecycle, provider_instance_id, executor_instance_id, process_incarnation,
       session_digest, lease_epoch, lease_expires_at) VALUES
      ('personal-assignment', 'personal-owner', 'personal-thread', 'personal-workspace', 'e2b',
       '{"_tag":"E2BPlacement","templateBuildId":"build","providerScope":"scope"}',
       '{"ownerId":"personal-owner","projectId":"personal-project","repositoryId":"repository-personal","installationId":"installation","owner":"owner","name":"repo","ref":"main","commitSha":"1111111111111111111111111111111111111111","private":true,"gitIdentity":{"name":"Personal User","email":"personal@example.test"}}',
       1, 0, 1, 'active', 'personal-instance', 'personal-assignment-executor', 'personal-assignment-process',
       'personal-session-digest', 1, now() + interval '4 minutes'),
      ('organization-assignment', 'organization-owner', 'organization-thread', 'organization-workspace', 'e2b',
       '{"_tag":"E2BPlacement","templateBuildId":"build","providerScope":"scope"}',
       '{"ownerId":"organization-owner","projectId":"organization-project","repositoryId":"repository-organization","installationId":"installation","owner":"owner","name":"repo","ref":"main","commitSha":"2222222222222222222222222222222222222222","private":true,"gitIdentity":{"name":"Organization User","email":"organization@example.test"}}',
       1, 0, 1, 'active', 'organization-instance', 'organization-assignment-executor', 'organization-assignment-process',
       'organization-session-digest', 1, now() + interval '4 minutes');
     INSERT INTO rika_hosted_thread_protocol_state (owner_id, thread_id) VALUES
      ('personal-owner', 'personal-thread'),
      ('organization-owner', 'organization-thread');
     INSERT INTO rika_hosted_thread_protocol_commands
      (owner_id, thread_id, command_id, idempotency_key, expected_version, thread_version, actor, command,
       state, admitted_at) VALUES
      ('personal-owner', 'personal-thread', 'personal-turn', 'personal-command', 0, 1,
       '${JSON.stringify(personalActor)}', '{"_tag":"SubmitPrompt"}', 'admitted', now()),
      ('organization-owner', 'organization-thread', 'organization-turn', 'organization-command', 0, 1,
       '${JSON.stringify(organizationActor)}', '{"_tag":"SubmitPrompt"}', 'admitted', now())`,
  )

it.effect.skipIf(databaseUrl === undefined)(
  "persists secret-free exact tool decisions and enforces personal and organization audit ownership",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = `rika_tool_policy_${Math.abs(yield* Random.nextInt)}`
        const admin = new Pool({ connectionString: databaseUrl })
        yield* query(admin, `CREATE DATABASE "${database}"`)
        const parsed = new URL(databaseUrl!)
        parsed.pathname = `/${database}`
        const url = parsed.toString()
        const pool = new Pool({ connectionString: url })
        try {
          for (const migration of [...identityMigrations, ...productMigrations])
            yield* runMigration({
              pool,
              id: migration.id,
              checksum: migration.checksum,
              sql: yield* Effect.promise(() => Bun.file(migration.url).text()),
            })
          yield* seed(pool)
          const dependencies = Layer.merge(
            HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 4 }),
            BunCrypto.layer,
          )
          const context = yield* Layer.build(
            Layer.merge(toolPolicyLayer.pipe(Layer.provide(dependencies)), dependencies),
          )
          const policy = Context.get(context, HostedToolPolicy)
          const crypto = Context.get(context, Crypto.Crypto)
          const rawMarker = "raw-secret-prompt-cell-source-marker"
          const request = {
            module: "processes",
            operation: "start",
            input: { command: `git push https://${rawMarker}@example.test/repository` },
            sessionId: "personal-thread",
            cellId: "personal-call",
          } as const
          const admission = yield* policy.begin({
            threadId: "personal-thread",
            turnId: "personal-turn",
            workspaceId: "personal-workspace",
            operationKey: "personal-operation",
            callId: "personal-call",
            request,
            access: access("personal-assignment", "personal-instance"),
            policy: policyFor(request),
            argumentsDigest: yield* argumentsDigest(request.input).pipe(Effect.provideService(Crypto.Crypto, crypto)),
          })
          expect(admission).toMatchObject({
            actor: personalActor,
            repository: { identity: "repository-personal" },
            branch: `detached:${"1".repeat(40)}`,
            executor: { assignmentId: "personal-assignment", kind: "e2b" },
            policy: { capability: "publishing.execute", approval: "exact" },
          })
          yield* policy.outcome({ ...admission, authorizationId: "internal-approval", outcome: "suspended" })
          const exactRequest = toolAuthorizationRequest(admission)
          const exactRequestText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(exactRequest)
          const wrongDigestRequestText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            ...exactRequest,
            argumentsDigest: "0".repeat(64),
          })
          expect(
            yield* Effect.result(
              policy.recordDecision({
                ownerId: "personal-owner",
                threadId: "personal-thread",
                turnId: "personal-turn",
                actor: personalActor,
                authorizationId: "wrong-authorization",
                checkpoint: { version: 4, cursor: "wrong", state: "wrong" },
                operation: "rika.tool.processes.start",
                capability: "publishing.execute",
                authorizationRequest: wrongDigestRequestText,
                decision: "approved",
                outcome: "admitted",
              }),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { kind: "conflict" } })
          expect(
            yield* Effect.result(
              policy.recordDecision({
                ownerId: "personal-owner",
                threadId: "personal-thread",
                turnId: "personal-turn",
                actor: personalActor,
                authorizationId: "wrong-authorization",
                checkpoint: { version: 4, cursor: "wrong", state: "wrong" },
                operation: "rika.tool.processes.start",
                capability: "publishing.execute",
                authorizationRequest: exactRequestText,
                decision: "approved",
                outcome: "admitted",
              }),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { kind: "conflict" } })
          yield* policy.recordDecision({
            ownerId: "personal-owner",
            threadId: "personal-thread",
            turnId: "personal-turn",
            actor: personalActor,
            authorizationId: "internal-approval",
            checkpoint: {
              version: 4,
              cursor: "checkpoint-cursor",
              state: `checkpoint-with-${rawMarker}`,
            },
            operation: "rika.tool.processes.start",
            capability: "publishing.execute",
            authorizationRequest: exactRequestText,
            decision: "approved",
            outcome: "admitted",
          })
          yield* policy.outcome({ ...admission, outcome: "succeeded" })
          const records = yield* policy.list({
            principal: { userId: "personal-user" },
            owner: personalOwner("personal-user"),
            limit: 100,
          })
          expect(records.map(({ phase, decision, outcome }) => ({ phase, decision, outcome }))).toEqual([
            { phase: "outcome", decision: "pending", outcome: "succeeded" },
            { phase: "decision", decision: "approved", outcome: "admitted" },
            { phase: "outcome", decision: "pending", outcome: "suspended" },
            { phase: "admission", decision: "pending", outcome: "admitted" },
          ])
          expect(records.find(({ phase }) => phase === "decision")).toMatchObject({
            authorizationId: "internal-approval",
            authorizationCheckpoint: { version: 4, cursor: "checkpoint-cursor" },
          })
          const stored = (yield* query(
            pool,
            `SELECT jsonb_agg(to_jsonb(record))::text AS value FROM rika_hosted_tool_audit_records record`,
          )).rows[0]?.value as string
          expect(stored).not.toContain(rawMarker)
          expect(stored).not.toContain("command")
          const mutation = yield* Effect.result(
            Effect.tryPromise(() =>
              pool.query(`UPDATE rika_hosted_tool_audit_records SET outcome = 'failed' WHERE sequence = 1`),
            ),
          )
          expect(mutation._tag).toBe("Failure")
          const deletion = yield* Effect.result(
            Effect.tryPromise(() => pool.query(`DELETE FROM rika_hosted_tool_audit_records WHERE sequence = 1`)),
          )
          expect(deletion._tag).toBe("Failure")
          const foreign = yield* Effect.result(
            policy.list({
              principal: { userId: "foreign-user" },
              owner: personalOwner("personal-user"),
              limit: 100,
            }),
          )
          expect(foreign).toMatchObject({ _tag: "Failure", failure: { kind: "forbidden" } })
          yield* query(
            pool,
            `UPDATE rika_hosted_client_authorities SET revoked_at = now()
              WHERE client_id = 'personal-client' AND owner_id = 'personal-owner'`,
          )
          expect(
            yield* Effect.result(
              policy.begin({
                threadId: "personal-thread",
                turnId: "personal-turn",
                workspaceId: "personal-workspace",
                operationKey: "revoked-operation",
                callId: "revoked-call",
                request,
                access: access("personal-assignment", "personal-instance"),
                policy: policyFor(request),
                argumentsDigest: admission.argumentsDigest,
              }),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { kind: "forbidden" } })

          const organizationRequest = {
            module: "workspace",
            operation: "read",
            input: { path: "README.md" },
            sessionId: "organization-thread",
            cellId: "organization-call",
          } as const
          const organizationAdmission = yield* policy.begin({
            threadId: "organization-thread",
            turnId: "organization-turn",
            workspaceId: "organization-workspace",
            operationKey: "organization-operation",
            callId: "organization-call",
            request: organizationRequest,
            access: access("organization-assignment", "organization-instance"),
            policy: policyFor(organizationRequest),
            argumentsDigest: yield* argumentsDigest(organizationRequest.input).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
            ),
          })
          yield* policy.outcome({ ...organizationAdmission, outcome: "succeeded" })
          expect(
            yield* policy.list({
              principal: { userId: "organization-user" },
              owner: organizationOwner("organization-1"),
              limit: 100,
            }),
          ).toHaveLength(2)
          yield* query(pool, `DELETE FROM "member" WHERE id = 'organization-member'`)
          expect(
            yield* Effect.result(
              policy.list({
                principal: { userId: "organization-user" },
                owner: organizationOwner("organization-1"),
                limit: 100,
              }),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { kind: "forbidden" } })
        } finally {
          yield* Effect.promise(() => pool.end())
          yield* query(admin, `DROP DATABASE "${database}" WITH (FORCE)`)
          yield* Effect.promise(() => admin.end())
        }
      }),
    ),
)
