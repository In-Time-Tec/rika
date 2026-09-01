import * as PgClient from "@effect/sql-pg/PgClient"
import * as RemoteTools from "@rika/execution/remote-tools"
import { TerminalUnknownInput } from "@rika/execution/terminal-unknown"
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
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { OperationResolution as GeneralistOperationResolution, Runtime } from "generalist/runtime"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { AuthenticatedPrincipal } from "../product"
import { runOperations, runs } from "./generalist-schema"

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
  readonly marker: boolean
  readonly resolution: GeneralistOperationResolution.OperationResolution | null
}

interface PersistedExecutorOperationRow {
  readonly assignmentId: string
  readonly operationKey: string
  readonly runId: string
  readonly toolCallId: string
  readonly attempt: number
  readonly replayPolicy: "pure" | "provider-idempotent" | "never"
  readonly startedAt: Date | null
  readonly response: unknown
  readonly runStatus: string
}

interface PersistedGeneralistOperationRow {
  readonly operationId: string
  readonly operationKey: string
  readonly runId: string
  readonly kind: string
  readonly status: string
  readonly attempt: number
  readonly replayPolicy: string
  readonly inputJson: string
  readonly resolutionJson: string | null
}

interface MatchedOperationCandidate {
  readonly outer: PersistedExecutorOperationRow
  readonly target: PersistedGeneralistOperationRow
  readonly marker: boolean
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
const invalid = (message: string) => HostedRecoveryError.make({ kind: "invalid", message })
const decodeReplayPolicy = Schema.decodeUnknownOption(Schema.Literals(["pure", "provider-idempotent", "never"]))
const decodeTerminalUnknownInput = Schema.decodeUnknownOption(Schema.fromJsonString(TerminalUnknownInput))

const matchOperationCandidates = Effect.fn("HostedRecovery.matchOperationCandidates")(function* (
  outers: ReadonlyArray<PersistedExecutorOperationRow>,
  targets: ReadonlyArray<PersistedGeneralistOperationRow>,
) {
  const selected: Array<MatchedOperationCandidate> = []
  for (const outer of outers) {
    const candidates = targets.filter(
      (candidate) => candidate.runId === outer.runId && candidate.attempt === outer.attempt,
    )
    const markers = candidates.filter((candidate) => {
      if (candidate.kind !== "nested") return false
      const decoded = Option.getOrUndefined(decodeTerminalUnknownInput(candidate.inputJson))
      return (
        decoded !== undefined &&
        decoded.payload.sourceOperationKey === outer.operationKey &&
        decoded.payload.toolCallId === outer.toolCallId
      )
    })
    if (markers.length > 1) return yield* unavailable("Generalist terminal recovery markers are ambiguous")
    const marker = markers[0]
    if (marker !== undefined) {
      selected.push({ outer, target: marker, marker: true })
      continue
    }
    const direct = candidates.find((candidate) => candidate.operationKey === outer.operationKey)
    if (direct !== undefined) selected.push({ outer, target: direct, marker: false })
  }
  return selected
})

const decodeOperationRow = ({
  outer,
  target,
  marker,
}: MatchedOperationCandidate): Effect.Effect<OperationRow, HostedRecoveryError> => {
  const replayPolicy = Option.getOrUndefined(decodeReplayPolicy(target.replayPolicy))
  if (replayPolicy === undefined) return Effect.fail(unavailable("Generalist recovery replay policy is invalid"))
  const operation = (resolution: GeneralistOperationResolution.OperationResolution | null): OperationRow => ({
    operationId: target.operationId,
    operationKey: outer.operationKey,
    runId: outer.runId,
    attempt: outer.attempt,
    replayPolicy,
    started: outer.startedAt !== null,
    marker,
    resolution,
  })
  return target.resolutionJson === null
    ? Effect.succeed(operation(null))
    : Schema.decodeEffect(Schema.fromJsonString(GeneralistOperationResolution.OperationResolution))(
        target.resolutionJson,
      ).pipe(
        Effect.map(operation),
        Effect.mapError(() => unavailable("Generalist recovery resolution is invalid")),
      )
}

const project = (row: OperationRow): RecoveryOperation => {
  let state: RecoveryOperation["state"] = "needs-resolution"
  let resolution: RecoveryResolution | null = null
  if (row.resolution?._tag === "Retry") {
    state = "retrying"
    resolution = { _tag: "Retry" }
  } else if (row.resolution?._tag === "Succeeded") {
    state = "accepted"
    const terminal = row.marker
      ? Option.getOrUndefined(Schema.decodeUnknownOption(RemoteTools.TerminalResponse)(row.resolution.value))
      : undefined
    resolution = {
      _tag: "Accept",
      value: terminal?._tag === "Success" ? terminal.result : row.resolution.value,
    }
  } else if (row.resolution?._tag === "Failed") {
    state = "aborted"
    const decoded = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(row.resolution.error)
    resolution = {
      _tag: "Abort",
      reason: Option.match(decoded, { onNone: () => "Operation was aborted", onSome: (error) => error.message }),
    }
  }
  let actions: RecoveryOperation["actions"] = ["inspect"]
  if (state === "needs-resolution") {
    actions = row.marker ? ["inspect", "accept", "abort"] : ["inspect", "retry", "accept", "abort"]
  }
  return {
    operationId: row.operationId,
    operationKey: row.operationKey,
    runId: row.runId,
    attempt: row.attempt,
    replayPolicy: row.replayPolicy,
    started: row.started,
    state,
    actions,
    resolution,
  }
}

const completedResolutionValue = (response: RemoteTools.TerminalResponse, marker: boolean) => {
  if (marker) return response
  if (response._tag === "Success") {
    return { _tag: "Success" as const, result: response.result, encodedResult: response.result }
  }
  return {
    _tag: "DomainFailure" as const,
    failure: response.failure,
    encodedFailure: response.failure,
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

    const operations = Effect.fn("HostedRecovery.operations")(function* (threadId: string, runId: string) {
      const outerRows: ReadonlyArray<PersistedExecutorOperationRow> = yield* db
        .select({
          assignmentId: rikaHostedExecutorOperations.assignmentId,
          operationKey: rikaHostedExecutorOperations.operationKey,
          runId: rikaHostedExecutorOperations.runId,
          toolCallId: rikaHostedExecutorOperations.toolCallId,
          attempt: rikaHostedExecutorOperations.attempt,
          replayPolicy: rikaHostedExecutorOperations.replayPolicy,
          startedAt: rikaHostedExecutorOperations.startedAt,
          response: rikaHostedExecutorOperations.response,
          runStatus: runs.status,
        })
        .from(rikaHostedExecutorOperations)
        .innerJoin(runs, eq(runs.runId, rikaHostedExecutorOperations.runId))
        .where(
          and(
            eq(rikaHostedExecutorOperations.threadId, threadId),
            eq(rikaHostedExecutorOperations.runId, runId),
            or(eq(rikaHostedExecutorOperations.state, "unknown"), eq(rikaHostedExecutorOperations.state, "dispatched")),
          ),
        )
        .orderBy(asc(rikaHostedExecutorOperations.createdAt), asc(rikaHostedExecutorOperations.attempt))
        .pipe(Effect.mapError(() => unavailable("Could not inspect recovery operations")))
      if (outerRows.length === 0) return []
      const targetRows: ReadonlyArray<PersistedGeneralistOperationRow> = yield* db
        .select({
          operationId: runOperations.operationId,
          operationKey: runOperations.operationKey,
          runId: runOperations.runId,
          kind: runOperations.kind,
          status: runOperations.status,
          attempt: runOperations.attempt,
          replayPolicy: runOperations.replayPolicy,
          inputJson: runOperations.inputJson,
          resolutionJson: runOperations.resolutionJson,
        })
        .from(runOperations)
        .where(eq(runOperations.runId, runId))
        .pipe(Effect.mapError(() => unavailable("Could not inspect Generalist recovery operations")))
      const matched = yield* matchOperationCandidates(outerRows, targetRows)
      const eligible = matched.filter(
        ({ outer, target }) =>
          target.resolutionJson !== null || (target.status === "unknown" && outer.runStatus === "needs-resolution"),
      )
      return yield* Effect.forEach(eligible, decodeOperationRow)
    })

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
      if (row.marker && input.resolution._tag === "Retry")
        return yield* invalid("Terminal recovery markers cannot be retried")
      let resolution: GeneralistOperationResolution.OperationResolution
      if (input.resolution._tag === "Retry") {
        resolution = { _tag: "Retry" }
      } else if (input.resolution._tag === "Accept") {
        if (row.marker) {
          const response = yield* Schema.decodeUnknownEffect(RemoteTools.TerminalResponse)({
            _tag: "Success",
            result: input.resolution.value,
          }).pipe(Effect.mapError(() => invalid("Accepted terminal recovery value is invalid")))
          resolution = { _tag: "Succeeded", value: response }
        } else {
          resolution = { _tag: "Succeeded", value: input.resolution.value }
        }
      } else {
        resolution = {
          _tag: "Failed",
          error: { _tag: "UserAbortedUnknownOperation", message: input.resolution.reason },
        }
      }
      yield* runtime
        .resolveOperation({
          runId: input.runId,
          operationId: input.operationId,
          idempotencyKey: input.idempotencyKey,
          resolution,
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
      const resolvedRows = yield* operations(input.threadId, input.runId)
      const resolved = resolvedRows.find((candidate) => candidate.operationId === input.operationId)
      if (resolved === undefined) return yield* unavailable("Resolved recovery operation is unavailable")
      return project(resolved)
    })

    const reconcileCompleted = Effect.gen(function* () {
      const outerRows: ReadonlyArray<PersistedExecutorOperationRow> = yield* db
        .select({
          assignmentId: rikaHostedExecutorOperations.assignmentId,
          operationKey: rikaHostedExecutorOperations.operationKey,
          runId: rikaHostedExecutorOperations.runId,
          toolCallId: rikaHostedExecutorOperations.toolCallId,
          attempt: rikaHostedExecutorOperations.attempt,
          replayPolicy: rikaHostedExecutorOperations.replayPolicy,
          startedAt: rikaHostedExecutorOperations.startedAt,
          response: rikaHostedExecutorOperations.response,
          runStatus: runs.status,
        })
        .from(rikaHostedExecutorOperations)
        .innerJoin(runs, eq(runs.runId, rikaHostedExecutorOperations.runId))
        .where(
          and(
            eq(rikaHostedExecutorOperations.state, "completed"),
            isNotNull(rikaHostedExecutorOperations.response),
            eq(runs.status, "needs-resolution"),
          ),
        )
        .orderBy(asc(rikaHostedExecutorOperations.updatedAt), asc(rikaHostedExecutorOperations.operationKey))
        .limit(32)
        .pipe(Effect.mapError(() => unavailable("Could not inspect completed recovery operations")))
      if (outerRows.length === 0) return
      const runIds = [...new Set(outerRows.map((row) => row.runId))]
      const targetRows: ReadonlyArray<PersistedGeneralistOperationRow> = yield* db
        .select({
          operationId: runOperations.operationId,
          operationKey: runOperations.operationKey,
          runId: runOperations.runId,
          kind: runOperations.kind,
          status: runOperations.status,
          attempt: runOperations.attempt,
          replayPolicy: runOperations.replayPolicy,
          inputJson: runOperations.inputJson,
          resolutionJson: runOperations.resolutionJson,
        })
        .from(runOperations)
        .where(inArray(runOperations.runId, runIds))
        .pipe(Effect.mapError(() => unavailable("Could not inspect Generalist completed recovery operations")))
      const matched = (yield* matchOperationCandidates(outerRows, targetRows)).filter(
        ({ target }) => target.status === "unknown" && target.resolutionJson === null,
      )
      yield* Effect.forEach(
        matched,
        ({ outer, target, marker }) =>
          Schema.decodeUnknownEffect(RemoteTools.TerminalResponse)(outer.response).pipe(
            Effect.mapError(() => unavailable("Persisted completed operation response is invalid")),
            Effect.map((response) => completedResolutionValue(response, marker)),
            Effect.flatMap((value) =>
              runtime.resolveOperation({
                runId: outer.runId,
                operationId: target.operationId,
                idempotencyKey: `${target.operationId}:executor-terminal`,
                resolution: { _tag: "Succeeded", value },
              }),
            ),
            Effect.catchTag("generalist/runtime/OperationResolutionConflict", () => Effect.void),
            Effect.mapError(() => unavailable("Generalist completed operation recovery is unavailable")),
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
