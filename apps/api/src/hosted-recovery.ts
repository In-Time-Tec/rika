import * as PgClient from "@effect/sql-pg/PgClient"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { BetterAuthMemberId } from "@rika/product/hosted-model"
import { Runtime } from "tenetkit/runtime"
import { Context, Effect, Layer, Schema } from "effect"
import type { AuthenticatedPrincipal } from "./hosted-product"

export const RecoveryResolution = Schema.Union([
  Schema.TaggedStruct("Retry", {}),
  Schema.TaggedStruct("Accept", { value: Schema.Unknown }),
  Schema.TaggedStruct("Abort", { reason: Schema.NonEmptyString }),
])
export type RecoveryResolution = typeof RecoveryResolution.Type

export const RecoveryOperation = Schema.Struct({
  operationId: Schema.NonEmptyString,
  operationKey: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  replayPolicy: Schema.Literals(["pure", "provider-idempotent", "never"]),
  started: Schema.Boolean,
  state: Schema.Literals(["needs-resolution", "retrying", "accepted", "aborted"]),
  actions: Schema.Array(Schema.Literals(["inspect", "retry", "accept", "abort"])),
  resolution: Schema.NullOr(Schema.Unknown),
})
export type RecoveryOperation = typeof RecoveryOperation.Type

export class HostedRecoveryError extends Schema.TaggedError<HostedRecoveryError>()("HostedRecoveryError", {
  kind: Schema.Literals(["not-found", "forbidden", "conflict", "invalid", "unavailable"]),
  message: Schema.String,
}) {}

interface OperationRow {
  readonly operationId: string
  readonly operationKey: string
  readonly runId: string
  readonly attempt: string
  readonly replayPolicy: "pure" | "provider-idempotent" | "never"
  readonly started: boolean
  readonly resolutionState: "pending" | "retrying" | "accepted" | "aborted"
  readonly resolutionIdempotencyKey: string | null
  readonly resolution: unknown
}

export interface HostedRecoveryService {
  readonly inspect: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly threadId: string
    readonly runId: string
  }) => Effect.Effect<ReadonlyArray<RecoveryOperation>, HostedRecoveryError>
  readonly resolve: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly threadId: string
    readonly runId: string
    readonly operationId: string
    readonly idempotencyKey: string
    readonly resolution: RecoveryResolution
  }) => Effect.Effect<RecoveryOperation, HostedRecoveryError>
}

export class HostedRecovery extends Context.Service<HostedRecovery, HostedRecoveryService>()(
  "@rika/api/hosted-recovery/HostedRecovery",
) {}

const unavailable = (message: string) => HostedRecoveryError.make({ kind: "unavailable", message })
const equivalentResolution = Schema.toEquivalence(RecoveryResolution)
const decodeResolution = Schema.decodeUnknownEffect(RecoveryResolution)

const project = (row: OperationRow): RecoveryOperation => {
  const state = row.resolutionState === "pending" ? "needs-resolution" : row.resolutionState
  return {
    operationId: row.operationId,
    operationKey: row.operationKey,
    runId: row.runId,
    attempt: Number(row.attempt),
    replayPolicy: row.replayPolicy,
    started: row.started,
    state,
    actions: state === "needs-resolution" ? ["inspect", "retry", "accept", "abort"] : ["inspect"],
    resolution: row.resolution,
  }
}

export const layer = Layer.effect(
  HostedRecovery,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const policy = yield* AuthorizationPolicy
    const runtime = yield* Runtime.Runtime

    const authorize = Effect.fn("HostedRecovery.authorize")(function* (
      principal: AuthenticatedPrincipal,
      threadId: string,
    ) {
      const rows = yield* sql<{
        readonly kind: "personal" | "organization"
        readonly userId: string | null
        readonly membershipId: string | null
        readonly createdByUserId: string
        readonly executorKind: "local_device" | "e2b"
        readonly inheritProjectGrants: boolean
        readonly threadRole: "viewer" | "controller" | "operator" | "owner" | null
        readonly projectRole: "viewer" | "controller" | "operator" | "owner" | null
      }>`SELECT owner_record.kind, owner_record.user_id AS "userId", membership.id AS "membershipId",
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
        WHERE thread.id = ${threadId}`.pipe(Effect.mapError(() => unavailable("Recovery authorization is unavailable")))
      const row = rows[0]
      if (row === undefined)
        return yield* HostedRecoveryError.make({ kind: "not-found", message: "Thread is unavailable" })
      if (row.kind === "personal" && row.userId !== principal.userId)
        return yield* HostedRecoveryError.make({ kind: "forbidden", message: "Recovery operation was rejected" })
      if (row.kind === "organization" && row.membershipId === null)
        return yield* HostedRecoveryError.make({ kind: "forbidden", message: "Recovery operation was rejected" })
      if (row.kind === "organization")
        yield* policy
          .authorize("thread:operate", {
            memberId: BetterAuthMemberId.make(row.membershipId!),
            ...(row.createdByUserId === principal.userId
              ? { threadCreatorMemberId: BetterAuthMemberId.make(row.membershipId!) }
              : {}),
            executorKind: row.executorKind,
            inheritProjectGrants: row.inheritProjectGrants,
            ...(row.threadRole === null ? {} : { threadRole: row.threadRole }),
            ...(row.projectRole === null ? {} : { projectRole: row.projectRole }),
          })
          .pipe(
            Effect.mapError(() =>
              HostedRecoveryError.make({ kind: "forbidden", message: "Recovery operation was rejected" }),
            ),
          )
    })

    const operations = (threadId: string, runId: string) =>
      sql<OperationRow>`SELECT tenet.operation_id AS "operationId", operation.operation_key AS "operationKey",
          operation.run_id AS "runId", operation.attempt::text AS attempt,
          operation.replay_policy AS "replayPolicy", operation.started_at IS NOT NULL AS started,
          operation.resolution_state AS "resolutionState",
          operation.resolution_idempotency_key AS "resolutionIdempotencyKey", operation.resolution
        FROM rika_hosted_executor_operations operation
        JOIN tenetkit_run_operations tenet ON tenet.run_id = operation.run_id
          AND tenet.operation_key = operation.operation_key AND tenet.attempt = operation.attempt
        WHERE operation.thread_id = ${threadId} AND operation.run_id = ${runId}
          AND operation.state = 'unknown' AND operation.resolution_state IS NOT NULL
        ORDER BY operation.created_at, operation.attempt`.pipe(
        Effect.mapError(() => unavailable("Could not inspect recovery operations")),
      )

    const inspect: HostedRecoveryService["inspect"] = Effect.fn("HostedRecovery.inspect")(function* (input) {
      yield* authorize(input.principal, input.threadId)
      return (yield* operations(input.threadId, input.runId)).map(project)
    })

    const resolve: HostedRecoveryService["resolve"] = Effect.fn("HostedRecovery.resolve")(function* (input) {
      yield* authorize(input.principal, input.threadId)
      const rows = yield* operations(input.threadId, input.runId)
      const row = rows.find((candidate) => candidate.operationId === input.operationId)
      if (row === undefined)
        return yield* HostedRecoveryError.make({ kind: "not-found", message: "Recovery operation is unavailable" })
      if (row.resolutionState !== "pending") {
        const previous = yield* decodeResolution(row.resolution).pipe(
          Effect.mapError(() => unavailable("Persisted recovery resolution is invalid")),
        )
        if (row.resolutionIdempotencyKey === input.idempotencyKey && equivalentResolution(previous, input.resolution))
          return project(row)
        return yield* HostedRecoveryError.make({ kind: "conflict", message: "Recovery resolution conflicts" })
      }
      const resolution = (() => {
        if (input.resolution._tag === "Retry") return { _tag: "Retry" } as const
        if (input.resolution._tag === "Accept") return { _tag: "Succeeded", value: input.resolution.value } as const
        return {
          _tag: "Failed",
          error: { _tag: "UserAbortedUnknownOperation", message: input.resolution.reason },
        } as const
      })()
      yield* runtime
        .resolveOperation({
          runId: input.runId,
          operationId: input.operationId,
          idempotencyKey: input.idempotencyKey,
          resolution,
        })
        .pipe(
          Effect.mapError((error) => {
            if (error._tag === "tenetkit/runtime/OperationResolutionConflict")
              return HostedRecoveryError.make({ kind: "conflict", message: "Recovery resolution conflicts" })
            if (error._tag === "tenetkit/runtime/RunNotFound")
              return HostedRecoveryError.make({ kind: "not-found", message: "Run is unavailable" })
            return unavailable("TenetKit recovery is unavailable")
          }),
        )
      let state: "retrying" | "accepted" | "aborted"
      if (input.resolution._tag === "Retry") state = "retrying"
      else if (input.resolution._tag === "Accept") state = "accepted"
      else state = "aborted"
      const updated = yield* sql`UPDATE rika_hosted_executor_operations SET
          resolution_state = ${state}, resolution_idempotency_key = ${input.idempotencyKey},
          resolution = ${sql.json(input.resolution)}, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE run_id = ${input.runId} AND operation_key = ${row.operationKey}
          AND attempt = ${row.attempt}::bigint AND state = 'unknown' AND resolution_state = 'pending'
        RETURNING operation_key`.pipe(Effect.mapError(() => unavailable("Could not persist recovery resolution")))
      if (updated[0] === undefined)
        return yield* HostedRecoveryError.make({ kind: "conflict", message: "Recovery resolution changed" })
      const resolvedRows = yield* operations(input.threadId, input.runId)
      const resolved = resolvedRows.find((candidate) => candidate.operationId === input.operationId)
      if (resolved === undefined) return yield* unavailable("Resolved recovery operation is unavailable")
      return project(resolved)
    })

    return HostedRecovery.of({ inspect, resolve })
  }),
)
