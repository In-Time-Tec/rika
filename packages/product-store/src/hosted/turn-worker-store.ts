import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { and, asc, eq, exists, gt, inArray, isNotNull, ne, notExists, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionStatus from "@rika/product/execution-status"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { PromptPart } from "@rika/product/execution-request"
import * as HostedObservability from "@rika/product/hosted-observability"
import { Context, Effect, Layer, Schema } from "effect"
import {
  rikaHostedExecutorAssignments,
  rikaHostedThreads,
  rikaHostedTurnClaims,
  rikaHostedWorkspacePreparations,
  rikaThreadQueueState,
  rikaThreads,
  rikaTurnAdmissionOutbox,
  rikaTurns,
} from "../database/schema/product"

export class HostedTurnWorkerStoreError extends Schema.TaggedError<HostedTurnWorkerStoreError>()(
  "HostedTurnWorkerStoreError",
  { message: Schema.String },
) {}

export interface ClaimRequest {
  readonly workerId: string
  readonly claimToken: string
  readonly leaseMillis: number
}

export interface TurnClaim {
  readonly workerId: string
  readonly claimToken: string
  readonly expiresAt: number
  readonly preparedExecution?: ExecutionGateway.PreparedTurn
  readonly admissionLink?: ExecutionGateway.ExecutionLink
  readonly activationRequested: boolean
  readonly ownerId: string
  readonly claimedAt: number
  readonly input: ExecutionGateway.StartTurn
}

export interface HostedTurnWorkerStoreService {
  readonly claimNext: (request: ClaimRequest) => Effect.Effect<TurnClaim | undefined, HostedTurnWorkerStoreError>
  readonly claimRecovery: (request: ClaimRequest) => Effect.Effect<TurnClaim | undefined, HostedTurnWorkerStoreError>
  readonly renew: (claim: TurnClaim, leaseMillis: number) => Effect.Effect<boolean, HostedTurnWorkerStoreError>
  readonly prepare: (
    claim: TurnClaim,
    prepared: ExecutionGateway.PreparedTurn,
    now: number,
  ) => Effect.Effect<boolean, HostedTurnWorkerStoreError>
  readonly completeAdmission: (
    claim: TurnClaim,
    link: ExecutionGateway.ExecutionLink,
    now: number,
  ) => Effect.Effect<void, HostedTurnWorkerStoreError>
  readonly requestActivation: (claim: TurnClaim, now: number) => Effect.Effect<boolean, HostedTurnWorkerStoreError>
  readonly completeActivation: (
    claim: TurnClaim,
    status: ExecutionStatus.ActivationStatus,
    now: number,
  ) => Effect.Effect<void, HostedTurnWorkerStoreError>
  readonly release: (claim: TurnClaim) => Effect.Effect<void, HostedTurnWorkerStoreError>
}

export class HostedTurnWorkerStore extends Context.Service<HostedTurnWorkerStore, HostedTurnWorkerStoreService>()(
  "@rika/product-store/hosted/turn-worker-store/HostedTurnWorkerStore",
) {}

const failure = (cause: unknown) =>
  HostedTurnWorkerStoreError.make({ message: `Turn worker store failed: ${String(cause)}` })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(failure))
const transaction = <A>(
  db: PgDrizzle.EffectPgDatabase,
  effect: (tx: PgDrizzle.EffectPgDatabase) => Effect.Effect<A, HostedTurnWorkerStoreError>,
) => db.transaction(effect).pipe(Effect.mapError(failure))
const ExecutionRouteJson = Schema.fromJsonString(ExecutionRouteSnapshot)
const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
const StartTurnJson = Schema.fromJsonString(ExecutionGateway.StartTurn)
const PreparedTurnJson = Schema.fromJsonString(ExecutionGateway.PreparedTurn)
const ExecutionLinkJson = Schema.fromJsonString(ExecutionGateway.ExecutionLink)

interface TurnRow {
  readonly ownerId: string
  readonly threadId: string
  readonly turnId: string
  readonly workspaceId: string
  readonly prompt: string
  readonly promptPartsJson: string | null
  readonly executionRouteJson: string | null
  readonly queuedAt: number
  readonly preparedTurnJson: string | null
  readonly admissionLinkJson: string | null
  readonly activationRequestedAt: number | null
}

const decodeInput = (row: TurnRow) =>
  Effect.gen(function* () {
    if (row.executionRouteJson === null) return yield* failure("Turn execution route is missing")
    const executionRoute = yield* Schema.decodeEffect(ExecutionRouteJson)(row.executionRouteJson)
    const promptParts =
      row.promptPartsJson === null ? undefined : yield* Schema.decodeEffect(PromptPartsJson)(row.promptPartsJson)
    const input = {
      threadId: row.threadId,
      turnId: row.turnId,
      workspaceId: row.workspaceId,
      prompt: row.prompt,
      executionRoute,
    }
    return yield* Schema.decodeEffect(ExecutionGateway.StartTurn)(
      promptParts === undefined ? input : { ...input, promptParts },
    )
  }).pipe(Effect.mapError(failure))

const readyExecutor = (db: PgDrizzle.EffectPgDatabase) =>
  exists(
    db
      .select({ value: rikaHostedExecutorAssignments.id })
      .from(rikaHostedExecutorAssignments)
      .innerJoin(
        rikaHostedWorkspacePreparations,
        and(
          eq(rikaHostedWorkspacePreparations.assignmentId, rikaHostedExecutorAssignments.id),
          eq(rikaHostedWorkspacePreparations.generation, rikaHostedExecutorAssignments.generation),
          eq(rikaHostedWorkspacePreparations.leaseEpoch, rikaHostedExecutorAssignments.leaseEpoch),
          eq(rikaHostedWorkspacePreparations.state, "ready"),
        ),
      )
      .where(
        and(
          eq(rikaHostedExecutorAssignments.threadId, rikaHostedThreads.id),
          eq(rikaHostedExecutorAssignments.lifecycle, "active"),
          gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      ),
  )

const claim = (
  db: PgDrizzle.EffectPgDatabase,
  request: ClaimRequest,
  source: (tx: PgDrizzle.EffectPgDatabase) => Effect.Effect<ReadonlyArray<TurnRow>, HostedTurnWorkerStoreError>,
) =>
  transaction(db, (tx) =>
    Effect.gen(function* () {
      const row = (yield* source(tx))[0]
      if (row === undefined) return undefined
      if (!Number.isFinite(row.queuedAt)) return yield* failure("Turn queue timestamp is invalid")
      const databaseNow = sql<number>`floor(extract(epoch from transaction_timestamp()) * 1000)::bigint`
      yield* query(
        tx
          .delete(rikaHostedTurnClaims)
          .where(
            and(
              eq(rikaHostedTurnClaims.threadId, row.threadId),
              sql`${rikaHostedTurnClaims.expiresAt} <= ${databaseNow}`,
            ),
          ),
      )
      const claims = yield* query(
        tx
          .insert(rikaHostedTurnClaims)
          .values({
            turnId: row.turnId,
            ownerId: row.ownerId,
            threadId: row.threadId,
            workerId: request.workerId,
            claimToken: request.claimToken,
            claimedAt: databaseNow,
            heartbeatAt: databaseNow,
            expiresAt: sql`${databaseNow} + ${request.leaseMillis}`,
          })
          .onConflictDoNothing()
          .returning({ claimedAt: rikaHostedTurnClaims.claimedAt, expiresAt: rikaHostedTurnClaims.expiresAt }),
      )
      const claimed = claims[0]
      if (claimed === undefined) return undefined
      const claimedAt = claimed.claimedAt
      const expiresAt = claimed.expiresAt
      const preparedExecution =
        row.preparedTurnJson === null
          ? undefined
          : yield* Schema.decodeEffect(PreparedTurnJson)(row.preparedTurnJson).pipe(Effect.mapError(failure))
      const admissionLink =
        row.admissionLinkJson === null
          ? undefined
          : yield* Schema.decodeEffect(ExecutionLinkJson)(row.admissionLinkJson).pipe(Effect.mapError(failure))
      const turnClaim: TurnClaim & { readonly queueWaitMillis: number } = {
        workerId: request.workerId,
        claimToken: request.claimToken,
        expiresAt,
        activationRequested: row.activationRequestedAt !== null,
        ownerId: row.ownerId,
        claimedAt,
        input: yield* decodeInput(row),
        queueWaitMillis: claimedAt - row.queuedAt,
      }
      if (preparedExecution !== undefined) Object.assign(turnClaim, { preparedExecution })
      if (admissionLink !== undefined) Object.assign(turnClaim, { admissionLink })
      return turnClaim
    }),
  ).pipe(
    Effect.tap((turnClaim) =>
      turnClaim === undefined
        ? Effect.void
        : HostedObservability.event("turn_claim", "success", {
            threadId: turnClaim.input.threadId,
            turnId: turnClaim.input.turnId,
          }).pipe(
            Effect.andThen(
              HostedObservability.queueWaitObserved(
                { threadId: turnClaim.input.threadId, turnId: turnClaim.input.turnId },
                turnClaim.queueWaitMillis,
              ),
            ),
          ),
    ),
    Effect.map((turnClaim) => {
      if (turnClaim === undefined) return undefined
      const { queueWaitMillis: _, ...claimedTurn } = turnClaim
      return claimedTurn
    }),
  )

export const layer = Layer.effect(
  HostedTurnWorkerStore,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults()
    const claimNext: HostedTurnWorkerStoreService["claimNext"] = (request) =>
      claim(db, request, (tx) => {
        const claimedTurn = alias(rikaTurns, "claimed_turn")
        const activeClaim = tx
          .select({ value: rikaHostedTurnClaims.turnId })
          .from(rikaHostedTurnClaims)
          .innerJoin(claimedTurn, eq(claimedTurn.id, rikaHostedTurnClaims.turnId))
          .where(
            and(
              eq(claimedTurn.threadId, rikaTurns.threadId),
              gt(rikaHostedTurnClaims.expiresAt, sql`floor(extract(epoch from transaction_timestamp()) * 1000)`),
            ),
          )
        const activeTurn = alias(rikaTurns, "active_turn")
        const activeLane = tx
          .select({ value: activeTurn.id })
          .from(activeTurn)
          .where(
            and(
              eq(activeTurn.threadId, rikaTurns.threadId),
              eq(activeTurn.turnKind, "AgentExecution"),
              ne(activeTurn.id, rikaTurns.id),
              inArray(activeTurn.status, ["accepted", "running", "waiting", "cancelling"]),
            ),
          )
        return query(
          tx
            .select({
              ownerId: rikaThreads.ownerId,
              threadId: rikaTurns.threadId,
              turnId: rikaTurns.id,
              workspaceId: rikaHostedThreads.workspaceId,
              prompt: rikaTurns.prompt,
              promptPartsJson: rikaTurns.promptPartsJson,
              executionRouteJson: rikaTurns.executionRouteJson,
              queuedAt: rikaTurns.createdAt,
              preparedTurnJson: sql<string | null>`null`,
              admissionLinkJson: sql<string | null>`null`,
              activationRequestedAt: sql<number | null>`null`,
            })
            .from(rikaTurns)
            .innerJoin(rikaThreads, eq(rikaThreads.id, rikaTurns.threadId))
            .innerJoin(
              rikaHostedThreads,
              and(eq(rikaHostedThreads.id, rikaTurns.threadId), eq(rikaHostedThreads.ownerId, rikaThreads.ownerId)),
            )
            .where(
              and(
                eq(rikaTurns.turnKind, "AgentExecution"),
                inArray(rikaTurns.status, ["accepted", "queued"]),
                notExists(activeClaim),
                notExists(activeLane),
              ),
            )
            .orderBy(
              sql`case ${rikaTurns.status} when 'accepted' then 0 else 1 end`,
              asc(rikaTurns.createdAt),
              asc(rikaTurns.id),
            )
            .limit(1)
            .for("update", { of: rikaTurns, skipLocked: true }),
        )
      })
    const claimRecovery: HostedTurnWorkerStoreService["claimRecovery"] = (request) =>
      claim(db, request, (tx) =>
        query(
          tx
            .select({
              ownerId: rikaThreads.ownerId,
              threadId: rikaTurns.threadId,
              turnId: rikaTurns.id,
              workspaceId: rikaHostedThreads.workspaceId,
              prompt: rikaTurns.prompt,
              promptPartsJson: rikaTurns.promptPartsJson,
              executionRouteJson: rikaTurns.executionRouteJson,
              queuedAt: rikaTurnAdmissionOutbox.preparedAt,
              preparedTurnJson: rikaTurnAdmissionOutbox.preparedTurnJson,
              admissionLinkJson: rikaTurnAdmissionOutbox.admissionLinkJson,
              activationRequestedAt: rikaTurnAdmissionOutbox.activationRequestedAt,
            })
            .from(rikaTurnAdmissionOutbox)
            .innerJoin(rikaTurns, eq(rikaTurns.id, rikaTurnAdmissionOutbox.turnId))
            .innerJoin(rikaThreads, eq(rikaThreads.id, rikaTurns.threadId))
            .innerJoin(
              rikaHostedThreads,
              and(eq(rikaHostedThreads.id, rikaTurns.threadId), eq(rikaHostedThreads.ownerId, rikaThreads.ownerId)),
            )
            .where(
              and(
                eq(rikaTurns.turnKind, "AgentExecution"),
                inArray(rikaTurns.status, ["accepted", "running", "cancelling", "cancelled"]),
                isNotNull(rikaTurnAdmissionOutbox.preparedTurnJson),
                or(eq(rikaTurns.status, "cancelled"), eq(rikaHostedThreads.executorKind, "runner"), readyExecutor(tx)),
                notExists(
                  tx
                    .select({ value: rikaHostedTurnClaims.turnId })
                    .from(rikaHostedTurnClaims)
                    .where(
                      and(
                        eq(rikaHostedTurnClaims.turnId, rikaTurns.id),
                        gt(
                          rikaHostedTurnClaims.expiresAt,
                          sql`floor(extract(epoch from transaction_timestamp()) * 1000)`,
                        ),
                      ),
                    ),
                ),
              ),
            )
            .orderBy(asc(rikaTurnAdmissionOutbox.preparedAt), asc(rikaTurnAdmissionOutbox.turnId))
            .limit(1)
            .for("update", { of: rikaTurns, skipLocked: true }),
        ),
      )
    const renew: HostedTurnWorkerStoreService["renew"] = Effect.fn("HostedTurnWorkerStore.renew")(
      function* (turnClaim, leaseMillis) {
        const databaseNow = sql<number>`floor(extract(epoch from transaction_timestamp()) * 1000)::bigint`
        const renewed = yield* query(
          db
            .update(rikaHostedTurnClaims)
            .set({ heartbeatAt: databaseNow, expiresAt: sql`${databaseNow} + ${leaseMillis}` })
            .where(
              and(
                eq(rikaHostedTurnClaims.turnId, turnClaim.input.turnId),
                eq(rikaHostedTurnClaims.workerId, turnClaim.workerId),
                eq(rikaHostedTurnClaims.claimToken, turnClaim.claimToken),
                gt(rikaHostedTurnClaims.expiresAt, databaseNow),
              ),
            )
            .returning({ turnId: rikaHostedTurnClaims.turnId }),
        )
        return renewed[0] !== undefined
      },
    )
    const prepare: HostedTurnWorkerStoreService["prepare"] = Effect.fn("HostedTurnWorkerStore.prepare")(
      function* (turnClaim, prepared, now) {
        if (prepared.turnId !== turnClaim.input.turnId || prepared.threadId !== turnClaim.input.threadId)
          return yield* failure("Prepared execution does not identify the claimed Turn")
        const encoded = yield* Schema.encodeEffect(StartTurnJson)(turnClaim.input).pipe(Effect.mapError(failure))
        const encodedPrepared = yield* Schema.encodeEffect(PreparedTurnJson)(prepared).pipe(Effect.mapError(failure))
        return yield* transaction(db, (tx) =>
          Effect.gen(function* () {
            const authority = yield* query(
              tx
                .select({ turnId: rikaHostedTurnClaims.turnId })
                .from(rikaHostedTurnClaims)
                .where(
                  and(
                    eq(rikaHostedTurnClaims.turnId, turnClaim.input.turnId),
                    eq(rikaHostedTurnClaims.workerId, turnClaim.workerId),
                    eq(rikaHostedTurnClaims.claimToken, turnClaim.claimToken),
                    gt(rikaHostedTurnClaims.expiresAt, sql`floor(extract(epoch from transaction_timestamp()) * 1000)`),
                  ),
                )
                .for("update"),
            )
            if (authority[0] === undefined) return false
            const lane = yield* query(
              tx
                .select({ status: rikaTurns.status })
                .from(rikaTurns)
                .where(
                  and(
                    eq(rikaTurns.id, turnClaim.input.turnId),
                    eq(rikaTurns.threadId, turnClaim.input.threadId),
                    eq(rikaTurns.turnKind, "AgentExecution"),
                    inArray(rikaTurns.status, ["accepted", "queued"]),
                  ),
                )
                .for("update"),
            )
            if (lane[0] === undefined) {
              const existingPreparation = yield* query(
                tx
                  .select({ turnId: rikaTurnAdmissionOutbox.turnId })
                  .from(rikaTurnAdmissionOutbox)
                  .where(eq(rikaTurnAdmissionOutbox.turnId, turnClaim.input.turnId)),
              )
              return existingPreparation[0] !== undefined
            }
            const transitioned = yield* query(
              tx
                .update(rikaTurns)
                .set({ status: "accepted", updatedAt: now, queueClaimToken: null })
                .where(
                  and(
                    eq(rikaTurns.id, turnClaim.input.turnId),
                    eq(rikaTurns.threadId, turnClaim.input.threadId),
                    eq(rikaTurns.turnKind, "AgentExecution"),
                    eq(rikaTurns.status, lane[0].status),
                  ),
                )
                .returning({ threadId: rikaTurns.threadId }),
            )
            if (transitioned[0] === undefined) return false
            if (lane[0].status === "queued") {
              const queue = yield* query(
                tx
                  .update(rikaThreadQueueState)
                  .set({
                    revision: sql`${rikaThreadQueueState.revision} + 1`,
                    queuedCount: sql`case when ${rikaThreadQueueState.queuedCount} > 0 then ${rikaThreadQueueState.queuedCount} - 1 else 0 end`,
                  })
                  .where(eq(rikaThreadQueueState.threadId, turnClaim.input.threadId))
                  .returning({
                    threadId: rikaThreadQueueState.threadId,
                  }),
              )
              if (queue[0] === undefined) return yield* failure("Turn queue state is missing")
            }
            yield* query(
              tx
                .insert(rikaTurnAdmissionOutbox)
                .values({
                  turnId: turnClaim.input.turnId,
                  startInputJson: encoded,
                  preparedTurnJson: encodedPrepared,
                  preparedAt: now,
                })
                .onConflictDoNothing(),
            )
            const persisted = (yield* query(
              tx
                .select({
                  startInputJson: rikaTurnAdmissionOutbox.startInputJson,
                  preparedTurnJson: rikaTurnAdmissionOutbox.preparedTurnJson,
                })
                .from(rikaTurnAdmissionOutbox)
                .where(eq(rikaTurnAdmissionOutbox.turnId, turnClaim.input.turnId)),
            ))[0]
            if (persisted?.preparedTurnJson === null || persisted === undefined)
              return yield* failure("Turn has an incomplete legacy execution admission")
            const persistedInput = yield* Schema.decodeEffect(StartTurnJson)(persisted.startInputJson).pipe(
              Effect.mapError(failure),
            )
            const persistedPrepared = yield* Schema.decodeEffect(PreparedTurnJson)(persisted.preparedTurnJson).pipe(
              Effect.mapError(failure),
            )
            if (!Schema.toEquivalence(ExecutionGateway.StartTurn)(persistedInput, turnClaim.input))
              return yield* failure("Turn already has a different start input")
            if (!Schema.toEquivalence(ExecutionGateway.PreparedTurn)(persistedPrepared, prepared))
              return yield* failure("Turn already has a different prepared execution")
            return true
          }),
        )
      },
    )
    const completeAdmission: HostedTurnWorkerStoreService["completeAdmission"] = Effect.fn(
      "HostedTurnWorkerStore.completeAdmission",
    )(function* (turnClaim, link, now) {
      if (link.turnId !== turnClaim.input.turnId || link.threadId !== turnClaim.input.threadId)
        return yield* failure("Execution link does not identify the claimed Turn")
      const encoded = yield* Schema.encodeEffect(ExecutionLinkJson)(link).pipe(Effect.mapError(failure))
      yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const authority = yield* query(
            tx
              .select({ turnId: rikaHostedTurnClaims.turnId })
              .from(rikaHostedTurnClaims)
              .where(
                and(
                  eq(rikaHostedTurnClaims.turnId, turnClaim.input.turnId),
                  eq(rikaHostedTurnClaims.workerId, turnClaim.workerId),
                  eq(rikaHostedTurnClaims.claimToken, turnClaim.claimToken),
                  gt(rikaHostedTurnClaims.expiresAt, sql`floor(extract(epoch from transaction_timestamp()) * 1000)`),
                ),
              )
              .for("update"),
          )
          if (authority[0] === undefined) return yield* failure("Turn claim is no longer owned by this worker")
          const rows = yield* query(
            tx
              .select({ executionLinkJson: rikaTurnAdmissionOutbox.admissionLinkJson })
              .from(rikaTurnAdmissionOutbox)
              .where(eq(rikaTurnAdmissionOutbox.turnId, turnClaim.input.turnId))
              .for("update"),
          )
          const existing = rows[0]
          if (existing === undefined) return yield* failure("Claimed Turn does not exist")
          if (existing.executionLinkJson !== null) {
            const persisted = yield* Schema.decodeEffect(ExecutionLinkJson)(existing.executionLinkJson).pipe(
              Effect.mapError(failure),
            )
            if (!Schema.toEquivalence(ExecutionGateway.ExecutionLink)(persisted, link))
              return yield* failure("Claimed Turn already has a different execution link")
          } else {
            yield* query(
              tx
                .update(rikaTurnAdmissionOutbox)
                .set({ admissionLinkJson: encoded, admittedAt: now })
                .where(eq(rikaTurnAdmissionOutbox.turnId, turnClaim.input.turnId)),
            )
          }
        }),
      )
    })
    const requestActivation: HostedTurnWorkerStoreService["requestActivation"] = Effect.fn(
      "HostedTurnWorkerStore.requestActivation",
    )(function* (turnClaim, now) {
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const authority = yield* query(
            tx
              .select({ turnId: rikaHostedTurnClaims.turnId })
              .from(rikaHostedTurnClaims)
              .where(
                and(
                  eq(rikaHostedTurnClaims.turnId, turnClaim.input.turnId),
                  eq(rikaHostedTurnClaims.workerId, turnClaim.workerId),
                  eq(rikaHostedTurnClaims.claimToken, turnClaim.claimToken),
                  gt(rikaHostedTurnClaims.expiresAt, sql`floor(extract(epoch from transaction_timestamp()) * 1000)`),
                ),
              )
              .for("update"),
          )
          if (authority[0] === undefined) return yield* failure("Turn claim is no longer owned by this worker")
          const admission = (yield* query(
            tx
              .select({
                link: rikaTurnAdmissionOutbox.admissionLinkJson,
                requestedAt: rikaTurnAdmissionOutbox.activationRequestedAt,
              })
              .from(rikaTurnAdmissionOutbox)
              .where(eq(rikaTurnAdmissionOutbox.turnId, turnClaim.input.turnId))
              .for("update"),
          ))[0]
          if (admission?.link === null || admission === undefined)
            return yield* failure("Turn has no staged Runtime admission")
          const turn = (yield* query(
            tx
              .select({ status: rikaTurns.status, executionLinkJson: rikaTurns.executionLinkJson })
              .from(rikaTurns)
              .where(and(eq(rikaTurns.id, turnClaim.input.turnId), eq(rikaTurns.threadId, turnClaim.input.threadId)))
              .for("update"),
          ))[0]
          if (turn === undefined) return yield* failure("Claimed Turn does not exist")
          if (turn.status !== "accepted" && turn.status !== "running") return false
          if (admission.requestedAt !== null) {
            if (turn.executionLinkJson !== admission.link)
              return yield* failure("Activated Turn execution link does not match its staged admission")
            return true
          }
          if (turn.status !== "accepted") return yield* failure("Running Turn has no durable activation request")
          const activated = yield* query(
            tx
              .update(rikaTurns)
              .set({ executionLinkJson: admission.link, updatedAt: now })
              .where(and(eq(rikaTurns.id, turnClaim.input.turnId), eq(rikaTurns.status, "accepted")))
              .returning({ id: rikaTurns.id }),
          )
          if (activated[0] === undefined) return false
          yield* query(
            tx
              .update(rikaTurnAdmissionOutbox)
              .set({ activationRequestedAt: now })
              .where(eq(rikaTurnAdmissionOutbox.turnId, turnClaim.input.turnId)),
          )
          return true
        }),
      )
    })
    const completeActivation: HostedTurnWorkerStoreService["completeActivation"] = Effect.fn(
      "HostedTurnWorkerStore.completeActivation",
    )(function* (turnClaim, status, now) {
      yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const authority = yield* query(
            tx
              .select({ turnId: rikaHostedTurnClaims.turnId })
              .from(rikaHostedTurnClaims)
              .where(
                and(
                  eq(rikaHostedTurnClaims.turnId, turnClaim.input.turnId),
                  eq(rikaHostedTurnClaims.workerId, turnClaim.workerId),
                  eq(rikaHostedTurnClaims.claimToken, turnClaim.claimToken),
                  gt(rikaHostedTurnClaims.expiresAt, sql`floor(extract(epoch from transaction_timestamp()) * 1000)`),
                ),
              )
              .for("update"),
          )
          if (authority[0] === undefined) return yield* failure("Turn claim is no longer owned by this worker")
          yield* query(
            tx
              .update(rikaTurns)
              .set({ status, updatedAt: now })
              .where(and(eq(rikaTurns.id, turnClaim.input.turnId), eq(rikaTurns.status, "accepted"))),
          )
          yield* query(
            tx.delete(rikaTurnAdmissionOutbox).where(eq(rikaTurnAdmissionOutbox.turnId, turnClaim.input.turnId)),
          )
          yield* query(
            tx
              .delete(rikaHostedTurnClaims)
              .where(
                and(
                  eq(rikaHostedTurnClaims.turnId, turnClaim.input.turnId),
                  eq(rikaHostedTurnClaims.workerId, turnClaim.workerId),
                  eq(rikaHostedTurnClaims.claimToken, turnClaim.claimToken),
                ),
              ),
          )
        }),
      )
    })
    const release: HostedTurnWorkerStoreService["release"] = Effect.fn("HostedTurnWorkerStore.release")(
      function* (turnClaim) {
        yield* query(
          db.delete(rikaHostedTurnClaims).where(
            and(
              eq(rikaHostedTurnClaims.turnId, turnClaim.input.turnId),
              eq(rikaHostedTurnClaims.workerId, turnClaim.workerId),
              eq(rikaHostedTurnClaims.claimToken, turnClaim.claimToken),
              exists(
                db
                  .select({ value: rikaTurns.id })
                  .from(rikaTurns)
                  .where(
                    and(eq(rikaTurns.id, turnClaim.input.turnId), inArray(rikaTurns.status, ["accepted", "queued"])),
                  ),
              ),
            ),
          ),
        ).pipe(Effect.asVoid)
      },
    )
    return HostedTurnWorkerStore.of({
      claimNext,
      claimRecovery,
      renew,
      prepare,
      completeAdmission,
      requestActivation,
      completeActivation,
      release,
    })
  }),
)
