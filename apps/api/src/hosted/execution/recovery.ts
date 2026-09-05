import * as PgClient from "@effect/sql-pg/PgClient"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { identityMember } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { BetterAuthMemberId } from "@rika/product/hosted-model"
import {
  rikaHostedOwners,
  rikaHostedProjectGrants,
  rikaHostedThreadGrants,
  rikaHostedThreads,
  rikaTurns,
} from "@rika/product-store/database-schema"
import { and, eq, inArray, isNotNull } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { OperationResolution as GeneralistOperationResolution, Runtime } from "generalist/runtime"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { AuthenticatedPrincipal } from "../product"

export const RecoveryResolution = Schema.Union([
  Schema.TaggedStruct("Retry", {}),
  Schema.TaggedStruct("Accept", { value: Schema.Unknown }),
  Schema.TaggedStruct("Abort", { reason: Schema.NonEmptyString }),
])
export type RecoveryResolution = typeof RecoveryResolution.Type

export const RecoveryInspection = Schema.Struct({
  runId: Schema.NonEmptyString,
  status: Schema.Literals([
    "queued",
    "running",
    "waiting",
    "needs-resolution",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  operationDetails: Schema.optional(Schema.TaggedStruct("Unavailable", { reason: Schema.String })),
})
export type RecoveryInspection = typeof RecoveryInspection.Type

export const RecoveryResolutionReceipt = Schema.Struct({
  runId: Schema.NonEmptyString,
  operationId: Schema.NonEmptyString,
  idempotencyKey: Schema.NonEmptyString,
})
export type RecoveryResolutionReceipt = typeof RecoveryResolutionReceipt.Type

export class HostedRecoveryError extends Schema.TaggedError<HostedRecoveryError>()("HostedRecoveryError", {
  kind: Schema.Literals(["not-found", "forbidden", "conflict", "invalid", "unavailable"]),
  message: Schema.String,
}) {}

export interface HostedRecoveryService {
  readonly inspect: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly threadId: string
    readonly runId: string
  }) => Effect.Effect<RecoveryInspection, HostedRecoveryError>
  readonly resolve: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly threadId: string
    readonly runId: string
    readonly operationId: string
    readonly idempotencyKey: string
    readonly resolution: RecoveryResolution
  }) => Effect.Effect<RecoveryResolutionReceipt, HostedRecoveryError>
}

export class HostedRecovery extends Context.Service<HostedRecovery, HostedRecoveryService>()(
  "@rika/api/hosted/execution/recovery/HostedRecovery",
) {}

const unavailable = (message: string) => HostedRecoveryError.make({ kind: "unavailable", message })

type RecoveryRuntime = Pick<Runtime.Service, "inspect" | "resolveOperation">
type AuthorizeRun = (
  principal: AuthenticatedPrincipal,
  threadId: string,
  runId: string,
) => Effect.Effect<void, HostedRecoveryError>

const resolutionFor = (resolution: RecoveryResolution): GeneralistOperationResolution.OperationResolution => {
  if (resolution._tag === "Retry") return { _tag: "Retry" }
  if (resolution._tag === "Accept") return { _tag: "Succeeded", value: resolution.value }
  return {
    _tag: "Failed",
    error: { _tag: "UserAbortedUnknownOperation", message: resolution.reason },
  }
}

export const makeService = (dependencies: {
  readonly runtime: RecoveryRuntime
  readonly authorizeRun: AuthorizeRun
}): HostedRecoveryService => {
  const { authorizeRun, runtime } = dependencies
  const inspect: HostedRecoveryService["inspect"] = Effect.fn("HostedRecovery.inspect")(function* (input) {
    yield* authorizeRun(input.principal, input.threadId, input.runId)
    const run = yield* runtime
      .inspect(input.runId)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "generalist/runtime/RunNotFound"
            ? HostedRecoveryError.make({ kind: "not-found", message: "Run is unavailable" })
            : unavailable("Generalist recovery inspection is unavailable"),
        ),
      )
    if (run.status !== "needs-resolution") return { runId: run.runId, status: run.status }
    // TODO(generalist): expose exact unresolved operation inspections, including replay policy and accepted value schema.
    return {
      runId: run.runId,
      status: run.status,
      operationDetails: {
        _tag: "Unavailable" as const,
        reason: "Generalist does not expose unresolved operation details, replay policy, or result schema",
      },
    }
  })

  const resolve: HostedRecoveryService["resolve"] = Effect.fn("HostedRecovery.resolve")(function* (input) {
    yield* authorizeRun(input.principal, input.threadId, input.runId)
    yield* runtime
      .resolveOperation({
        runId: input.runId,
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey,
        resolution: resolutionFor(input.resolution),
      })
      .pipe(
        Effect.mapError((error) => {
          if (error._tag === "generalist/runtime/OperationResolutionConflict")
            return HostedRecoveryError.make({ kind: "conflict", message: "Recovery resolution conflicts" })
          if (error._tag === "generalist/runtime/RunNotFound")
            return HostedRecoveryError.make({ kind: "not-found", message: "Run is unavailable" })
          return unavailable("Generalist recovery is unavailable")
        }),
      )
    return { runId: input.runId, operationId: input.operationId, idempotencyKey: input.idempotencyKey }
  })

  return HostedRecovery.of({ inspect, resolve })
}

export const layer = Layer.effect(
  HostedRecovery,
  Effect.gen(function* () {
    yield* PgClient.PgClient
    const db = yield* PgDrizzle.makeWithDefaults()
    const policy = yield* AuthorizationPolicy
    const runtime = yield* Runtime.Runtime

    const authorizeThread = Effect.fn("HostedRecovery.authorizeThread")(function* (
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

    const authorizeRun: AuthorizeRun = Effect.fn("HostedRecovery.authorizeRun")(function* (principal, threadId, runId) {
      yield* authorizeThread(principal, threadId)
      const rows = yield* db
        .select({ executionLinkJson: rikaTurns.executionLinkJson })
        .from(rikaTurns)
        .where(
          and(
            eq(rikaTurns.threadId, threadId),
            inArray(rikaTurns.status, ["running", "waiting", "cancelling"]),
            isNotNull(rikaTurns.executionLinkJson),
          ),
        )
        .pipe(Effect.mapError(() => unavailable("Recovery Run authorization is unavailable")))
      for (const row of rows) {
        const link = Option.getOrUndefined(
          Schema.decodeUnknownOption(Schema.fromJsonString(ExecutionGateway.ExecutionLink))(row.executionLinkJson),
        )
        if (link === undefined) return yield* unavailable("Recovery execution link is invalid")
        if (link.runId === runId || link.titleRunId === runId) return
        const checkpoint = yield* runtime.treeCheckpoint(link.runId).pipe(
          Effect.map(Option.some),
          Effect.catchTag("generalist/runtime/RunNotFound", () => Effect.succeed(Option.none())),
          Effect.mapError(() => unavailable("Generalist Run authorization is unavailable")),
        )
        if (Option.isSome(checkpoint) && checkpoint.value.inspection.runs.some(({ run }) => run.runId === runId)) return
      }
      return yield* HostedRecoveryError.make({ kind: "not-found", message: "Run is unavailable" })
    })

    // TODO(generalist): resolve a completed Executor receipt by exact outer operation identity without exposing tables.
    yield* Effect.logWarning("hosted-recovery.executor-terminal-resolution-unavailable").pipe(
      Effect.annotateLogs({
        "rika.failure.message":
          "Generalist does not expose an API that maps a completed Executor receipt to its unresolved operation",
      }),
    )
    return makeService({ runtime, authorizeRun })
  }),
)
