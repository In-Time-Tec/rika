import * as PgClient from "@effect/sql-pg/PgClient"
import { Clock, Context, Crypto, DateTime, Effect, Layer, Schema } from "effect"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import {
  BetterAuthMemberId,
  ClientId,
  DeviceId,
  OrganizationId,
  ProjectId,
  ThreadId,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedStore } from "@rika/product/hosted-store"
import { layer as postgresLayer } from "@rika/product-store/postgres-layer"

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
}

export class HostedProduct extends Context.Service<HostedProduct, HostedProductService>()(
  "@rika/control-plane/hosted-product/HostedProduct",
) {}

export const layer = Layer.effect(
  HostedProduct,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const store = yield* HostedStore
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
      const existing = yield* projects([input.authority.memberId])
      const selected =
        input.projectId === undefined
          ? existing.find((project) => project.organizationId === input.authority.organizationId)
          : existing.find(
              (project) => project.id === input.projectId && project.organizationId === input.authority.organizationId,
            )
      if (input.projectId !== undefined && selected === undefined)
        return yield* HostedProductError.make({ message: "Project is unavailable" })
      const timestamp = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
      const created =
        selected === undefined
          ? yield* store
              .createProject({
                id: ProjectId.make(yield* crypto.randomUUIDv4),
                organizationId: OrganizationId.make(input.authority.organizationId),
                name: "Rika",
                createdByMemberId: BetterAuthMemberId.make(input.authority.memberId),
                now: timestamp,
              })
              .pipe(Effect.mapError(unavailable))
          : undefined
      const projectId = selected?.id ?? created!.id
      const projectRole = selected?.role ?? "owner"
      yield* policy
        .authorize("project:update", { memberId: BetterAuthMemberId.make(input.authority.memberId), projectRole })
        .pipe(Effect.mapError(unavailable))
      const executorKind = input.placement === "e2b" ? "e2b" : "local_device"
      yield* store
        .registerDevice({
          id: DeviceId.make(input.authority.deviceId),
          organizationId: OrganizationId.make(input.authority.organizationId),
          memberId: BetterAuthMemberId.make(input.authority.memberId),
          displayName: "Rika CLI",
          publicKeyFingerprint: input.authority.dpopJkt ?? input.authority.clientId,
          now: timestamp,
        })
        .pipe(Effect.mapError(unavailable))
      yield* store
        .authenticateClient({
          id: ClientId.make(input.authority.clientId),
          organizationId: OrganizationId.make(input.authority.organizationId),
          memberId: BetterAuthMemberId.make(input.authority.memberId),
          deviceId: DeviceId.make(input.authority.deviceId),
          now: timestamp,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 60 * 60 * 1000)),
        })
        .pipe(Effect.mapError(unavailable))
      const workspaceId = WorkspaceId.make(yield* crypto.randomUUIDv4)
      yield* store
        .createWorkspace({
          id: workspaceId,
          organizationId: OrganizationId.make(input.authority.organizationId),
          projectId: ProjectId.make(projectId),
          createdByMemberId: BetterAuthMemberId.make(input.authority.memberId),
          executorKind,
          inheritProjectGrants: executorKind === "e2b",
          now: timestamp,
        })
        .pipe(Effect.mapError(unavailable))
      const thread = yield* store
        .createThread({
          id: ThreadId.make(yield* crypto.randomUUIDv4),
          organizationId: OrganizationId.make(input.authority.organizationId),
          projectId: ProjectId.make(projectId),
          workspaceId,
          createdByMemberId: BetterAuthMemberId.make(input.authority.memberId),
          executorKind,
          inheritProjectGrants: executorKind === "e2b",
          now: timestamp,
        })
        .pipe(Effect.mapError(unavailable))
      return { threadId: String(thread.id) }
    }, Effect.mapError(unavailable))

    return HostedProduct.of({
      ready: sql`SELECT 1 FROM rika_hosted_projects LIMIT 1`.pipe(Effect.asVoid, Effect.mapError(unavailable)),
      projects,
      createConnection,
    })
  }),
)

export const postgres = (config: PgClient.PgPoolConfig) =>
  layer.pipe(Layer.provide(Layer.merge(postgresLayer(config), AuthorizationPolicy.layer)))
