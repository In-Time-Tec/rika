import * as PgClient from "@effect/sql-pg/PgClient"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { BetterAuthMemberId } from "@rika/product/hosted-model"
import { remoteCellOperationOutcome } from "@rika/execution/route"
import * as RemoteCells from "@rika/execution/remote-cells"
import { OperationResolution as TenetOperationResolution, Runtime } from "tenetkit/runtime"
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
  readonly resolution: TenetOperationResolution.OperationResolution | null
}
type PersistedOperationRow = Omit<OperationRow, "resolution"> & { readonly resolution: unknown }

interface CompletedOperationRow {
  readonly operationId: string
  readonly operationKey: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly threadId: string
  readonly turnId: string
  readonly runId: string
  readonly rootRunId: string
  readonly toolCallId: string
  readonly code: string
  readonly attempt: string
  readonly replayPolicy: "pure" | "provider-idempotent" | "never"
  readonly admittedAt: string | null
  readonly deadlineAt: string
  readonly response: unknown
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
  readonly reconcileCompleted: Effect.Effect<void, HostedRecoveryError>
}

export class HostedRecovery extends Context.Service<HostedRecovery, HostedRecoveryService>()(
  "@rika/api/hosted-recovery/HostedRecovery",
) {}

const unavailable = (message: string) => HostedRecoveryError.make({ kind: "unavailable", message })
const decodeOperationRow = (row: PersistedOperationRow): Effect.Effect<OperationRow, HostedRecoveryError> =>
  row.resolution === null
    ? Effect.succeed({ ...row, resolution: null })
    : Schema.decodeUnknownEffect(TenetOperationResolution.OperationResolution)(row.resolution).pipe(
        Effect.map((resolution): OperationRow => ({ ...row, resolution })),
        Effect.mapError(() => unavailable("TenetKit recovery resolution is invalid")),
      )

const project = (row: OperationRow): RecoveryOperation => {
  let state: RecoveryOperation["state"] = "needs-resolution"
  let resolution: RecoveryResolution | null = null
  if (row.resolution?._tag === "Retry") {
    state = "retrying"
    resolution = { _tag: "Retry" }
  } else if (row.resolution?._tag === "Succeeded") {
    state = "accepted"
    resolution = { _tag: "Accept", value: row.resolution.value }
  } else if (row.resolution?._tag === "Failed") {
    state = "aborted"
    const error = row.resolution.error
    resolution = {
      _tag: "Abort",
      reason:
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : "Operation was aborted",
    }
  }
  return {
    operationId: row.operationId,
    operationKey: row.operationKey,
    runId: row.runId,
    attempt: Number(row.attempt),
    replayPolicy: row.replayPolicy,
    started: row.started,
    state,
    actions: state === "needs-resolution" ? ["inspect", "retry", "accept", "abort"] : ["inspect"],
    resolution,
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
        readonly executorKind: "runner" | "orb"
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
      sql<PersistedOperationRow>`SELECT
          tenet.operation_id AS "operationId", operation.operation_key AS "operationKey",
          operation.run_id AS "runId", operation.attempt::text AS attempt,
          operation.replay_policy AS "replayPolicy", operation.started_at IS NOT NULL AS started,
          CASE WHEN tenet.resolution_json IS NULL THEN NULL ELSE tenet.resolution_json::jsonb END AS resolution
        FROM rika_hosted_executor_operations operation
        JOIN tenetkit_run_operations tenet ON tenet.run_id = operation.run_id
          AND tenet.operation_key = operation.operation_key AND tenet.attempt = operation.attempt
        WHERE operation.thread_id = ${threadId} AND operation.run_id = ${runId}
          AND (
            operation.state = 'unknown'
            OR (
              operation.state = 'dispatched'
              AND (tenet.status = 'unknown' OR tenet.resolution_json IS NOT NULL)
            )
          )
        ORDER BY operation.created_at, operation.attempt`.pipe(
        Effect.mapError(() => unavailable("Could not inspect recovery operations")),
        Effect.flatMap((rows) => Effect.forEach(rows, decodeOperationRow)),
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
      const resolvedRows = yield* operations(input.threadId, input.runId)
      const resolved = resolvedRows.find((candidate) => candidate.operationId === input.operationId)
      if (resolved === undefined) return yield* unavailable("Resolved recovery operation is unavailable")
      return project(resolved)
    })

    const reconcileCompleted = Effect.gen(function* () {
      const rows = yield* sql<CompletedOperationRow>`SELECT tenet.operation_id AS "operationId",
          operation.operation_key AS "operationKey", operation.workspace_id AS "workspaceId",
          operation.session_id AS "sessionId", operation.thread_id AS "threadId",
          operation.turn_id AS "turnId", operation.run_id AS "runId", operation.root_run_id AS "rootRunId",
          operation.tool_call_id AS "toolCallId", operation.code, operation.attempt::text AS attempt,
          operation.replay_policy AS "replayPolicy", operation.admitted_at AS "admittedAt",
          to_char(operation.deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deadlineAt",
          operation.response
        FROM rika_hosted_executor_operations operation
        JOIN tenetkit_run_operations tenet ON tenet.run_id = operation.run_id
          AND tenet.operation_key = operation.operation_key AND tenet.attempt = operation.attempt
        JOIN tenetkit_runs run ON run.run_id = operation.run_id
        WHERE operation.state = 'completed' AND operation.response IS NOT NULL
          AND tenet.status = 'unknown' AND run.status = 'needs-resolution'
        ORDER BY operation.updated_at, operation.operation_key
        LIMIT 32`.pipe(Effect.mapError(() => unavailable("Could not inspect completed recovery operations")))
      yield* Effect.forEach(
        rows,
        (row) =>
          remoteCellOperationOutcome(
            RemoteCells.Request.make({
              operationKey: row.operationKey,
              workspaceId: row.workspaceId,
              sessionId: row.sessionId,
              threadId: row.threadId,
              turnId: row.turnId,
              runId: row.runId,
              rootRunId: row.rootRunId,
              toolCallId: row.toolCallId,
              code: row.code,
              attempt: Number(row.attempt),
              replayPolicy: row.replayPolicy,
              admittedAt: row.admittedAt,
              deadlineAt: row.deadlineAt,
            }),
            row.response,
          ).pipe(
            Effect.mapError(() => unavailable("Persisted completed operation response is invalid")),
            Effect.flatMap((value) =>
              runtime.resolveOperation({
                runId: row.runId,
                operationId: row.operationId,
                idempotencyKey: `${row.operationId}:executor-terminal`,
                resolution: { _tag: "Succeeded", value },
              }),
            ),
            Effect.catchTag("tenetkit/runtime/OperationResolutionConflict", () => Effect.void),
            Effect.mapError(() => unavailable("TenetKit completed operation recovery is unavailable")),
          ),
        { concurrency: 8, discard: true },
      )
    })
    const poll = Effect.sleep("250 millis").pipe(
      Effect.andThen(reconcileCompleted),
      Effect.catch((error) =>
        Effect.logError("hosted-recovery.reconcile-failed").pipe(
          Effect.annotateLogs({ "rika.error.kind": error.kind, "rika.error.message": error.message }),
        ),
      ),
    )
    yield* Effect.forever(poll).pipe(Effect.forkScoped)
    return HostedRecovery.of({ inspect, resolve, reconcileCompleted })
  }),
)
