import * as PgClient from "@effect/sql-pg/PgClient"
import { Clock, Context, Crypto, DateTime, Effect, Layer, Schema } from "effect"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import {
  AssignmentLeaseEpoch,
  BetterAuthMemberId,
  ClientId,
  CommandId,
  DeviceId,
  EventId,
  ExecutorAssignmentId,
  FencingGeneration,
  IdempotencyKey,
  OrganizationId,
  ProjectId,
  type Sequence,
  ThreadId,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedStore } from "@rika/product/hosted-store"
import { layer as postgresLayer } from "@rika/product-store/postgres-layer"
import type { AccessWire, CellResponse } from "@rika/remote-execution/protocol"

export interface ProjectContext {
  readonly id: string
  readonly organizationId: string
  readonly name: string
  readonly role: "viewer" | "controller" | "operator" | "owner"
}

export interface ConnectionAuthority {
  readonly organizationId: string
  readonly memberId: string
  readonly deviceId: string
  readonly clientId: string
  readonly dpopJkt?: string
}

export interface AdmittedRun {
  readonly operationKey: string
  readonly commandSequence: Sequence
  readonly prompt: string
}

export class HostedProductError extends Schema.TaggedError<HostedProductError>()("HostedProductError", {
  message: Schema.String,
}) {}

const unavailable = () => HostedProductError.make({ message: "Hosted product service is unavailable" })

export interface HostedProductService {
  readonly ready: Effect.Effect<void, HostedProductError>
  readonly projects: (
    memberIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ProjectContext>, HostedProductError>
  readonly createConnection: (input: {
    readonly authority: ConnectionAuthority
    readonly projectId?: string
    readonly placement: "local" | "e2b"
  }) => Effect.Effect<{ readonly threadId: string }, HostedProductError>
  readonly admitRun: (input: {
    readonly authority: ConnectionAuthority
    readonly threadId: string
    readonly operationKey: string
    readonly prompt: string
  }) => Effect.Effect<AdmittedRun, HostedProductError>
  readonly completeRun: (input: {
    readonly run: AdmittedRun
    readonly access: AccessWire
    readonly response: CellResponse
  }) => Effect.Effect<void, HostedProductError>
}

export class HostedProduct extends Context.Service<HostedProduct, HostedProductService>()(
  "@rika/control-plane/hosted-product/HostedProduct",
) {}

export const layer = (options: { readonly templateBuildId: string; readonly providerScope: string }) =>
  Layer.effect(
    HostedProduct,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const store = yield* HostedStore
      const assignments = yield* ExecutorAssignments
      const policy = yield* AuthorizationPolicy
      const crypto = yield* Crypto.Crypto

      const projects = Effect.fn("HostedProduct.projects")(function* (memberIds: ReadonlyArray<string>) {
        if (memberIds.length === 0) return []
        const rows = yield* sql<{
          readonly id: string
          readonly organizationId: string
          readonly name: string
          readonly role: ProjectContext["role"]
        }>`SELECT project.id, project.organization_id AS "organizationId", project.name, grant_record.role
          FROM rika_hosted_projects project
          JOIN rika_hosted_project_grants grant_record
            ON grant_record.organization_id = project.organization_id AND grant_record.project_id = project.id
          WHERE grant_record.member_id IN ${sql.in(memberIds)}
          ORDER BY project.created_at, project.id`.pipe(Effect.mapError(unavailable))
        return rows
      })

      const createConnection = Effect.fn("HostedProduct.createConnection")(function* (input: {
        readonly authority: ConnectionAuthority
        readonly projectId?: string
        readonly placement: "local" | "e2b"
      }) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* projects([input.authority.memberId])
            const selected =
              input.projectId === undefined
                ? existing.find((project) => project.organizationId === input.authority.organizationId)
                : existing.find(
                    (project) =>
                      project.id === input.projectId && project.organizationId === input.authority.organizationId,
                  )
            if (input.projectId !== undefined && selected === undefined)
              return yield* HostedProductError.make({ message: "Project is unavailable" })
            const currentTime = yield* Clock.currentTimeMillis
            const timestamp = DateTime.formatIso(DateTime.makeUnsafe(currentTime))
            const organizationId = OrganizationId.make(input.authority.organizationId)
            const memberId = BetterAuthMemberId.make(input.authority.memberId)
            const deviceId = DeviceId.make(input.authority.deviceId)
            const created =
              selected === undefined
                ? yield* store.createProject({
                    id: ProjectId.make(yield* crypto.randomUUIDv4),
                    organizationId,
                    name: "Rika",
                    createdByMemberId: memberId,
                    now: timestamp,
                  })
                : undefined
            const projectId = selected?.id ?? created!.id
            const projectRole = selected?.role ?? "owner"
            yield* policy.authorize("project:update", { memberId, projectRole })
            const executorKind = input.placement === "e2b" ? "e2b" : "local_device"
            yield* store.registerDevice({
              id: deviceId,
              organizationId,
              memberId,
              displayName: "Rika CLI",
              publicKeyFingerprint: input.authority.dpopJkt ?? input.authority.clientId,
              now: timestamp,
            })
            yield* store.authenticateClient({
              id: ClientId.make(input.authority.clientId),
              organizationId,
              memberId,
              deviceId,
              now: timestamp,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(currentTime + 60 * 60 * 1000)),
            })
            const workspaceId = WorkspaceId.make(yield* crypto.randomUUIDv4)
            yield* store.createWorkspace({
              id: workspaceId,
              organizationId,
              projectId: ProjectId.make(projectId),
              createdByMemberId: memberId,
              executorKind,
              inheritProjectGrants: executorKind === "e2b",
              now: timestamp,
            })
            const threadId = ThreadId.make(`${executorKind === "e2b" ? "e2b" : "local"}_${yield* crypto.randomUUIDv4}`)
            const thread = yield* store.createThread({
              id: threadId,
              organizationId,
              projectId: ProjectId.make(projectId),
              workspaceId,
              createdByMemberId: memberId,
              executorKind,
              inheritProjectGrants: executorKind === "e2b",
              now: timestamp,
            })
            yield* assignments.create({
              id: ExecutorAssignmentId.make(thread.id),
              organizationId,
              threadId: thread.id,
              placement:
                executorKind === "e2b"
                  ? {
                      _tag: "E2BPlacement",
                      templateBuildId: options.templateBuildId,
                      providerScope: options.providerScope,
                    }
                  : { _tag: "LocalDevicePlacement", deviceId },
              checkout: null,
            })
            return { threadId: String(thread.id) }
          }),
        )
      }, Effect.mapError(unavailable))

      const admitRun: HostedProductService["admitRun"] = Effect.fn("HostedProduct.admitRun")(function* (input) {
        const organizationId = OrganizationId.make(input.authority.organizationId)
        const memberId = BetterAuthMemberId.make(input.authority.memberId)
        const clientId = ClientId.make(input.authority.clientId)
        const command = yield* store.admitCommand({
          organizationId,
          threadId: ThreadId.make(input.threadId),
          memberId,
          clientId,
          commandId: CommandId.make(input.operationKey),
          idempotencyKey: IdempotencyKey.make(input.operationKey),
          actor: {
            _tag: "AuthenticatedMember",
            organizationId,
            memberId,
            clientId,
            deviceId: DeviceId.make(input.authority.deviceId),
          },
          command: { _tag: "SubmitPrompt", prompt: input.prompt },
          admittedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
        })
        return {
          operationKey: String(command.idempotencyKey),
          commandSequence: command.sequence,
          prompt: input.prompt,
        }
      }, Effect.mapError(unavailable))

      const completeRun: HostedProductService["completeRun"] = Effect.fn("HostedProduct.completeRun")(function* (
        input,
      ) {
        yield* store.appendEvent({
          eventId: EventId.make(input.run.operationKey),
          idempotencyKey: IdempotencyKey.make(input.run.operationKey),
          assignmentId: ExecutorAssignmentId.make(input.access.fence.assignmentId),
          assignmentGeneration: FencingGeneration.make(String(input.access.fence.assignmentGeneration)),
          leaseEpoch: AssignmentLeaseEpoch.make(String(input.access.leaseEpoch)),
          commandSequence: input.run.commandSequence,
          event: {
            _tag: "CellResult",
            operationKey: input.run.operationKey,
            response: input.response,
          },
        })
      }, Effect.mapError(unavailable))

      return HostedProduct.of({
        ready: sql`SELECT 1 FROM rika_hosted_projects LIMIT 1`.pipe(Effect.asVoid, Effect.mapError(unavailable)),
        projects,
        createConnection,
        admitRun,
        completeRun,
      })
    }),
  )

export const postgres = (options: {
  readonly database: PgClient.PgPoolConfig
  readonly templateBuildId: string
  readonly providerScope: string
}) => layer(options).pipe(Layer.provide(Layer.merge(postgresLayer(options.database), AuthorizationPolicy.layer)))
