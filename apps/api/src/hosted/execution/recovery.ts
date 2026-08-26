import * as PgClient from "@effect/sql-pg/PgClient"
import { identityMember } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { BetterAuthMemberId } from "@rika/product/hosted-model"
import {
  rikaHostedExecutorOperations,
  rikaHostedOwners,
  rikaHostedProjectGrants,
  rikaHostedThreadGrants,
  rikaHostedThreads,
} from "@rika/product-store/database-schema"
import { remoteCellOperationOutcome } from "@rika/execution/route"
import * as RemoteCells from "@rika/execution/remote-cells"
import { and, asc, eq, isNotNull, or } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { OperationResolution as TenetOperationResolution, Runtime } from "tenetkit/runtime"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { AuthenticatedPrincipal } from "../product"
import { runOperations, runs } from "./tenetkit-schema"

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
  readonly attempt: number
  readonly replayPolicy: "pure" | "provider-idempotent" | "never"
  readonly started: boolean
  readonly resolution: TenetOperationResolution.OperationResolution | null
}

interface PersistedOperationRow {
  readonly operationId: string
  readonly operationKey: string
  readonly runId: string
  readonly attempt: number
  readonly replayPolicy: "pure" | "provider-idempotent" | "never"
  readonly startedAt: Date | null
  readonly resolutionJson: string | null
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
  "@rika/api/hosted/execution/recovery/HostedRecovery",
) {}

const unavailable = (message: string) => HostedRecoveryError.make({ kind: "unavailable", message })
const decodeOperationRow = (row: PersistedOperationRow): Effect.Effect<OperationRow, HostedRecoveryError> =>
  row.resolutionJson === null
    ? Effect.succeed({ ...row, started: row.startedAt !== null, resolution: null })
    : Schema.decodeEffect(Schema.fromJsonString(TenetOperationResolution.OperationResolution))(row.resolutionJson).pipe(
        Effect.map(
          (resolution): OperationRow => ({
            operationId: row.operationId,
            operationKey: row.operationKey,
            runId: row.runId,
            attempt: row.attempt,
            replayPolicy: row.replayPolicy,
            started: row.startedAt !== null,
            resolution,
          }),
        ),
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
    const decoded = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(row.resolution.error)
    resolution = {
      _tag: "Abort",
      reason: Option.match(decoded, { onNone: () => "Operation was aborted", onSome: (error) => error.message }),
    }
  }
  return {
    operationId: row.operationId,
    operationKey: row.operationKey,
    runId: row.runId,
    attempt: row.attempt,
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
    yield* PgClient.PgClient
    const db = yield* PgDrizzle.makeWithDefaults()
    const policy = yield* AuthorizationPolicy
    const runtime = yield* Runtime.Runtime

    const authorize = Effect.fn("HostedRecovery.authorize")(function* (
      principal: AuthenticatedPrincipal,
      threadId: string,
    ) {
      const rows = yield* db
        .select({
          kind: rikaHostedOwners.kind,
          userId: rikaHostedOwners.userId,
          membershipId: identityMember.id,
          createdByUserId: rikaHostedThreads.createdByUserId,
          executorKind: rikaHostedThreads.executorKind,
          inheritProjectGrants: rikaHostedThreads.inheritProjectGrants,
          threadRole: rikaHostedThreadGrants.role,
          projectRole: rikaHostedProjectGrants.role,
        })
        .from(rikaHostedThreads)
        .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedThreads.ownerId))
        .leftJoin(
          identityMember,
          and(
            eq(identityMember.organizationId, rikaHostedOwners.organizationId),
            eq(identityMember.userId, principal.userId),
          ),
        )
        .leftJoin(
          rikaHostedThreadGrants,
          and(
            eq(rikaHostedThreadGrants.ownerId, rikaHostedThreads.ownerId),
            eq(rikaHostedThreadGrants.threadId, rikaHostedThreads.id),
            eq(rikaHostedThreadGrants.membershipId, identityMember.id),
          ),
        )
        .leftJoin(
          rikaHostedProjectGrants,
          and(
            eq(rikaHostedProjectGrants.ownerId, rikaHostedThreads.ownerId),
            eq(rikaHostedProjectGrants.projectId, rikaHostedThreads.projectId),
            eq(rikaHostedProjectGrants.membershipId, identityMember.id),
          ),
        )
        .where(eq(rikaHostedThreads.id, threadId))
        .pipe(Effect.mapError(() => unavailable("Recovery authorization is unavailable")))
      const row = rows[0]
      if (row === undefined)
        return yield* HostedRecoveryError.make({ kind: "not-found", message: "Thread is unavailable" })
      if (row.kind === "personal" && row.userId !== principal.userId)
        return yield* HostedRecoveryError.make({ kind: "forbidden", message: "Recovery operation was rejected" })
      if (row.kind === "organization" && row.membershipId === null)
        return yield* HostedRecoveryError.make({ kind: "forbidden", message: "Recovery operation was rejected" })
      if (row.kind === "organization") {
        const baseAuthorization = {
          memberId: BetterAuthMemberId.make(row.membershipId!),
          executorKind: row.executorKind,
          inheritProjectGrants: row.inheritProjectGrants,
        }
        const creatorAuthorization =
          row.createdByUserId === principal.userId
            ? { ...baseAuthorization, threadCreatorMemberId: BetterAuthMemberId.make(row.membershipId!) }
            : baseAuthorization
        const threadAuthorization =
          row.threadRole === null ? creatorAuthorization : { ...creatorAuthorization, threadRole: row.threadRole }
        const authorization: Parameters<typeof policy.authorize>[1] =
          row.projectRole === null ? threadAuthorization : { ...threadAuthorization, projectRole: row.projectRole }
        yield* policy
          .authorize("thread:operate", authorization)
          .pipe(
            Effect.mapError(() =>
              HostedRecoveryError.make({ kind: "forbidden", message: "Recovery operation was rejected" }),
            ),
          )
      }
    })

    const operations = (threadId: string, runId: string) =>
      db
        .select({
          operationId: runOperations.operationId,
          operationKey: rikaHostedExecutorOperations.operationKey,
          runId: rikaHostedExecutorOperations.runId,
          attempt: rikaHostedExecutorOperations.attempt,
          replayPolicy: rikaHostedExecutorOperations.replayPolicy,
          startedAt: rikaHostedExecutorOperations.startedAt,
          resolutionJson: runOperations.resolutionJson,
        })
        .from(rikaHostedExecutorOperations)
        .innerJoin(
          runOperations,
          and(
            eq(runOperations.runId, rikaHostedExecutorOperations.runId),
            eq(runOperations.operationKey, rikaHostedExecutorOperations.operationKey),
            eq(runOperations.attempt, rikaHostedExecutorOperations.attempt),
          ),
        )
        .where(
          and(
            eq(rikaHostedExecutorOperations.threadId, threadId),
            eq(rikaHostedExecutorOperations.runId, runId),
            or(
              eq(rikaHostedExecutorOperations.state, "unknown"),
              and(
                eq(rikaHostedExecutorOperations.state, "dispatched"),
                or(eq(runOperations.status, "unknown"), isNotNull(runOperations.resolutionJson)),
              ),
            ),
          ),
        )
        .orderBy(asc(rikaHostedExecutorOperations.createdAt), asc(rikaHostedExecutorOperations.attempt))
        .pipe(
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
      const rows = yield* db
        .select({
          operationId: runOperations.operationId,
          operationKey: rikaHostedExecutorOperations.operationKey,
          workspaceId: rikaHostedExecutorOperations.workspaceId,
          sessionId: rikaHostedExecutorOperations.sessionId,
          threadId: rikaHostedExecutorOperations.threadId,
          turnId: rikaHostedExecutorOperations.turnId,
          runId: rikaHostedExecutorOperations.runId,
          rootRunId: rikaHostedExecutorOperations.rootRunId,
          toolCallId: rikaHostedExecutorOperations.toolCallId,
          code: rikaHostedExecutorOperations.code,
          attempt: rikaHostedExecutorOperations.attempt,
          replayPolicy: rikaHostedExecutorOperations.replayPolicy,
          admittedAt: rikaHostedExecutorOperations.admittedAt,
          deadlineAt: rikaHostedExecutorOperations.deadlineAt,
          response: rikaHostedExecutorOperations.response,
        })
        .from(rikaHostedExecutorOperations)
        .innerJoin(
          runOperations,
          and(
            eq(runOperations.runId, rikaHostedExecutorOperations.runId),
            eq(runOperations.operationKey, rikaHostedExecutorOperations.operationKey),
            eq(runOperations.attempt, rikaHostedExecutorOperations.attempt),
          ),
        )
        .innerJoin(runs, eq(runs.runId, rikaHostedExecutorOperations.runId))
        .where(
          and(
            eq(rikaHostedExecutorOperations.state, "completed"),
            isNotNull(rikaHostedExecutorOperations.response),
            eq(runOperations.status, "unknown"),
            eq(runs.status, "needs-resolution"),
          ),
        )
        .orderBy(asc(rikaHostedExecutorOperations.updatedAt), asc(rikaHostedExecutorOperations.operationKey))
        .limit(32)
        .pipe(Effect.mapError(() => unavailable("Could not inspect completed recovery operations")))
      yield* Effect.forEach(
        rows,
        (row) =>
          Schema.decodeUnknownEffect(Schema.toEncoded(RemoteCells.Response))(row.response).pipe(
            Effect.mapError(() => unavailable("Persisted completed operation response is invalid")),
            Effect.flatMap((response) =>
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
                  attempt: row.attempt,
                  replayPolicy: row.replayPolicy,
                  admittedAt: row.admittedAt,
                  deadlineAt: row.deadlineAt.toISOString(),
                }),
                response,
              ),
            ),
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
