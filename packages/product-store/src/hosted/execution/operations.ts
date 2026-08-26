import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { and, asc, eq, exists, gt, isNotNull, isNull, or, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { cliRegistration, identityMember } from "@rika/identity"
import {
  CellLifecycleFrame,
  CellResponse,
  type CellLifecycleFrame as CellLifecycleFrameValue,
  type CellResponse as CellResponseValue,
} from "@rika/remote-execution/protocol"
import {
  rikaHostedExecutorAssignments,
  rikaHostedExecutorOperationFrames,
  rikaHostedExecutorOperations,
  rikaHostedOwners,
  rikaHostedRunnerAdmissions,
  rikaHostedRunnerRegistrations,
  rikaHostedThreadCommands,
  rikaHostedWorkspaceCapabilityAdmissions,
} from "../../database/schema/product"

export class HostedExecutionOperationsError extends Schema.TaggedError<HostedExecutionOperationsError>()(
  "HostedExecutionOperationsError",
  { message: Schema.String },
) {}

export interface OperationIdentity {
  readonly assignmentId: string
  readonly operationKey: string
  readonly requestDigest: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly threadId: string
  readonly turnId: string
  readonly runId: string
  readonly rootRunId: string
  readonly toolCallId: string
  readonly code: string
  readonly attempt: number
  readonly replayPolicy: "pure" | "provider-idempotent" | "never"
  readonly admittedAt: string | null
  readonly deadlineAt: string
}

export interface DispatchFence {
  readonly assignmentGeneration: number
  readonly leaseEpoch: number
  readonly providerInstanceId: string
  readonly executorInstanceId: string
  readonly processIncarnation: string
}

export interface OperationRecord extends OperationIdentity {
  readonly ownerId: string
  readonly state: "accepted" | "dispatched" | "completed" | "unknown"
  readonly started: boolean
  readonly dispatchedGeneration: number | null
  readonly dispatchedLeaseEpoch: number | null
  readonly dispatchedExecutorInstanceId: string | null
  readonly dispatchedProcessIncarnation: string | null
  readonly response: CellResponseValue | null
  readonly terminalOutcome: "completed" | "failed" | "cancelled" | "unknown" | null
}

export type AppendFrameResult = "appended" | "duplicate" | "already-terminal" | "invalid-sequence"

export interface FinalizeOperationInput {
  readonly assignmentId: string
  readonly operationKey: string
  readonly attempt: number
  readonly response: CellResponseValue
  readonly state: "completed" | "unknown"
  readonly completionFence?: Omit<DispatchFence, "providerInstanceId">
  readonly expectedFence?: Omit<DispatchFence, "providerInstanceId">
  readonly onFinalize?: (result: FinalizedOperation) => Effect.Effect<void, HostedExecutionOperationsError>
}

export interface FinalizedOperation {
  readonly _tag: "finalized"
  readonly response: CellResponseValue
  readonly outcome: NonNullable<OperationRecord["terminalOutcome"]>
  readonly commandSequence: number
  readonly fence: Omit<DispatchFence, "providerInstanceId">
}

export type FinalizeOperationResult =
  | FinalizedOperation
  | {
      readonly _tag: "already-terminal"
      readonly response: CellResponseValue
      readonly outcome: NonNullable<OperationRecord["terminalOutcome"]>
    }
  | {
      readonly _tag:
        | "missing"
        | "not-dispatched"
        | "incomplete-fence"
        | "completion-fence-mismatch"
        | "expected-fence-mismatch"
        | "response-conflict"
        | "command-missing"
    }

type FinalizeFailureTag = Exclude<FinalizeOperationResult["_tag"], "finalized" | "already-terminal">

export interface HostedExecutionOperationsService {
  readonly findOperation: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
    lock?: "update",
  ) => Effect.Effect<OperationRecord | undefined, HostedExecutionOperationsError>
  readonly upsertOperation: (
    identity: OperationIdentity,
  ) => Effect.Effect<OperationRecord | undefined, HostedExecutionOperationsError>
  readonly claimDispatch: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt" | "threadId" | "turnId" | "workspaceId">,
    fence: DispatchFence,
    sessionDigest?: string,
  ) => Effect.Effect<"claimed" | "same-fence" | "fenced" | "missing", HostedExecutionOperationsError>
  readonly appendFrame: (
    assignmentId: string,
    frame: CellLifecycleFrameValue,
  ) => Effect.Effect<AppendFrameResult, HostedExecutionOperationsError>
  readonly readFrames: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
  ) => Effect.Effect<ReadonlyArray<CellLifecycleFrameValue>, HostedExecutionOperationsError>
  readonly terminalFrame: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
  ) => Effect.Effect<
    Extract<CellLifecycleFrameValue, { readonly _tag: "Terminal" }> | undefined,
    HostedExecutionOperationsError
  >
  readonly terminalRecoveryScan: Effect.Effect<
    ReadonlyArray<{
      readonly assignmentId: string
      readonly operationKey: string
      readonly attempt: number
      readonly frame: Extract<CellLifecycleFrameValue, { readonly _tag: "Terminal" }>
    }>,
    HostedExecutionOperationsError
  >
  readonly replayQueue: (
    assignmentId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly operationKey: string; readonly attempt: number; readonly afterCursor: number }>,
    HostedExecutionOperationsError
  >
  readonly complete: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
    fence: Omit<DispatchFence, "providerInstanceId">,
    response: CellResponseValue,
    outcome: OperationRecord["terminalOutcome"],
  ) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly finalizeOperation: (
    input: FinalizeOperationInput,
  ) => Effect.Effect<FinalizeOperationResult, HostedExecutionOperationsError>
  readonly terminalizeAccepted: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
    response: CellResponseValue,
    outcome: "failed" | "cancelled",
    onTerminalize?: (result: {
      readonly operation: OperationRecord
      readonly commandSequence: number
      readonly assignmentGeneration: number
      readonly leaseEpoch: number
    }) => Effect.Effect<void, HostedExecutionOperationsError>,
  ) => Effect.Effect<
    | {
        readonly operation: OperationRecord
        readonly commandSequence: number
        readonly assignmentGeneration: number
        readonly leaseEpoch: number
      }
    | undefined,
    HostedExecutionOperationsError
  >
  readonly admitWorkspaceCapabilities: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly assignmentId: string
    readonly workspaceId: string
    readonly assignmentGeneration: number
    readonly environmentDigest: string
    readonly requiredCapabilities: Schema.Json
  }) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly validateWorkspaceCapabilities: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly assignmentId: string
    readonly workspaceId: string
    readonly assignmentGeneration: number
    readonly environmentDigest: string
  }) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly verifyRunnerAuthority: (input: {
    readonly ownerId: string
    readonly clientId: string
    readonly deviceId: string
    readonly userId: string
    readonly dpopJkt?: string
  }) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly runnerPrincipal: (input: {
    readonly assignmentId: string
    readonly generation: number
    readonly deviceId: string
    readonly processIncarnation: string
  }) => Effect.Effect<
    { readonly deviceId: string; readonly clientId: string; readonly userId: string } | undefined,
    HostedExecutionOperationsError
  >
  readonly hasConsumedRunnerAdmission: (input: {
    readonly assignmentId: string
    readonly ownerId: string
    readonly generation: number
    readonly deviceId: string
    readonly clientId: string
  }) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly lockRemoteCreationAdmission: (
    deviceId: string,
    checkoutFingerprint: string,
  ) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly createRunnerAdmission: (input: {
    readonly id: string
    readonly assignmentId: string
    readonly ownerId: string
    readonly deviceId: string
    readonly clientId: string
    readonly userId: string
    readonly generation: number
    readonly workspaceFingerprint: string
    readonly ticketDigest: string
    readonly lifetimeMillis: number
  }) => Effect.Effect<number, HostedExecutionOperationsError>
  readonly lockRunnerAdmission: (
    id: string,
  ) => Effect.Effect<typeof rikaHostedRunnerAdmissions.$inferSelect | undefined, HostedExecutionOperationsError>
  readonly consumeRunnerAdmission: (
    id: string,
    processIncarnation: string,
  ) => Effect.Effect<boolean, HostedExecutionOperationsError>
}

export class HostedExecutionOperations extends Context.Service<
  HostedExecutionOperations,
  HostedExecutionOperationsService
>()("@rika/product-store/hosted/execution/operations/HostedExecutionOperations") {}

const failure = (cause: unknown) =>
  HostedExecutionOperationsError.make({ message: `Hosted execution persistence failed: ${String(cause)}` })
const query = <A extends object, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  effect.pipe(Effect.mapError(failure))
const timestamp = (value: Date) => value.toISOString()
const operationKey = (input: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">) =>
  and(
    eq(rikaHostedExecutorOperations.assignmentId, input.assignmentId),
    eq(rikaHostedExecutorOperations.operationKey, input.operationKey),
    eq(rikaHostedExecutorOperations.attempt, input.attempt),
  )
const finalizeFailure = (tag: FinalizeFailureTag): FinalizeOperationResult => ({ _tag: tag })

const make = Effect.gen(function* () {
  const db = yield* PgDrizzle.makeWithDefaults()
  const selectOperation = (
    executor: PgDrizzle.EffectPgDatabase,
    input: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
    lock?: "update",
  ) => {
    const statement = executor.select().from(rikaHostedExecutorOperations).where(operationKey(input))
    return lock === "update" ? statement.for("update") : statement
  }
  const decodeOperation = (
    row: typeof rikaHostedExecutorOperations.$inferSelect,
  ): Effect.Effect<OperationRecord, HostedExecutionOperationsError> =>
    Effect.gen(function* () {
      const response = row.response === null ? null : yield* Schema.decodeUnknownEffect(CellResponse)(row.response)
      return {
        assignmentId: row.assignmentId,
        ownerId: row.ownerId,
        operationKey: row.operationKey,
        requestDigest: row.requestDigest,
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
        deadlineAt: timestamp(row.deadlineAt),
        state: row.state,
        started: row.startedAt !== null,
        dispatchedGeneration: row.dispatchedGeneration,
        dispatchedLeaseEpoch: row.dispatchedLeaseEpoch,
        dispatchedExecutorInstanceId: row.dispatchedExecutorInstanceId,
        dispatchedProcessIncarnation: row.dispatchedProcessIncarnation,
        response,
        terminalOutcome:
          row.terminalOutcome === null
            ? null
            : yield* Schema.decodeUnknownEffect(Schema.Literals(["completed", "failed", "cancelled", "unknown"]))(
                row.terminalOutcome,
              ),
      }
    }).pipe(Effect.mapError(failure))
  const findOperation: HostedExecutionOperationsService["findOperation"] = (input, lock) =>
    query(selectOperation(db, input, lock)).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.void.pipe(Effect.as<OperationRecord | undefined>(undefined))
          : decodeOperation(rows[0]),
      ),
    )
  const upsertOperation: HostedExecutionOperationsService["upsertOperation"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const assignments = yield* query(
            tx
              .select({ ownerId: rikaHostedExecutorAssignments.ownerId })
              .from(rikaHostedExecutorAssignments)
              .where(eq(rikaHostedExecutorAssignments.id, input.assignmentId)),
          )
          const assignment = assignments[0]
          if (assignment === undefined) return undefined
          yield* query(
            tx
              .insert(rikaHostedExecutorOperations)
              .values({
                ...input,
                ownerId: assignment.ownerId,
                deadlineAt: DateTime.toDate(DateTime.makeUnsafe(input.deadlineAt)),
                state: "accepted",
              })
              .onConflictDoNothing(),
          )
          const rows = yield* query(selectOperation(tx, input))
          return rows[0] === undefined ? undefined : yield* decodeOperation(rows[0])
        }),
      )
      .pipe(Effect.mapError(failure))
  const claimDispatch: HostedExecutionOperationsService["claimDispatch"] = (input, fence, sessionDigest) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const assignmentPredicate = and(
            eq(rikaHostedExecutorAssignments.id, input.assignmentId),
            eq(rikaHostedExecutorAssignments.lifecycle, "active"),
            eq(rikaHostedExecutorAssignments.capabilityGeneration, rikaHostedExecutorAssignments.generation),
            eq(rikaHostedExecutorAssignments.generation, fence.assignmentGeneration),
            eq(rikaHostedExecutorAssignments.leaseEpoch, fence.leaseEpoch),
            gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql`clock_timestamp()`),
            eq(rikaHostedExecutorAssignments.providerInstanceId, fence.providerInstanceId),
            eq(rikaHostedExecutorAssignments.executorInstanceId, fence.executorInstanceId),
            eq(rikaHostedExecutorAssignments.processIncarnation, fence.processIncarnation),
            sessionDigest === undefined ? sql`true` : eq(rikaHostedExecutorAssignments.sessionDigest, sessionDigest),
          )
          const assignments = yield* query(
            tx
              .select({ id: rikaHostedExecutorAssignments.id })
              .from(rikaHostedExecutorAssignments)
              .innerJoin(
                rikaHostedRunnerAdmissions,
                and(
                  eq(rikaHostedRunnerAdmissions.assignmentId, rikaHostedExecutorAssignments.id),
                  eq(rikaHostedRunnerAdmissions.ownerId, rikaHostedExecutorAssignments.ownerId),
                  eq(rikaHostedRunnerAdmissions.generation, rikaHostedExecutorAssignments.generation),
                  eq(rikaHostedRunnerAdmissions.deviceId, rikaHostedExecutorAssignments.providerInstanceId),
                  eq(rikaHostedRunnerAdmissions.processIncarnation, rikaHostedExecutorAssignments.processIncarnation),
                  isNotNull(rikaHostedRunnerAdmissions.consumedAt),
                  isNull(rikaHostedRunnerAdmissions.revokedAt),
                ),
              )
              .innerJoin(
                cliRegistration,
                and(
                  eq(cliRegistration.clientId, rikaHostedRunnerAdmissions.clientId),
                  sql`${cliRegistration.deviceId}::text = ${rikaHostedRunnerAdmissions.deviceId}`,
                  eq(cliRegistration.userId, rikaHostedRunnerAdmissions.userId),
                  isNull(cliRegistration.revokedAt),
                ),
              )
              .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedExecutorAssignments.ownerId))
              .innerJoin(
                rikaHostedWorkspaceCapabilityAdmissions,
                and(
                  eq(rikaHostedWorkspaceCapabilityAdmissions.assignmentId, rikaHostedExecutorAssignments.id),
                  eq(rikaHostedWorkspaceCapabilityAdmissions.threadId, input.threadId),
                  eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, input.turnId),
                  eq(rikaHostedWorkspaceCapabilityAdmissions.workspaceId, input.workspaceId),
                  eq(
                    rikaHostedWorkspaceCapabilityAdmissions.assignmentGeneration,
                    rikaHostedExecutorAssignments.generation,
                  ),
                  sql`${rikaHostedWorkspaceCapabilityAdmissions.environmentDigest} = ${rikaHostedExecutorAssignments.capabilitySnapshot}->>'environmentDigest'`,
                ),
              )
              .where(
                and(
                  assignmentPredicate,
                  eq(rikaHostedExecutorAssignments.threadId, input.threadId),
                  or(
                    and(
                      eq(rikaHostedOwners.kind, "personal"),
                      eq(rikaHostedOwners.userId, rikaHostedRunnerAdmissions.userId),
                    ),
                    and(
                      eq(rikaHostedOwners.kind, "organization"),
                      exists(
                        tx
                          .select({ id: identityMember.id })
                          .from(identityMember)
                          .where(
                            and(
                              eq(identityMember.organizationId, rikaHostedOwners.organizationId),
                              eq(identityMember.userId, rikaHostedRunnerAdmissions.userId),
                            ),
                          ),
                      ),
                    ),
                  ),
                ),
              )
              .for("update"),
          )
          if (assignments[0] === undefined) return "fenced"
          const rows = yield* query(selectOperation(tx, input, "update"))
          const row = rows[0]
          if (row === undefined) return "missing"
          if (row.state === "dispatched")
            return row.dispatchedGeneration === fence.assignmentGeneration &&
              row.dispatchedLeaseEpoch === fence.leaseEpoch &&
              row.dispatchedExecutorInstanceId === fence.executorInstanceId &&
              row.dispatchedProcessIncarnation === fence.processIncarnation
              ? "same-fence"
              : "fenced"
          if (row.state !== "accepted") return "fenced"
          const updated = yield* query(
            tx
              .update(rikaHostedExecutorOperations)
              .set({
                state: "dispatched",
                dispatchedGeneration: fence.assignmentGeneration,
                dispatchedLeaseEpoch: fence.leaseEpoch,
                dispatchedExecutorInstanceId: fence.executorInstanceId,
                dispatchedProcessIncarnation: fence.processIncarnation,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(and(operationKey(input), eq(rikaHostedExecutorOperations.state, "accepted")))
              .returning({ key: rikaHostedExecutorOperations.operationKey }),
          )
          return updated[0] === undefined ? "fenced" : "claimed"
        }),
      )
      .pipe(Effect.mapError(failure))
  const readFrames: HostedExecutionOperationsService["readFrames"] = (input) =>
    query(
      db
        .select({ frame: rikaHostedExecutorOperationFrames.frame })
        .from(rikaHostedExecutorOperationFrames)
        .where(
          and(
            eq(rikaHostedExecutorOperationFrames.assignmentId, input.assignmentId),
            eq(rikaHostedExecutorOperationFrames.operationKey, input.operationKey),
            eq(rikaHostedExecutorOperationFrames.attempt, input.attempt),
          ),
        )
        .orderBy(asc(rikaHostedExecutorOperationFrames.cursor)),
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(CellLifecycleFrame)(row.frame).pipe(Effect.mapError(failure)),
        ),
      ),
    )
  const appendFrame: HostedExecutionOperationsService["appendFrame"] = (assignmentId, frame) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const input = {
            assignmentId,
            operationKey: frame.attribution.operationKey,
            attempt: frame.attribution.attempt,
          }
          const operations = yield* query(selectOperation(tx, input, "update"))
          const operation = operations[0]
          if (operation === undefined) return "invalid-sequence"
          const attribution = frame.attribution
          if (
            operation.workspaceId !== attribution.workspaceId ||
            operation.sessionId !== attribution.sessionId ||
            operation.threadId !== attribution.threadId ||
            operation.turnId !== attribution.turnId ||
            operation.runId !== attribution.runId ||
            operation.rootRunId !== attribution.rootRunId ||
            operation.toolCallId !== attribution.toolCallId
          )
            return "invalid-sequence"
          const rows = yield* query(
            tx
              .select({ frame: rikaHostedExecutorOperationFrames.frame })
              .from(rikaHostedExecutorOperationFrames)
              .where(
                and(
                  eq(rikaHostedExecutorOperationFrames.assignmentId, assignmentId),
                  eq(rikaHostedExecutorOperationFrames.operationKey, input.operationKey),
                  eq(rikaHostedExecutorOperationFrames.attempt, input.attempt),
                ),
              )
              .orderBy(asc(rikaHostedExecutorOperationFrames.cursor)),
          )
          const known = yield* Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(CellLifecycleFrame)(row.frame).pipe(Effect.mapError(failure)),
          )
          const existing = known.find((value) => value.cursor === frame.cursor)
          if (existing !== undefined)
            return Schema.toEquivalence(CellLifecycleFrame)(existing, frame) ? "duplicate" : "invalid-sequence"
          if (operation.state === "completed" || operation.state === "unknown") return "already-terminal"
          if (
            operation.state !== "dispatched" ||
            frame.cursor !== known.length + 1 ||
            known.some((value) => value._tag === "Terminal") ||
            (frame.cursor === 1 && frame._tag !== "Accepted") ||
            (frame.cursor === 2 && frame._tag !== "Started") ||
            (frame.cursor > 2 && frame._tag !== "Output" && frame._tag !== "Terminal") ||
            (frame._tag === "Output" && known.filter((value) => value._tag === "Output").length >= 16)
          )
            return "invalid-sequence"
          yield* query(
            tx.insert(rikaHostedExecutorOperationFrames).values({
              assignmentId,
              operationKey: input.operationKey,
              attempt: input.attempt,
              cursor: frame.cursor,
              kind: frame._tag,
              frame,
            }),
          )
          if (frame._tag === "Started")
            yield* query(
              tx
                .update(rikaHostedExecutorOperations)
                .set({
                  startedAt: sql`coalesce(${rikaHostedExecutorOperations.startedAt}, clock_timestamp())`,
                  updatedAt: sql`clock_timestamp()`,
                })
                .where(and(operationKey(input), eq(rikaHostedExecutorOperations.state, "dispatched"))),
            )
          return "appended"
        }),
      )
      .pipe(Effect.mapError(failure))
  const terminalFrame: HostedExecutionOperationsService["terminalFrame"] = (input) =>
    query(
      db
        .select({ frame: rikaHostedExecutorOperationFrames.frame })
        .from(rikaHostedExecutorOperationFrames)
        .where(
          and(
            eq(rikaHostedExecutorOperationFrames.assignmentId, input.assignmentId),
            eq(rikaHostedExecutorOperationFrames.operationKey, input.operationKey),
            eq(rikaHostedExecutorOperationFrames.attempt, input.attempt),
            eq(rikaHostedExecutorOperationFrames.kind, "Terminal"),
          ),
        )
        .limit(1),
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.void.pipe(
              Effect.as<Extract<CellLifecycleFrameValue, { readonly _tag: "Terminal" }> | undefined>(undefined),
            )
          : Schema.decodeUnknownEffect(CellLifecycleFrame)(rows[0].frame).pipe(
              Effect.mapError(failure),
              Effect.flatMap((frame) =>
                frame._tag === "Terminal"
                  ? Effect.succeed(frame)
                  : Effect.fail(failure("Terminal frame kind is invalid")),
              ),
            ),
      ),
    )
  const terminalRecoveryScan: HostedExecutionOperationsService["terminalRecoveryScan"] = query(
    db
      .select({
        assignmentId: rikaHostedExecutorOperations.assignmentId,
        operationKey: rikaHostedExecutorOperations.operationKey,
        attempt: rikaHostedExecutorOperations.attempt,
        frame: rikaHostedExecutorOperationFrames.frame,
      })
      .from(rikaHostedExecutorOperations)
      .innerJoin(
        rikaHostedExecutorOperationFrames,
        and(
          eq(rikaHostedExecutorOperationFrames.assignmentId, rikaHostedExecutorOperations.assignmentId),
          eq(rikaHostedExecutorOperationFrames.operationKey, rikaHostedExecutorOperations.operationKey),
          eq(rikaHostedExecutorOperationFrames.attempt, rikaHostedExecutorOperations.attempt),
          eq(rikaHostedExecutorOperationFrames.kind, "Terminal"),
        ),
      )
      .where(eq(rikaHostedExecutorOperations.state, "dispatched"))
      .orderBy(asc(rikaHostedExecutorOperations.updatedAt), asc(rikaHostedExecutorOperations.operationKey))
      .limit(32),
  ).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(CellLifecycleFrame)(row.frame).pipe(
          Effect.mapError(failure),
          Effect.flatMap((frame) =>
            frame._tag === "Terminal"
              ? Effect.succeed({ ...row, frame })
              : Effect.fail(failure("Terminal frame kind is invalid")),
          ),
        ),
      ),
    ),
  )
  const replayQueue: HostedExecutionOperationsService["replayQueue"] = (assignmentId) =>
    query(
      db
        .select({
          operationKey: rikaHostedExecutorOperations.operationKey,
          attempt: rikaHostedExecutorOperations.attempt,
          afterCursor: sql<string>`coalesce(max(${rikaHostedExecutorOperationFrames.cursor}), 0)::text`,
        })
        .from(rikaHostedExecutorOperations)
        .leftJoin(
          rikaHostedExecutorOperationFrames,
          and(
            eq(rikaHostedExecutorOperationFrames.assignmentId, rikaHostedExecutorOperations.assignmentId),
            eq(rikaHostedExecutorOperationFrames.operationKey, rikaHostedExecutorOperations.operationKey),
            eq(rikaHostedExecutorOperationFrames.attempt, rikaHostedExecutorOperations.attempt),
          ),
        )
        .where(
          and(
            eq(rikaHostedExecutorOperations.assignmentId, assignmentId),
            eq(rikaHostedExecutorOperations.state, "dispatched"),
          ),
        )
        .groupBy(rikaHostedExecutorOperations.operationKey, rikaHostedExecutorOperations.attempt)
        .orderBy(rikaHostedExecutorOperations.operationKey, rikaHostedExecutorOperations.attempt),
    ).pipe(Effect.map((rows) => rows.map((row) => ({ ...row, afterCursor: Number(row.afterCursor) }))))
  const complete: HostedExecutionOperationsService["complete"] = (input, fence, response, outcome) =>
    query(
      db
        .update(rikaHostedExecutorOperations)
        .set({
          state: outcome === "unknown" ? "unknown" : "completed",
          response,
          terminalOutcome: outcome,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            operationKey(input),
            eq(rikaHostedExecutorOperations.state, "dispatched"),
            eq(rikaHostedExecutorOperations.dispatchedGeneration, fence.assignmentGeneration),
            eq(rikaHostedExecutorOperations.dispatchedLeaseEpoch, fence.leaseEpoch),
            eq(rikaHostedExecutorOperations.dispatchedExecutorInstanceId, fence.executorInstanceId),
            eq(rikaHostedExecutorOperations.dispatchedProcessIncarnation, fence.processIncarnation),
          ),
        )
        .returning({ key: rikaHostedExecutorOperations.operationKey }),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  const finalizeOperation: HostedExecutionOperationsService["finalizeOperation"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* query(selectOperation(tx, input, "update"))
          const row = rows[0]
          if (row === undefined) return finalizeFailure("missing")
          if (row.state === "completed" || row.state === "unknown") {
            if (row.response === null || row.terminalOutcome === null)
              return yield* failure("Terminal operation is incomplete")
            const previous = yield* Schema.decodeUnknownEffect(CellResponse)(row.response).pipe(
              Effect.mapError(failure),
            )
            if (
              !Schema.toEquivalence(CellResponse)(previous, input.response) &&
              input.state !== "unknown" &&
              row.state !== "unknown"
            )
              return finalizeFailure("response-conflict")
            const outcome = yield* Schema.decodeUnknownEffect(
              Schema.Literals(["completed", "failed", "cancelled", "unknown"]),
            )(row.terminalOutcome).pipe(Effect.mapError(failure))
            const result: FinalizeOperationResult = { _tag: "already-terminal", response: previous, outcome }
            return result
          }
          if (row.state !== "dispatched") return finalizeFailure("not-dispatched")
          if (
            row.dispatchedGeneration === null ||
            row.dispatchedLeaseEpoch === null ||
            row.dispatchedExecutorInstanceId === null ||
            row.dispatchedProcessIncarnation === null
          )
            return finalizeFailure("incomplete-fence")
          const fence = {
            assignmentGeneration: row.dispatchedGeneration,
            leaseEpoch: row.dispatchedLeaseEpoch,
            executorInstanceId: row.dispatchedExecutorInstanceId,
            processIncarnation: row.dispatchedProcessIncarnation,
          }
          const receipts = yield* query(
            tx
              .select({ frame: rikaHostedExecutorOperationFrames.frame })
              .from(rikaHostedExecutorOperationFrames)
              .where(
                and(
                  eq(rikaHostedExecutorOperationFrames.assignmentId, input.assignmentId),
                  eq(rikaHostedExecutorOperationFrames.operationKey, input.operationKey),
                  eq(rikaHostedExecutorOperationFrames.attempt, input.attempt),
                  eq(rikaHostedExecutorOperationFrames.kind, "Terminal"),
                ),
              )
              .limit(1),
          )
          const terminal =
            receipts[0] === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(CellLifecycleFrame)(receipts[0].frame).pipe(
                  Effect.mapError(failure),
                  Effect.flatMap((frame) =>
                    frame._tag === "Terminal"
                      ? Effect.succeed(frame)
                      : Effect.fail(failure("Terminal frame kind is invalid")),
                  ),
                )
          if (
            terminal !== undefined &&
            input.state === "completed" &&
            !Schema.toEquivalence(CellResponse)(terminal.response, input.response)
          )
            return finalizeFailure("response-conflict")
          const response = terminal?.response ?? input.response
          const outcome = terminal?.outcome ?? "unknown"
          let state: "completed" | "unknown" = input.state
          if (terminal !== undefined) state = terminal.outcome === "unknown" ? "unknown" : "completed"
          if (
            state === "completed" &&
            terminal === undefined &&
            (input.completionFence === undefined ||
              input.completionFence.assignmentGeneration !== fence.assignmentGeneration ||
              input.completionFence.executorInstanceId !== fence.executorInstanceId ||
              input.completionFence.processIncarnation !== fence.processIncarnation)
          )
            return finalizeFailure("completion-fence-mismatch")
          const expected = input.expectedFence ?? fence
          if (
            expected.assignmentGeneration !== fence.assignmentGeneration ||
            expected.leaseEpoch !== fence.leaseEpoch ||
            expected.executorInstanceId !== fence.executorInstanceId ||
            expected.processIncarnation !== fence.processIncarnation
          )
            return finalizeFailure("expected-fence-mismatch")
          const updated = yield* query(
            tx
              .update(rikaHostedExecutorOperations)
              .set({ state, response, terminalOutcome: outcome, updatedAt: sql`clock_timestamp()` })
              .where(
                and(
                  operationKey(input),
                  eq(rikaHostedExecutorOperations.state, "dispatched"),
                  eq(rikaHostedExecutorOperations.dispatchedGeneration, expected.assignmentGeneration),
                  eq(rikaHostedExecutorOperations.dispatchedLeaseEpoch, expected.leaseEpoch),
                  eq(rikaHostedExecutorOperations.dispatchedExecutorInstanceId, expected.executorInstanceId),
                  eq(rikaHostedExecutorOperations.dispatchedProcessIncarnation, expected.processIncarnation),
                ),
              )
              .returning({ key: rikaHostedExecutorOperations.operationKey }),
          )
          if (updated[0] === undefined) return finalizeFailure("expected-fence-mismatch")
          const commands = yield* query(
            tx
              .select({ sequence: rikaHostedThreadCommands.sequence })
              .from(rikaHostedThreadCommands)
              .where(
                and(
                  eq(rikaHostedThreadCommands.threadId, row.threadId),
                  eq(rikaHostedThreadCommands.turnId, row.turnId),
                ),
              )
              .limit(1),
          )
          if (commands[0] === undefined) return yield* failure("Runner command is unavailable")
          const result: FinalizedOperation = {
            _tag: "finalized",
            response,
            outcome,
            commandSequence: commands[0].sequence,
            fence,
          }
          if (input.onFinalize !== undefined) yield* input.onFinalize(result).pipe(Effect.mapError(failure))
          return result
        }),
      )
      .pipe(Effect.mapError(failure))
  const terminalizeAccepted: HostedExecutionOperationsService["terminalizeAccepted"] = (
    input,
    response,
    outcome,
    onTerminalize,
  ) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* query(selectOperation(tx, input, "update"))
          const row = rows[0]
          if (row === undefined || row.state !== "accepted") return undefined
          const updated = yield* query(
            tx
              .update(rikaHostedExecutorOperations)
              .set({ state: "completed", response, terminalOutcome: outcome, updatedAt: sql`clock_timestamp()` })
              .where(and(operationKey(input), eq(rikaHostedExecutorOperations.state, "accepted")))
              .returning({ key: rikaHostedExecutorOperations.operationKey }),
          )
          if (updated[0] === undefined) return undefined
          const commands = yield* query(
            tx
              .select({ sequence: rikaHostedThreadCommands.sequence })
              .from(rikaHostedThreadCommands)
              .where(
                and(
                  eq(rikaHostedThreadCommands.threadId, row.threadId),
                  eq(rikaHostedThreadCommands.turnId, row.turnId),
                ),
              )
              .limit(1),
          )
          const assignments = yield* query(
            tx
              .select({
                generation: rikaHostedExecutorAssignments.generation,
                leaseEpoch: rikaHostedExecutorAssignments.leaseEpoch,
              })
              .from(rikaHostedExecutorAssignments)
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, input.assignmentId),
                  isNotNull(rikaHostedExecutorAssignments.leaseEpoch),
                ),
              )
              .for("share"),
          )
          if (commands[0] === undefined || assignments[0]?.leaseEpoch === null || assignments[0] === undefined)
            return yield* failure("Runner deadline authority is unavailable")
          const result = {
            operation: yield* decodeOperation({ ...row, state: "completed", response, terminalOutcome: outcome }),
            commandSequence: commands[0].sequence,
            assignmentGeneration: assignments[0].generation,
            leaseEpoch: assignments[0].leaseEpoch,
          }
          if (onTerminalize !== undefined) yield* onTerminalize(result)
          return result
        }),
      )
      .pipe(Effect.mapError(failure))
  const admitWorkspaceCapabilities: HostedExecutionOperationsService["admitWorkspaceCapabilities"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* query(tx.insert(rikaHostedWorkspaceCapabilityAdmissions).values(input).onConflictDoNothing())
          const rows = yield* query(
            tx
              .select()
              .from(rikaHostedWorkspaceCapabilityAdmissions)
              .where(
                and(
                  eq(rikaHostedWorkspaceCapabilityAdmissions.threadId, input.threadId),
                  eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, input.turnId),
                ),
              ),
          )
          const row = rows[0]
          return (
            row !== undefined &&
            row.assignmentId === input.assignmentId &&
            row.workspaceId === input.workspaceId &&
            row.assignmentGeneration === input.assignmentGeneration &&
            row.environmentDigest === input.environmentDigest
          )
        }),
      )
      .pipe(Effect.mapError(failure))
  const validateWorkspaceCapabilities: HostedExecutionOperationsService["validateWorkspaceCapabilities"] = (input) =>
    query(
      db
        .select({ id: rikaHostedWorkspaceCapabilityAdmissions.assignmentId })
        .from(rikaHostedWorkspaceCapabilityAdmissions)
        .where(
          and(
            eq(rikaHostedWorkspaceCapabilityAdmissions.threadId, input.threadId),
            eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, input.turnId),
            eq(rikaHostedWorkspaceCapabilityAdmissions.assignmentId, input.assignmentId),
            eq(rikaHostedWorkspaceCapabilityAdmissions.workspaceId, input.workspaceId),
            eq(rikaHostedWorkspaceCapabilityAdmissions.assignmentGeneration, input.assignmentGeneration),
            eq(rikaHostedWorkspaceCapabilityAdmissions.environmentDigest, input.environmentDigest),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  const verifyRunnerAuthority: HostedExecutionOperationsService["verifyRunnerAuthority"] = (input) =>
    query(
      db
        .select({ id: rikaHostedOwners.id })
        .from(rikaHostedOwners)
        .innerJoin(
          cliRegistration,
          and(
            eq(cliRegistration.clientId, input.clientId),
            sql`${cliRegistration.deviceId}::text = ${input.deviceId}`,
            eq(cliRegistration.userId, input.userId),
            isNull(cliRegistration.revokedAt),
            input.dpopJkt === undefined ? sql`true` : eq(cliRegistration.jwkThumbprint, input.dpopJkt),
          ),
        )
        .where(
          and(
            eq(rikaHostedOwners.id, input.ownerId),
            or(
              and(eq(rikaHostedOwners.kind, "personal"), eq(rikaHostedOwners.userId, input.userId)),
              and(
                eq(rikaHostedOwners.kind, "organization"),
                exists(
                  db
                    .select({ id: identityMember.id })
                    .from(identityMember)
                    .where(
                      and(
                        eq(identityMember.organizationId, rikaHostedOwners.organizationId),
                        eq(identityMember.userId, input.userId),
                      ),
                    ),
                ),
              ),
            ),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  const runnerPrincipal: HostedExecutionOperationsService["runnerPrincipal"] = (input) =>
    query(
      db
        .select({
          deviceId: rikaHostedRunnerAdmissions.deviceId,
          clientId: rikaHostedRunnerAdmissions.clientId,
          userId: rikaHostedRunnerAdmissions.userId,
        })
        .from(rikaHostedRunnerAdmissions)
        .where(
          and(
            eq(rikaHostedRunnerAdmissions.assignmentId, input.assignmentId),
            eq(rikaHostedRunnerAdmissions.generation, input.generation),
            eq(rikaHostedRunnerAdmissions.deviceId, input.deviceId),
            eq(rikaHostedRunnerAdmissions.processIncarnation, input.processIncarnation),
            isNotNull(rikaHostedRunnerAdmissions.consumedAt),
            isNull(rikaHostedRunnerAdmissions.revokedAt),
          ),
        )
        .orderBy(asc(rikaHostedRunnerAdmissions.consumedAt))
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]))
  const hasConsumedRunnerAdmission: HostedExecutionOperationsService["hasConsumedRunnerAdmission"] = (input) =>
    query(
      db
        .select({ id: rikaHostedRunnerAdmissions.id })
        .from(rikaHostedRunnerAdmissions)
        .where(
          and(
            eq(rikaHostedRunnerAdmissions.assignmentId, input.assignmentId),
            eq(rikaHostedRunnerAdmissions.ownerId, input.ownerId),
            eq(rikaHostedRunnerAdmissions.generation, input.generation),
            eq(rikaHostedRunnerAdmissions.deviceId, input.deviceId),
            eq(rikaHostedRunnerAdmissions.clientId, input.clientId),
            isNotNull(rikaHostedRunnerAdmissions.consumedAt),
            isNull(rikaHostedRunnerAdmissions.revokedAt),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  const lockRemoteCreationAdmission: HostedExecutionOperationsService["lockRemoteCreationAdmission"] = (
    deviceId,
    checkoutFingerprint,
  ) =>
    query(
      db
        .select({ id: rikaHostedRunnerRegistrations.deviceId })
        .from(rikaHostedRunnerRegistrations)
        .where(
          and(
            eq(rikaHostedRunnerRegistrations.deviceId, deviceId),
            eq(rikaHostedRunnerRegistrations.checkoutFingerprint, checkoutFingerprint),
            eq(rikaHostedRunnerRegistrations.remoteThreadCreationAllowed, true),
          ),
        )
        .for("update"),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  const createRunnerAdmission: HostedExecutionOperationsService["createRunnerAdmission"] = (input) =>
    query(
      db
        .insert(rikaHostedRunnerAdmissions)
        .values({ ...input, expiresAt: sql`clock_timestamp() + (${input.lifetimeMillis} * interval '1 millisecond')` })
        .returning({ expiresAt: rikaHostedRunnerAdmissions.expiresAt }),
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(failure("Runner admission was not persisted"))
          : Effect.succeed(rows[0].expiresAt.getTime()),
      ),
    )
  const lockRunnerAdmission: HostedExecutionOperationsService["lockRunnerAdmission"] = (id) =>
    query(
      db
        .select()
        .from(rikaHostedRunnerAdmissions)
        .where(
          and(
            eq(rikaHostedRunnerAdmissions.id, id),
            isNull(rikaHostedRunnerAdmissions.consumedAt),
            isNull(rikaHostedRunnerAdmissions.revokedAt),
            gt(rikaHostedRunnerAdmissions.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .for("update"),
    ).pipe(Effect.map((rows) => rows[0]))
  const consumeRunnerAdmission: HostedExecutionOperationsService["consumeRunnerAdmission"] = (id, processIncarnation) =>
    query(
      db
        .update(rikaHostedRunnerAdmissions)
        .set({ consumedAt: sql`transaction_timestamp()`, processIncarnation })
        .where(
          and(
            eq(rikaHostedRunnerAdmissions.id, id),
            isNull(rikaHostedRunnerAdmissions.consumedAt),
            gt(rikaHostedRunnerAdmissions.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ id: rikaHostedRunnerAdmissions.id }),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  return HostedExecutionOperations.of({
    findOperation,
    upsertOperation,
    claimDispatch,
    appendFrame,
    readFrames,
    terminalFrame,
    terminalRecoveryScan,
    replayQueue,
    complete,
    finalizeOperation,
    terminalizeAccepted,
    admitWorkspaceCapabilities,
    validateWorkspaceCapabilities,
    verifyRunnerAuthority,
    runnerPrincipal,
    hasConsumedRunnerAdmission,
    lockRemoteCreationAdmission,
    createRunnerAdmission,
    lockRunnerAdmission,
    consumeRunnerAdmission,
  })
})

export const layer = Layer.effect(HostedExecutionOperations, make)
