import * as PgClient from "@effect/sql-pg/PgClient"
import { Clock, Context, Crypto, DateTime, Effect, Layer, Schema } from "effect"
import { AuthorizationPolicy, type AuthorizationAction } from "@rika/product/hosted-authorization"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import {
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  CommandId,
  DeviceId,
  ExecutorAssignmentId,
  type ActorAttribution,
  type HostedOwner,
  IdempotencyKey,
  JsonObject,
  OrganizationId,
  OwnerId,
  ProjectId,
  ThreadId,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedStore, StoreError } from "@rika/product/hosted-store"
import type { PromptPart } from "@rika/product/execution-request"
import { TurnId } from "@rika/product/turn-record"
import type { RunnerProfile, RunnerTarget, RemoteThreadCreationPreference } from "@rika/product/runner-registration"
import { layer as postgresLayer } from "@rika/product-store/postgres-layer"
import {
  HostedModelRegistry,
  HostedModelRegistryError,
  testLayer as hostedModelRegistryTestLayer,
} from "./hosted-model-registry"
import { HostedRepositories, unavailableLayer as hostedRepositoriesUnavailableLayer } from "./hosted-repositories"

export interface AuthenticatedPrincipal {
  readonly userId: string
  readonly deviceId: string
  readonly clientId: string
  readonly dpopJkt?: string
}

export type OwnerSelection = HostedOwner

export interface ProjectContext {
  readonly id: string
  readonly ownerId: string
  readonly owner: HostedOwner
  readonly name: string
  readonly role: "viewer" | "controller" | "operator" | "owner"
}

export type AdmittedRun =
  | { readonly _tag: "Admitted"; readonly commandId: string; readonly turnId: string; readonly status: "accepted" | "queued" }
  | { readonly _tag: "Cancelled"; readonly commandId: string }

export interface ThreadAuthority {
  readonly ownerId: OwnerId
  readonly actor: ActorAttribution
}

export interface ThreadExecutionContext {
  readonly repository: JsonObject | null
  readonly branch: string | null
  readonly executor: JsonObject
}

export class HostedProductError extends Schema.TaggedError<HostedProductError>()("HostedProductError", {
  kind: Schema.optionalKey(Schema.Literals(["conflict", "not-found", "forbidden", "invalid", "unavailable"])),
  message: Schema.String,
}) {}

const unavailable = () =>
  HostedProductError.make({ kind: "unavailable", message: "Hosted product service is unavailable" })

const forbidden = (message = "Resource is unavailable") => HostedProductError.make({ kind: "forbidden", message })

const storeFailure = (error: unknown) => {
  if (Schema.is(HostedProductError)(error)) return error
  if (!Schema.is(StoreError)(error)) return unavailable()
  let kind: NonNullable<HostedProductError["kind"]> = "unavailable"
  if (error.reason === "conflict" || error.reason === "stale-fence") kind = "conflict"
  else if (error.reason === "not-found") kind = "not-found"
  else if (error.reason === "invalid-authority") kind = "forbidden"
  return HostedProductError.make({ kind, message: "Hosted product operation was rejected" })
}

const modelFailure = (error: HostedModelRegistryError) =>
  HostedProductError.make({
    kind: error.kind === "unavailable" ? "unavailable" : "invalid",
    message: error.message,
  })

export interface HostedProductService {
  readonly ready: Effect.Effect<void, HostedProductError>
  readonly projects: (
    principal: AuthenticatedPrincipal,
  ) => Effect.Effect<ReadonlyArray<ProjectContext>, HostedProductError>
  readonly createProject: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: OwnerSelection
    readonly name: string
  }) => Effect.Effect<ProjectContext, HostedProductError>
  readonly createConnection: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: OwnerSelection
    readonly projectId?: string
    readonly executorKind: "runner" | "orb"
    readonly runnerTarget?: RunnerTarget
    readonly threadId?: string
  }) => Effect.Effect<{ readonly threadId: string }, HostedProductError>
  readonly registerRunner: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly checkoutFingerprint: string
    readonly registration: RunnerProfile
  }) => Effect.Effect<void, HostedProductError>
  readonly setRemoteThreadCreation: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly checkoutFingerprint: string
    readonly preference: RemoteThreadCreationPreference
  }) => Effect.Effect<void, HostedProductError>
  readonly pollRunner: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly checkoutFingerprint: string
    readonly supervisorId: string
    readonly activeAssignmentIds: ReadonlyArray<string>
  }) => Effect.Effect<
    {
      readonly claimed: boolean
      readonly assignment?: {
        readonly assignmentId: string
        readonly threadId: string
        readonly workspaceId: string
        readonly resume: boolean
        readonly leaseExpiresAt: number | null
      }
    },
    HostedProductError
  >
  readonly admitRun: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly threadId: string
    readonly operationKey: string
    readonly prompt: string
    readonly promptParts?: ReadonlyArray<PromptPart>
    readonly mode?: string
  }) => Effect.Effect<AdmittedRun, HostedProductError>
  readonly admitAuthorizedRun: (input: {
    readonly authority: ThreadAuthority
    readonly threadId: string
    readonly operationKey: string
    readonly prompt: string
    readonly promptParts?: ReadonlyArray<PromptPart>
    readonly mode?: string
  }) => Effect.Effect<AdmittedRun, HostedProductError>
  readonly cancelRunAdmission: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly threadId: string
    readonly cancelCommandId: string
    readonly targetCommandId: string
  }) => Effect.Effect<{ readonly turnId?: string }, HostedProductError>
  readonly cancelAuthorizedRunAdmission: (input: {
    readonly authority: ThreadAuthority
    readonly threadId: string
    readonly cancelCommandId: string
    readonly targetCommandId: string
  }) => Effect.Effect<{ readonly turnId?: string }, HostedProductError>
  readonly authorizeThread: (
    principal: AuthenticatedPrincipal,
    threadId: string,
    action: AuthorizationAction,
  ) => Effect.Effect<ThreadAuthority, HostedProductError>
  readonly threadExecutionContext: (
    ownerId: OwnerId,
    threadId: ThreadId,
  ) => Effect.Effect<ThreadExecutionContext, HostedProductError>
  readonly activatePrincipal: (principal: AuthenticatedPrincipal) => Effect.Effect<void, HostedProductError>
}

export class HostedProduct extends Context.Service<HostedProduct, HostedProductService>()(
  "@rika/api/hosted-product/HostedProduct",
) {}

export const layer = (options: {
  readonly orb?: {
    readonly templateBuildId: string
    readonly providerScope: string
  }
  readonly promptAdmissionReadiness: Effect.Effect<boolean>
}) =>
  Layer.effect(
    HostedProduct,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const store = yield* HostedStore
      const assignments = yield* ExecutorAssignments
      const policy = yield* AuthorizationPolicy
      const crypto = yield* Crypto.Crypto
      const modelRegistry = yield* HostedModelRegistry
      const repositories = yield* HostedRepositories

      const activateClient = Effect.fn("HostedProduct.activateClient")(function* (
        principal: AuthenticatedPrincipal,
        userId: BetterAuthUserId,
      ) {
        const currentTime = yield* Clock.currentTimeMillis
        const now = DateTime.formatIso(DateTime.makeUnsafe(currentTime))
        const deviceId = DeviceId.make(principal.deviceId)
        yield* store.registerDevice({
          id: deviceId,
          userId,
          displayName: "Rika CLI",
          publicKeyFingerprint: principal.dpopJkt ?? principal.clientId,
          now,
        })
        yield* store.authenticateClient({
          id: ClientId.make(principal.clientId),
          userId,
          deviceId,
          now,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(currentTime + 5 * 60 * 1000)),
        })
        return deviceId
      })

      const resolveOwner = Effect.fn("HostedProduct.resolveOwner")(function* (
        principal: AuthenticatedPrincipal,
        selection: OwnerSelection,
      ) {
        const userId = BetterAuthUserId.make(principal.userId)
        const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
        let membershipId: BetterAuthMemberId | undefined
        if (selection._tag === "PersonalOwner") {
          if (selection.userId !== userId) return yield* forbidden()
          const identities = yield* sql<{
            readonly id: string
          }>`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`.pipe(Effect.mapError(unavailable))
          if (identities[0] === undefined) return yield* forbidden()
        } else {
          const identities = yield* sql<{ readonly membershipId: string }>`SELECT membership.id AS "membershipId"
            FROM "organization" organization_record
            JOIN "member" membership ON membership.organization_id = organization_record.id
              AND membership.user_id = ${userId}
            WHERE organization_record.id = ${selection.organizationId}
            FOR UPDATE OF organization_record`.pipe(Effect.mapError(unavailable))
          if (identities[0] === undefined) return yield* forbidden()
          membershipId = BetterAuthMemberId.make(identities[0].membershipId)
        }
        const rows = yield* sql<{ readonly id: string }>`SELECT id FROM rika_hosted_owners
          WHERE user_id = ${selection._tag === "PersonalOwner" ? userId : null}
            OR organization_id = ${selection._tag === "OrganizationOwner" ? selection.organizationId : null}`.pipe(
          Effect.mapError(unavailable),
        )
        const owner = yield* store.putOwner({
          id: OwnerId.make(rows[0]?.id ?? (yield* crypto.randomUUIDv4)),
          identity: selection,
          now,
        })
        if (selection._tag === "PersonalOwner") return { owner, userId } as const
        return { owner, userId, membershipId: membershipId! } as const
      })

      const projects: HostedProductService["projects"] = Effect.fn("HostedProduct.projects")(function* (principal) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const personal = yield* resolveOwner(principal, {
                _tag: "PersonalOwner",
                userId: BetterAuthUserId.make(principal.userId),
              })
              const organizationRows = yield* sql<{
                readonly organizationId: string
              }>`SELECT organization_id AS "organizationId"
              FROM "member" WHERE user_id = ${principal.userId} ORDER BY organization_id`.pipe(
                Effect.mapError(unavailable),
              )
              for (const row of organizationRows) {
                yield* resolveOwner(principal, {
                  _tag: "OrganizationOwner",
                  organizationId: OrganizationId.make(row.organizationId),
                })
              }
              return yield* sql<ProjectContext>`SELECT project.id, owner_record.id AS "ownerId", project.name,
                CASE WHEN owner_record.kind = 'personal' OR project.created_by_user_id = ${principal.userId}
                  THEN 'owner' ELSE grant_record.role END AS role,
                CASE WHEN owner_record.kind = 'personal'
                  THEN jsonb_build_object('_tag', 'PersonalOwner', 'userId', owner_record.user_id)
                  ELSE jsonb_build_object('_tag', 'OrganizationOwner', 'organizationId', owner_record.organization_id)
                END AS owner
              FROM rika_hosted_projects project
              JOIN rika_hosted_owners owner_record ON owner_record.id = project.owner_id
              LEFT JOIN "member" membership ON membership.organization_id = owner_record.organization_id
                AND membership.user_id = ${principal.userId}
              LEFT JOIN rika_hosted_project_grants grant_record ON grant_record.owner_id = project.owner_id
                AND grant_record.project_id = project.id AND grant_record.membership_id = membership.id
              WHERE (owner_record.kind = 'personal' AND owner_record.id = ${personal.owner.id})
                OR (owner_record.kind = 'organization' AND membership.id IS NOT NULL
                  AND (project.created_by_user_id = ${principal.userId} OR grant_record.role IS NOT NULL))
              ORDER BY project.created_at, project.id`.pipe(Effect.mapError(unavailable))
            }),
          )
          .pipe(Effect.mapError(storeFailure))
      })

      const createProject: HostedProductService["createProject"] = Effect.fn("HostedProduct.createProject")(
        function* (input) {
          const name = input.name.trim()
          if (name.length === 0 || name.length > 128)
            return yield* HostedProductError.make({
              kind: "invalid",
              message: "Project name must contain between 1 and 128 characters",
            })
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const authority = yield* resolveOwner(input.principal, input.owner)
                const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
                const project = yield* store.createProject({
                  id: ProjectId.make(yield* crypto.randomUUIDv4),
                  ownerId: authority.owner.id,
                  name,
                  createdByUserId: authority.userId,
                  now,
                })
                return {
                  id: String(project.id),
                  ownerId: String(project.ownerId),
                  owner: authority.owner.identity,
                  name: project.name,
                  role: "owner" as const,
                }
              }),
            )
            .pipe(Effect.mapError(storeFailure))
        },
      )

      const createConnection: HostedProductService["createConnection"] = Effect.fn("HostedProduct.createConnection")(
        function* (input) {
          const created = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const authority = yield* resolveOwner(input.principal, input.owner)
                const membershipId = "membershipId" in authority ? authority.membershipId : undefined
                const selected =
                  input.projectId === undefined
                    ? undefined
                    : (yield* sql<{ readonly role: ProjectContext["role"] }>`SELECT
                    CASE WHEN project.created_by_user_id = ${authority.userId} THEN 'owner' ELSE grant_record.role END AS role
                  FROM rika_hosted_projects project
                  LEFT JOIN rika_hosted_project_grants grant_record ON grant_record.owner_id = project.owner_id
                    AND grant_record.project_id = project.id
                    AND grant_record.membership_id = ${membershipId ?? null}
                  WHERE project.id = ${input.projectId} AND project.owner_id = ${authority.owner.id}
                    AND (${input.owner._tag} = 'PersonalOwner' OR project.created_by_user_id = ${authority.userId}
                      OR grant_record.role IS NOT NULL)`.pipe(Effect.mapError(unavailable)))[0]
                if (input.projectId !== undefined && selected === undefined)
                  return yield* HostedProductError.make({ kind: "not-found", message: "Project is unavailable" })
                if (input.owner._tag === "OrganizationOwner" && selected !== undefined) {
                  if (membershipId === undefined) return yield* forbidden()
                  yield* policy
                    .authorize("project:update", {
                      memberId: membershipId,
                      projectRole: selected.role,
                    })
                    .pipe(Effect.mapError(() => forbidden()))
                }
                const executorKind = input.executorKind
                if ((executorKind === "runner") !== (input.runnerTarget !== undefined))
                  return yield* HostedProductError.make({
                    kind: "invalid",
                    message: "Runner target is required only for Runner execution",
                  })
                const projectId = input.projectId === undefined ? undefined : ProjectId.make(input.projectId)
                const threadId = ThreadId.make(input.threadId ?? (yield* crypto.randomUUIDv4))
                yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${threadId}, 0))`.pipe(
                  Effect.mapError(unavailable),
                )
                const existingRows = yield* sql<{
                  readonly ownerId: string
                  readonly projectId: string | null
                  readonly createdByUserId: string
                  readonly executorKind: "runner" | "orb"
                  readonly runnerDeviceId: string | null
                  readonly runnerCheckoutFingerprint: string | null
                }>`SELECT thread.owner_id AS "ownerId", thread.project_id AS "projectId",
                    thread.created_by_user_id AS "createdByUserId", thread.executor_kind AS "executorKind",
                    assignment.placement ->> 'deviceId' AS "runnerDeviceId",
                    assignment.placement ->> 'checkoutFingerprint' AS "runnerCheckoutFingerprint"
                  FROM rika_hosted_threads thread
                  JOIN rika_hosted_executor_assignments assignment ON assignment.thread_id = thread.id
                  WHERE thread.id = ${threadId}`.pipe(Effect.mapError(unavailable))
                const existing = existingRows[0]
                if (existing !== undefined) {
                  if (
                    existing.ownerId !== authority.owner.id ||
                    existing.projectId !== (projectId ?? null) ||
                    existing.createdByUserId !== authority.userId ||
                    existing.executorKind !== executorKind ||
                    (input.runnerTarget !== undefined &&
                      (existing.runnerDeviceId !== input.runnerTarget.deviceId ||
                        existing.runnerCheckoutFingerprint !== input.runnerTarget.checkoutFingerprint))
                  ) {
                    return yield* HostedProductError.make({
                      kind: "conflict",
                      message: "Thread identity was reused with incompatible input",
                    })
                  }
                  return { threadId: String(threadId) }
                }
                const orb = executorKind === "orb" ? options.orb : undefined
                if (executorKind === "orb" && orb === undefined)
                  return yield* HostedProductError.make({
                    kind: "unavailable",
                    message: "Orb execution is not configured",
                  })
                const checkout =
                  executorKind === "orb" && input.projectId !== undefined
                    ? yield* repositories.resolve({ ownerId: authority.owner.id, projectId: input.projectId })
                    : null
                const currentTime = yield* Clock.currentTimeMillis
                const timestamp = DateTime.formatIso(DateTime.makeUnsafe(currentTime))
                const deviceId = yield* activateClient(input.principal, authority.userId)
                const actor =
                  authority.owner.identity._tag === "PersonalOwner"
                    ? ({
                        _tag: "PersonalActor",
                        owner: authority.owner.identity,
                        userId: authority.userId,
                        clientId: ClientId.make(input.principal.clientId),
                        deviceId,
                      } as const)
                    : ({
                        _tag: "OrganizationActor",
                        owner: authority.owner.identity,
                        userId: authority.userId,
                        membershipId: membershipId!,
                        clientId: ClientId.make(input.principal.clientId),
                        deviceId,
                      } as const)
                yield* store.grantClientAuthority({
                  ownerId: authority.owner.id,
                  actor,
                  now: timestamp,
                  expiresAt: DateTime.formatIso(DateTime.makeUnsafe(currentTime + 5 * 60 * 1000)),
                })
                const runner =
                  input.runnerTarget === undefined
                    ? undefined
                    : (yield* sql<{
                        readonly workspaceId: string
                        readonly projectId: string | null
                        readonly userId: string
                        readonly allowed: boolean
                      }>`SELECT workspace_id AS "workspaceId", project_id AS "projectId", user_id AS "userId",
                    remote_thread_creation_allowed AS allowed
                  FROM rika_hosted_runner_registrations
                  WHERE device_id = ${input.runnerTarget.deviceId}
                    AND checkout_fingerprint = ${input.runnerTarget.checkoutFingerprint}
                  FOR UPDATE`.pipe(Effect.mapError(unavailable)))[0]
                if (input.runnerTarget !== undefined && runner === undefined)
                  return yield* HostedProductError.make({ kind: "not-found", message: "Runner is unavailable" })
                if (
                  runner !== undefined &&
                  (runner.userId !== authority.userId || runner.projectId !== (input.projectId ?? null))
                )
                  return yield* forbidden("Runner authority does not match the Thread")
                if (
                  runner !== undefined &&
                  input.principal.deviceId !== input.runnerTarget!.deviceId &&
                  !runner.allowed
                )
                  return yield* forbidden("Remote Thread creation is denied by the Runner")
                const workspaceId = WorkspaceId.make(
                  runner?.workspaceId ??
                    (input.threadId === undefined ? yield* crypto.randomUUIDv4 : `${input.threadId}-workspace`),
                )
                const workspaceExists =
                  (yield* sql`SELECT id FROM rika_hosted_workspaces WHERE id = ${workspaceId}`.pipe(
                    Effect.mapError(unavailable),
                  )).length > 0
                if (!workspaceExists)
                  yield* store.createWorkspace({
                    id: workspaceId,
                    ownerId: authority.owner.id,
                    ...(projectId === undefined ? {} : { projectId }),
                    createdByUserId: authority.userId,
                    executorKind,
                    inheritProjectGrants: executorKind === "orb" && projectId !== undefined,
                    now: timestamp,
                  })
                yield* sql`INSERT INTO rika_workspaces (owner_id, path, created_at)
                  VALUES (${authority.owner.id}, ${workspaceId}, ${currentTime})
                  ON CONFLICT (owner_id, path) DO NOTHING`.pipe(Effect.mapError(unavailable))
                const thread = yield* store.createThread({
                  id: threadId,
                  ownerId: authority.owner.id,
                  ...(projectId === undefined ? {} : { projectId }),
                  workspaceId,
                  createdByUserId: authority.userId,
                  executorKind,
                  inheritProjectGrants: executorKind === "orb" && projectId !== undefined,
                  now: timestamp,
                })
                yield* sql`INSERT INTO rika_threads
                  (id, owner_id, workspace, title, created_at, updated_at)
                  VALUES (${thread.id}, ${authority.owner.id}, ${workspaceId}, 'New thread', ${currentTime}, ${currentTime})`.pipe(
                  Effect.mapError(unavailable),
                )
                if (input.owner._tag === "OrganizationOwner" && selected === undefined) {
                  if (membershipId === undefined) return yield* forbidden()
                  yield* store.putThreadGrant({
                    ownerId: authority.owner.id,
                    threadId: thread.id,
                    membershipId,
                    role: "owner",
                    grantedByUserId: authority.userId,
                    now: timestamp,
                  })
                }
                const assignmentId = ExecutorAssignmentId.make(yield* crypto.randomUUIDv4)
                yield* assignments.create({
                  id: assignmentId,
                  ownerId: authority.owner.id,
                  threadId: thread.id,
                  workspaceId,
                  placement:
                    orb === undefined
                      ? {
                          _tag: "RunnerPlacement",
                          deviceId: input.runnerTarget!.deviceId,
                          checkoutFingerprint: input.runnerTarget!.checkoutFingerprint,
                          requestingDeviceId: deviceId,
                        }
                      : {
                          _tag: "OrbPlacement",
                          templateBuildId: orb.templateBuildId,
                          providerScope: orb.providerScope,
                        },
                  checkout,
                })
                return { threadId: String(thread.id) }
              }),
            )
            .pipe(Effect.mapError(storeFailure))
          return created
        },
      )

      const registerRunner: HostedProductService["registerRunner"] = Effect.fn("HostedProduct.registerRunner")(
        function* (input) {
          const userId = BetterAuthUserId.make(input.principal.userId)
          const deviceId = yield* activateClient(input.principal, userId)
          yield* sql`INSERT INTO rika_hosted_runner_registrations
            (device_id, user_id, checkout_fingerprint, workspace_id, project_id, repository, kernel_profile, capabilities)
            VALUES (${deviceId}, ${userId}, ${input.checkoutFingerprint}, ${input.registration.workspaceIdentity},
              ${input.registration.projectId ?? null}, ${sql.json(input.registration.repository)},
              ${sql.json(input.registration.kernel)}, ${sql.json(input.registration.capabilities)})
            ON CONFLICT (device_id, checkout_fingerprint) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id, project_id = EXCLUDED.project_id,
              repository = EXCLUDED.repository, kernel_profile = EXCLUDED.kernel_profile,
              capabilities = EXCLUDED.capabilities, updated_at = transaction_timestamp()
            WHERE rika_hosted_runner_registrations.user_id = EXCLUDED.user_id`.pipe(Effect.mapError(unavailable))
        },
        Effect.mapError(storeFailure),
      )

      const setRemoteThreadCreation: HostedProductService["setRemoteThreadCreation"] = Effect.fn(
        "HostedProduct.setRemoteThreadCreation",
      )(function* (input) {
        yield* activateClient(input.principal, BetterAuthUserId.make(input.principal.userId))
        const rows = yield* sql`UPDATE rika_hosted_runner_registrations
            SET remote_thread_creation_allowed = ${input.preference.preference === "allowed"}, updated_at = transaction_timestamp()
            WHERE device_id = ${input.principal.deviceId} AND user_id = ${input.principal.userId}
              AND checkout_fingerprint = ${input.checkoutFingerprint} RETURNING device_id`.pipe(
          Effect.mapError(unavailable),
        )
        if (rows.length === 0)
          return yield* HostedProductError.make({ kind: "not-found", message: "Runner is unavailable" })
      }, Effect.mapError(storeFailure))

      const pollRunner: HostedProductService["pollRunner"] = Effect.fn("HostedProduct.pollRunner")(function* (input) {
        yield* activateClient(input.principal, BetterAuthUserId.make(input.principal.userId))
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const claimed = yield* sql`UPDATE rika_hosted_runner_registrations
              SET supervisor_id = ${input.supervisorId},
                supervisor_expires_at = clock_timestamp() + interval '10 seconds',
                updated_at = transaction_timestamp()
              WHERE device_id = ${input.principal.deviceId}
                AND checkout_fingerprint = ${input.checkoutFingerprint}
                AND user_id = ${input.principal.userId}
                AND (supervisor_id = ${input.supervisorId}
                  OR supervisor_expires_at IS NULL
                  OR supervisor_expires_at <= clock_timestamp())
              RETURNING device_id`
            if (claimed.length === 0) return { claimed: false as const }
            const rows = yield* sql<{
              readonly assignmentId: string
              readonly threadId: string
              readonly workspaceId: string
              readonly resume: boolean
              readonly leaseExpiresAt: number | null
            }>`SELECT assignment.id AS "assignmentId", assignment.thread_id AS "threadId",
                  assignment.workspace_id AS "workspaceId",
                  assignment.lifecycle = 'active' AND assignment.lease_expires_at > clock_timestamp() AS resume,
                  (extract(epoch FROM assignment.lease_expires_at) * 1000)::float8 AS "leaseExpiresAt"
                FROM rika_hosted_executor_assignments assignment
                JOIN rika_hosted_runner_registrations registration
                  ON registration.device_id = ${input.principal.deviceId}
                  AND registration.checkout_fingerprint = ${input.checkoutFingerprint}
                  AND registration.user_id = ${input.principal.userId}
                WHERE assignment.executor_kind = 'runner'
                  AND NOT (${sql.in("assignment.id", input.activeAssignmentIds)})
                  AND (
                    assignment.lifecycle IN ('pending', 'paused')
                    OR (assignment.lifecycle IN ('provisioning', 'awaiting_bootstrap')
                      AND assignment.bootstrap_expires_at <= clock_timestamp())
                    OR assignment.lifecycle = 'active'
                  )
                  AND assignment.placement ->> 'deviceId' = registration.device_id
                  AND assignment.placement ->> 'checkoutFingerprint' = registration.checkout_fingerprint
                  AND (assignment.placement ->> 'requestingDeviceId' = registration.device_id
                    OR registration.remote_thread_creation_allowed = TRUE)
                ORDER BY
                  CASE WHEN assignment.lifecycle = 'active' AND assignment.lease_expires_at > clock_timestamp()
                    THEN 1 ELSE 0 END,
                  CASE WHEN assignment.lifecycle = 'active' THEN assignment.last_active_at ELSE assignment.created_at END,
                  assignment.id
                LIMIT 1 FOR UPDATE OF assignment SKIP LOCKED`
            return { claimed: true as const, ...(rows[0] === undefined ? {} : { assignment: rows[0] }) }
          }).pipe(Effect.mapError(unavailable)),
        )
      }, Effect.mapError(storeFailure))

      const authorizeThread: HostedProductService["authorizeThread"] = Effect.fn("HostedProduct.authorizeThread")(
        function* (principal, threadId, action) {
          yield* activateClient(principal, BetterAuthUserId.make(principal.userId))
          const threadRows = yield* sql<{
            readonly ownerId: string
            readonly kind: "personal" | "organization"
            readonly userId: string | null
            readonly organizationId: string | null
            readonly membershipId: string | null
            readonly createdByUserId: string
            readonly executorKind: "runner" | "orb"
            readonly inheritProjectGrants: boolean
            readonly threadRole: "viewer" | "controller" | "operator" | "owner" | null
            readonly projectRole: "viewer" | "controller" | "operator" | "owner" | null
          }>`SELECT thread.owner_id AS "ownerId", owner_record.kind, owner_record.user_id AS "userId",
            owner_record.organization_id AS "organizationId", membership.id AS "membershipId",
            thread.created_by_user_id AS "createdByUserId", thread.executor_kind AS "executorKind",
            thread.inherit_project_grants AS "inheritProjectGrants",
            thread_grant.role AS "threadRole", project_grant.role AS "projectRole"
          FROM rika_hosted_threads thread
          JOIN rika_hosted_owners owner_record ON owner_record.id = thread.owner_id
          LEFT JOIN "member" membership ON membership.organization_id = owner_record.organization_id
            AND membership.user_id = ${principal.userId}
          LEFT JOIN rika_hosted_thread_grants thread_grant ON thread_grant.owner_id = thread.owner_id
            AND thread_grant.thread_id = thread.id AND thread_grant.membership_id = membership.id
          LEFT JOIN rika_hosted_project_grants project_grant ON project_grant.owner_id = thread.owner_id
            AND project_grant.project_id = thread.project_id AND project_grant.membership_id = membership.id
          WHERE thread.id = ${threadId}`.pipe(Effect.mapError(unavailable))
          const resolved = threadRows[0]
          if (resolved === undefined)
            return yield* HostedProductError.make({ kind: "not-found", message: "Thread is unavailable" })
          const userId = BetterAuthUserId.make(principal.userId)
          if (resolved.kind === "personal" && resolved.userId !== principal.userId) return yield* forbidden()
          if (resolved.kind === "organization" && resolved.membershipId === null) return yield* forbidden()
          if (resolved.kind === "organization") {
            const membershipId = BetterAuthMemberId.make(resolved.membershipId!)
            yield* policy
              .authorize(action, {
                memberId: membershipId,
                ...(resolved.createdByUserId === principal.userId ? { threadCreatorMemberId: membershipId } : {}),
                executorKind: resolved.executorKind,
                inheritProjectGrants: resolved.inheritProjectGrants,
                ...(resolved.threadRole === null ? {} : { threadRole: resolved.threadRole }),
                ...(resolved.projectRole === null ? {} : { projectRole: resolved.projectRole }),
              })
              .pipe(Effect.mapError(() => forbidden()))
          }
          const owner =
            resolved.kind === "personal"
              ? ({ _tag: "PersonalOwner", userId } as const)
              : ({ _tag: "OrganizationOwner", organizationId: OrganizationId.make(resolved.organizationId!) } as const)
          const actor =
            owner._tag === "PersonalOwner"
              ? ({
                  _tag: "PersonalActor",
                  owner,
                  userId,
                  clientId: ClientId.make(principal.clientId),
                  deviceId: DeviceId.make(principal.deviceId),
                } as const)
              : ({
                  _tag: "OrganizationActor",
                  owner,
                  userId,
                  membershipId: BetterAuthMemberId.make(resolved.membershipId!),
                  clientId: ClientId.make(principal.clientId),
                  deviceId: DeviceId.make(principal.deviceId),
                } as const)
          const nowMillis = yield* Clock.currentTimeMillis
          yield* store.grantClientAuthority({
            ownerId: OwnerId.make(resolved.ownerId),
            actor,
            now: DateTime.formatIso(DateTime.makeUnsafe(nowMillis)),
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(nowMillis + 5 * 60 * 1000)),
          })
          yield* store.authorizeThread({
            ownerId: OwnerId.make(resolved.ownerId),
            threadId: ThreadId.make(threadId),
            actor,
            action,
            at: DateTime.formatIso(DateTime.makeUnsafe(nowMillis)),
          })
          return { ownerId: OwnerId.make(resolved.ownerId), actor }
        },
        Effect.mapError(storeFailure),
      )

      const threadExecutionContext: HostedProductService["threadExecutionContext"] = Effect.fn(
        "HostedProduct.threadExecutionContext",
      )(function* (ownerId, threadId) {
        const rows = yield* sql<{
          readonly assignmentId: string
          readonly executorKind: "runner" | "orb"
          readonly generation: string
          readonly lifecycle: string
          readonly executorInstanceId: string | null
          readonly providerInstanceId: string | null
          readonly checkout: unknown | null
          readonly localRepository: unknown | null
        }>`SELECT assignment.id AS "assignmentId", assignment.executor_kind AS "executorKind",
            assignment.generation::text AS generation, assignment.lifecycle,
            assignment.executor_instance_id AS "executorInstanceId",
            assignment.provider_instance_id AS "providerInstanceId", assignment.checkout,
            registration.repository AS "localRepository"
          FROM rika_hosted_executor_assignments assignment
          LEFT JOIN rika_hosted_runner_registrations registration
            ON assignment.executor_kind = 'runner'
            AND registration.device_id = assignment.placement ->> 'deviceId'
            AND registration.checkout_fingerprint = assignment.placement ->> 'checkoutFingerprint'
          WHERE assignment.owner_id = ${ownerId} AND assignment.thread_id = ${threadId}`.pipe(
          Effect.mapError(unavailable),
        )
        const row = rows[0]
        if (row === undefined)
          return yield* HostedProductError.make({ kind: "not-found", message: "Thread executor is unavailable" })
        const repositoryValue = row.checkout ?? row.localRepository
        const repository =
          repositoryValue === null
            ? null
            : yield* Schema.decodeUnknownEffect(JsonObject)(repositoryValue).pipe(Effect.mapError(unavailable))
        const branch =
          repository !== null && typeof repository.branch === "string" && repository.branch.length > 0
            ? repository.branch
            : null
        return {
          repository,
          branch,
          executor: {
            assignmentId: row.assignmentId,
            kind: row.executorKind,
            generation: row.generation,
            lifecycle: row.lifecycle,
            executorInstanceId: row.executorInstanceId,
            providerInstanceId: row.providerInstanceId,
          },
        }
      }, Effect.mapError(storeFailure))

      const activatePrincipal: HostedProductService["activatePrincipal"] = Effect.fn("HostedProduct.activatePrincipal")(
        function* (principal) {
          yield* activateClient(principal, BetterAuthUserId.make(principal.userId))
        },
        Effect.mapError(storeFailure),
      )

      const admitAuthorizedRun: HostedProductService["admitAuthorizedRun"] = Effect.fn(
        "HostedProduct.admitAuthorizedRun",
      )(function* (input) {
        const executionRoute = yield* modelRegistry
          .resolve(input.authority.ownerId, input.mode)
          .pipe(Effect.mapError(modelFailure))
        const commandId = CommandId.make(input.operationKey)
        const turnId = TurnId.make(yield* crypto.randomUUIDv4)
        const admittedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
        const readinessProof = yield* options.promptAdmissionReadiness
        const admitted = yield* store.admitPrompt({
          ownerId: input.authority.ownerId,
          threadId: ThreadId.make(input.threadId),
          commandId,
          idempotencyKey: IdempotencyKey.make(input.operationKey),
          turnId,
          actor: input.authority.actor,
          prompt: input.prompt,
          ...(input.promptParts === undefined ? {} : { promptParts: input.promptParts }),
          executionRoute,
          admittedAt,
          queueCapacity: 32,
          readinessProof,
        })
        if (admitted._tag === "Cancelled") return { _tag: "Cancelled" as const, commandId: input.operationKey }
        return {
          _tag: "Admitted" as const,
          commandId: String(admitted.command.commandId),
          turnId: String(admitted.turnId),
          status: admitted.status,
        }
      }, Effect.mapError(storeFailure))

      const admitRun: HostedProductService["admitRun"] = Effect.fn("HostedProduct.admitRun")(function* (input) {
        const authority = yield* authorizeThread(input.principal, input.threadId, "thread:operate")
        return yield* admitAuthorizedRun({ ...input, authority })
      })

      const cancelAuthorizedRunAdmission: HostedProductService["cancelAuthorizedRunAdmission"] = Effect.fn(
        "HostedProduct.cancelAuthorizedRunAdmission",
      )(function* (input) {
        const cancelledAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
        const cancellation = yield* store.cancelPrompt({
          ownerId: input.authority.ownerId,
          threadId: ThreadId.make(input.threadId),
          cancelCommandId: CommandId.make(input.cancelCommandId),
          targetCommandId: CommandId.make(input.targetCommandId),
          actor: input.authority.actor,
          cancelledAt,
        })
        return cancellation._tag === "Turn" ? { turnId: String(cancellation.turnId) } : {}
      }, Effect.mapError(storeFailure))

      const cancelRunAdmission: HostedProductService["cancelRunAdmission"] = Effect.fn(
        "HostedProduct.cancelRunAdmission",
      )(function* (input) {
        const authority = yield* authorizeThread(input.principal, input.threadId, "thread:operate")
        return yield* cancelAuthorizedRunAdmission({ ...input, authority })
      })

      return HostedProduct.of({
        ready: sql`SELECT 1 FROM rika_hosted_owners LIMIT 1`.pipe(Effect.asVoid, Effect.mapError(unavailable)),
        projects,
        createProject,
        createConnection,
        registerRunner,
        setRemoteThreadCreation,
        pollRunner,
        admitRun,
        admitAuthorizedRun,
        cancelRunAdmission,
        cancelAuthorizedRunAdmission,
        authorizeThread,
        threadExecutionContext,
        activatePrincipal,
      })
    }),
  )

export const postgresTest = (options: {
  readonly database: PgClient.PgPoolConfig
  readonly templateBuildId: string
  readonly providerScope: string
  readonly promptAdmissionReadiness?: Effect.Effect<boolean>
}) =>
  layer({
    orb: {
      templateBuildId: options.templateBuildId,
      providerScope: options.providerScope,
    },
    promptAdmissionReadiness: options.promptAdmissionReadiness ?? Effect.succeed(true),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        postgresLayer(options.database),
        AuthorizationPolicy.layer,
        hostedModelRegistryTestLayer,
        hostedRepositoriesUnavailableLayer,
      ),
    ),
  )
