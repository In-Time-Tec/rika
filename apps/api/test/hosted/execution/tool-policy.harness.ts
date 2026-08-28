import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { identityMember, identityMigrations, identityOrganization, identityUser, runMigration } from "@rika/identity"
import { ActorAttribution } from "@rika/product/hosted-model"
import {
  rikaHostedClientAuthorities,
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedProjectRepositories,
  rikaHostedProjects,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolState,
  rikaHostedThreads,
  rikaHostedToolAuditRecords,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaTranscriptCheckpoints,
  rikaTurns,
  rikaWorkspaces,
} from "@rika/product-store/database-schema"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as HostedPostgres from "@rika/product-store/layer"
import type { AccessWire, BindingRequest } from "@rika/remote-execution/protocol"
import { FileSystem, Config, Context, Crypto, DateTime, Effect, Layer, Random, Redacted, Schema } from "effect"
import { and, count, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { inspect } from "node:util"
import { Pool } from "pg"
import { live as livePlatform } from "../../support/live-platform"
import {
  HostedToolPolicy,
  argumentsDigest,
  layer as toolPolicyLayer,
  organizationOwner,
  personalOwner,
  policyFor,
  type RecordDecisionInput,
} from "../../../src/hosted/execution/tool-policy"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const Json = Schema.fromJsonString(Schema.Json)

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

const access = (assignmentId: string, instanceId: string): AccessWire => ({
  version: 1,
  fence: {
    target: "orb",
    assignmentId,
    assignmentGeneration: 1,
    instanceId,
    executorId: `${assignmentId}-executor`,
    processIncarnation: `${assignmentId}-process`,
  },
  leaseEpoch: 1,
  sessionToken: `${assignmentId}-session`,
})

it.effect.skipIf(databaseUrl === "")(
  "persists secret-free exact tool decisions and enforces personal and organization audit ownership",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = `rika_tool_policy_${Math.abs(yield* Random.nextInt)}`
        const admin = new Pool({ connectionString: databaseUrl })
        yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
        const parsed = new URL(databaseUrl)
        parsed.pathname = `/${database}`
        const url = parsed.toString()
        const pool = new Pool({ connectionString: url })
        const db = drizzle({ client: pool })
        try {
          for (const migration of [...identityMigrations, ...productMigrations])
            yield* runMigration({
              pool,
              id: migration.id,
              checksum: migration.checksum,
              sql: yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
                fileSystem.readFileString(migration.url.pathname),
              ),
            })
          const current = DateTime.nowUnsafe()
          const now = DateTime.toDate(current)
          const expiresAt = DateTime.toDate(DateTime.add(current, { minutes: 4 }))
          yield* Effect.tryPromise(() =>
            db.insert(identityUser).values([
              {
                id: "personal-user",
                name: "personal-user",
                email: "personal@example.test",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: "foreign-user",
                name: "foreign-user",
                email: "foreign@example.test",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: "organization-user",
                name: "organization-user",
                email: "organization@example.test",
                emailVerified: true,
                createdAt: now,
                updatedAt: now,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(identityOrganization).values({
              id: "organization-1",
              name: "organization-1",
              slug: "organization-1",
              createdAt: now,
            }),
          )
          yield* Effect.tryPromise(() =>
            db.insert(identityMember).values({
              id: "organization-member",
              organizationId: "organization-1",
              userId: "organization-user",
              role: "member",
              createdAt: now,
            }),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedOwners).values([
              { id: "personal-owner", kind: "personal", userId: "personal-user" },
              { id: "organization-owner", kind: "organization", organizationId: "organization-1" },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedProjects).values([
              {
                id: "personal-project",
                ownerId: "personal-owner",
                name: "personal-project",
                createdByUserId: "personal-user",
                createdAt: now,
                updatedAt: now,
              },
              {
                id: "organization-project",
                ownerId: "organization-owner",
                name: "organization-project",
                createdByUserId: "organization-user",
                createdAt: now,
                updatedAt: now,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedWorkspaces).values([
              {
                id: "personal-workspace",
                ownerId: "personal-owner",
                projectId: "personal-project",
                createdByUserId: "personal-user",
                executorKind: "orb",
                inheritProjectGrants: false,
                createdAt: now,
              },
              {
                id: "organization-workspace",
                ownerId: "organization-owner",
                projectId: "organization-project",
                createdByUserId: "organization-user",
                executorKind: "orb",
                inheritProjectGrants: false,
                createdAt: now,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedThreads).values([
              {
                id: "personal-thread",
                ownerId: "personal-owner",
                projectId: "personal-project",
                workspaceId: "personal-workspace",
                createdByUserId: "personal-user",
                executorKind: "orb",
                inheritProjectGrants: false,
                createdAt: now,
              },
              {
                id: "organization-thread",
                ownerId: "organization-owner",
                projectId: "organization-project",
                workspaceId: "organization-workspace",
                createdByUserId: "organization-user",
                executorKind: "orb",
                inheritProjectGrants: false,
                createdAt: now,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedProjectRepositories).values([
              {
                projectId: "personal-project",
                ownerId: "personal-owner",
                repositoryId: "repository-personal",
                installationId: "installation",
                installationAccountId: "account-personal",
                installationAccountLogin: "owner",
                installationAccountType: "Organization",
                repositoryOwner: "owner",
                repositoryName: "repo",
                defaultRef: "main",
                private: true,
              },
              {
                projectId: "organization-project",
                ownerId: "organization-owner",
                repositoryId: "repository-organization",
                installationId: "installation",
                installationAccountId: "account-organization",
                installationAccountLogin: "owner",
                installationAccountType: "Organization",
                repositoryOwner: "owner",
                repositoryName: "repo",
                defaultRef: "main",
                private: true,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedDevices).values([
              {
                id: "personal-device",
                userId: "personal-user",
                displayName: "personal",
                publicKeyFingerprint: "personal-key",
                createdAt: now,
                lastSeenAt: now,
              },
              {
                id: "organization-device",
                userId: "organization-user",
                displayName: "organization",
                publicKeyFingerprint: "organization-key",
                createdAt: now,
                lastSeenAt: now,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedClients).values([
              {
                id: "personal-client",
                userId: "personal-user",
                deviceId: "personal-device",
                authenticatedAt: now,
                lastSeenAt: now,
                expiresAt,
              },
              {
                id: "organization-client",
                userId: "organization-user",
                deviceId: "organization-device",
                authenticatedAt: now,
                lastSeenAt: now,
                expiresAt,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedClientAuthorities).values([
              { clientId: "personal-client", ownerId: "personal-owner", issuedAt: now, expiresAt },
              { clientId: "organization-client", ownerId: "organization-owner", issuedAt: now, expiresAt },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedExecutorAssignments).values([
              {
                id: "personal-assignment",
                ownerId: "personal-owner",
                threadId: "personal-thread",
                workspaceId: "personal-workspace",
                executorKind: "orb",
                placement: { _tag: "OrbPlacement", templateBuildId: "build", providerScope: "scope" },
                checkout: {
                  ownerId: "personal-owner",
                  projectId: "personal-project",
                  repositoryId: "repository-personal",
                  installationId: "installation",
                  owner: "owner",
                  name: "repo",
                  ref: "main",
                  commitSha: "1111111111111111111111111111111111111111",
                  private: true,
                  gitIdentity: { name: "Personal User", email: "personal@example.test" },
                },
                generation: 1,
                revision: 0,
                lastLeaseEpoch: 1,
                lifecycle: "active",
                providerInstanceId: "personal-instance",
                executorInstanceId: "personal-assignment-executor",
                processIncarnation: "personal-assignment-process",
                sessionDigest: "personal-session-digest",
                leaseEpoch: 1,
                leaseExpiresAt: expiresAt,
              },
              {
                id: "organization-assignment",
                ownerId: "organization-owner",
                threadId: "organization-thread",
                workspaceId: "organization-workspace",
                executorKind: "orb",
                placement: { _tag: "OrbPlacement", templateBuildId: "build", providerScope: "scope" },
                checkout: {
                  ownerId: "organization-owner",
                  projectId: "organization-project",
                  repositoryId: "repository-organization",
                  installationId: "installation",
                  owner: "owner",
                  name: "repo",
                  ref: "main",
                  commitSha: "2222222222222222222222222222222222222222",
                  private: true,
                  gitIdentity: { name: "Organization User", email: "organization@example.test" },
                },
                generation: 1,
                revision: 0,
                lastLeaseEpoch: 1,
                lifecycle: "active",
                providerInstanceId: "organization-instance",
                executorInstanceId: "organization-assignment-executor",
                processIncarnation: "organization-assignment-process",
                sessionDigest: "organization-session-digest",
                leaseEpoch: 1,
                leaseExpiresAt: expiresAt,
              },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedThreadProtocolState).values([
              { ownerId: "personal-owner", threadId: "personal-thread" },
              { ownerId: "organization-owner", threadId: "organization-thread" },
            ]),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaHostedThreadProtocolCommands).values([
              {
                ownerId: "personal-owner",
                threadId: "personal-thread",
                commandId: "personal-turn",
                idempotencyKey: "personal-command",
                expectedVersion: 0,
                threadVersion: 1,
                actor: personalActor,
                command: { _tag: "SubmitPrompt" },
                state: "admitted",
                admittedAt: now,
              },
              {
                ownerId: "organization-owner",
                threadId: "organization-thread",
                commandId: "organization-turn",
                idempotencyKey: "organization-command",
                expectedVersion: 0,
                threadVersion: 1,
                actor: organizationActor,
                command: { _tag: "SubmitPrompt" },
                state: "admitted",
                admittedAt: now,
              },
            ]),
          )
          const dependencies = Layer.merge(
            HostedPostgres.layer({
              url: Redacted.make(url),
              maxConnections: 4,
            }),
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
            input: {
              command: `git push https://${rawMarker}@example.test/repository`,
            },
            sessionId: "personal-thread",
            cellId: "personal-call",
          } satisfies BindingRequest
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
            executor: { assignmentId: "personal-assignment", kind: "orb" },
            policy: { capability: "publishing.execute", approval: "exact" },
          })
          yield* policy.outcome({
            ...admission,
            authorizationId: "internal-approval",
            outcome: "suspended",
          })
          const authorizationProjectionState = {
            authorizations: [
              [
                "internal-approval",
                {
                  authorizationId: "internal-approval",
                  rawRunId: "personal-turn",
                  approvalId: "personal-approval",
                  unitKey: "personal-authorization",
                },
              ],
            ],
          }
          const authorizationState = yield* Schema.encodeEffect(Json)(authorizationProjectionState)
          yield* Effect.tryPromise(() =>
            db.insert(rikaWorkspaces).values({ ownerId: "personal-owner", path: "hosted", createdAt: 1 }),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaThreads).values({
              id: "personal-thread",
              ownerId: "personal-owner",
              workspace: "hosted",
              title: "Personal Thread",
              createdAt: 1,
              updatedAt: 1,
            }),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaTurns).values({
              id: "personal-turn",
              threadId: "personal-thread",
              prompt: "prompt",
              status: "waiting",
              executionRouteJson: "{}",
              createdAt: 1,
              updatedAt: 1,
            }),
          )
          yield* Effect.tryPromise(() =>
            db.insert(rikaTranscriptCheckpoints).values({
              turnId: "personal-turn",
              threadId: "personal-thread",
              revision: 0,
              projectionVersion: 6,
              stateJson: "{}",
              projectorVersion: 6,
              projectorCursor: "current-cursor",
              projectorState: authorizationState,
              updatedAt: 1,
            }),
          )
          expect(
            yield* Effect.result(
              policy.recordDecision({
                ownerId: "personal-owner",
                threadId: "personal-thread",
                turnId: "personal-turn",
                actor: personalActor,
                authorizationId: "wrong-authorization",
                checkpoint: { version: 6, cursor: "wrong", state: "wrong" },
                decision: "approved",
              }),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { kind: "conflict" } })
          const checkpointState = yield* Schema.encodeEffect(Json)({
            ...authorizationProjectionState,
            marker: `checkpoint-with-${rawMarker}`,
          })
          const authorizationDecision: RecordDecisionInput = {
            ownerId: "personal-owner",
            threadId: "personal-thread",
            turnId: "personal-turn",
            actor: personalActor,
            authorizationId: "internal-approval",
            checkpoint: {
              version: 6,
              cursor: "checkpoint-cursor",
              state: checkpointState,
            },
            decision: "approved",
          }
          const conflictingState = yield* Schema.encodeEffect(Json)({
            authorizations: [
              [
                "internal-approval",
                {
                  authorizationId: "internal-approval",
                  rawRunId: "different-run",
                  approvalId: "different-approval",
                  unitKey: "different-authorization",
                },
              ],
            ],
          })
          expect(
            yield* Effect.result(
              policy.recordDecision({
                ...authorizationDecision,
                checkpoint: {
                  ...authorizationDecision.checkpoint,
                  state: conflictingState,
                },
              }),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { kind: "conflict" } })
          expect(
            (yield* Effect.tryPromise(() =>
              db
                .select({ count: count() })
                .from(rikaHostedToolAuditRecords)
                .where(eq(rikaHostedToolAuditRecords.phase, "decision")),
            ))[0]?.count,
          ).toBe(0)
          yield* policy.recordDecision(authorizationDecision)
          yield* policy.recordDecision(authorizationDecision)
          expect(
            yield* Effect.result(
              policy.recordDecision({
                ...authorizationDecision,
                decision: "denied",
              }),
            ),
          ).toMatchObject({
            _tag: "Failure",
            failure: { kind: "conflict" },
          })
          yield* policy.outcome({ ...admission, outcome: "succeeded" })
          const records = yield* policy.list({
            principal: { userId: "personal-user" },
            owner: personalOwner("personal-user"),
            limit: 100,
          })
          expect(
            records.map(({ phase, decision, outcome }) => ({
              phase,
              decision,
              outcome,
            })),
          ).toEqual([
            { phase: "outcome", decision: "pending", outcome: "succeeded" },
            { phase: "decision", decision: "approved", outcome: "admitted" },
            { phase: "outcome", decision: "pending", outcome: "suspended" },
            { phase: "admission", decision: "pending", outcome: "admitted" },
          ])
          expect(records.find(({ phase }) => phase === "decision")).toMatchObject({
            authorizationId: "internal-approval",
            authorizationCheckpoint: {
              version: 6,
              cursor: "checkpoint-cursor",
            },
          })
          const stored = inspect(yield* Effect.tryPromise(() => db.select().from(rikaHostedToolAuditRecords)), {
            depth: null,
          })
          expect(stored).not.toContain(rawMarker)
          expect(stored).not.toContain("command")
          const mutation = yield* Effect.result(
            Effect.tryPromise(() =>
              db
                .update(rikaHostedToolAuditRecords)
                .set({ outcome: "failed" })
                .where(eq(rikaHostedToolAuditRecords.sequence, 1)),
            ),
          )
          expect(mutation._tag).toBe("Failure")
          const deletion = yield* Effect.result(
            Effect.tryPromise(() =>
              db.delete(rikaHostedToolAuditRecords).where(eq(rikaHostedToolAuditRecords.sequence, 1)),
            ),
          )
          expect(deletion._tag).toBe("Failure")
          const foreign = yield* Effect.result(
            policy.list({
              principal: { userId: "foreign-user" },
              owner: personalOwner("personal-user"),
              limit: 100,
            }),
          )
          expect(foreign).toMatchObject({
            _tag: "Failure",
            failure: { kind: "forbidden" },
          })
          const revokedAt = DateTime.toDate(DateTime.nowUnsafe())
          yield* Effect.tryPromise(() =>
            db
              .update(rikaHostedClientAuthorities)
              .set({ revokedAt })
              .where(
                and(
                  eq(rikaHostedClientAuthorities.clientId, "personal-client"),
                  eq(rikaHostedClientAuthorities.ownerId, "personal-owner"),
                ),
              ),
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
          } satisfies BindingRequest
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
          yield* policy.outcome({
            ...organizationAdmission,
            outcome: "succeeded",
          })
          expect(
            yield* policy.list({
              principal: { userId: "organization-user" },
              owner: organizationOwner("organization-1"),
              limit: 100,
            }),
          ).toHaveLength(2)
          yield* Effect.tryPromise(() => db.delete(identityMember).where(eq(identityMember.id, "organization-member")))
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
          yield* Effect.tryPromise(() => pool.end())
          yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
          yield* Effect.tryPromise(() => admin.end())
        }
      }),
    ).pipe(livePlatform),
)
