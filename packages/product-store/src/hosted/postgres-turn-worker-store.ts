import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { and, asc, eq, exists, gt, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import * as ExecutionGateway from "@rika/product/execution-gateway"
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
  readonly now: number
  readonly leaseMillis: number
}

export interface TurnClaim {
  readonly workerId: string
  readonly claimToken: string
  readonly expiresAt: number
  readonly prepared: boolean
  readonly ownerId: string
  readonly claimedAt: number
  readonly input: ExecutionGateway.StartTurn
}

export interface HostedTurnWorkerStoreService {
  readonly claimNext: (request: ClaimRequest) => Effect.Effect<TurnClaim | undefined, HostedTurnWorkerStoreError>
  readonly claimRecovery: (request: ClaimRequest) => Effect.Effect<TurnClaim | undefined, HostedTurnWorkerStoreError>
  readonly prepare: (claim: TurnClaim, now: number) => Effect.Effect<boolean, HostedTurnWorkerStoreError>
  readonly renew: (
    claim: TurnClaim,
    now: number,
    leaseMillis: number,
  ) => Effect.Effect<boolean, HostedTurnWorkerStoreError>
  readonly complete: (
    claim: TurnClaim,
    link: ExecutionGateway.ExecutionLink,
    now: number,
  ) => Effect.Effect<void, HostedTurnWorkerStoreError>
  readonly release: (claim: TurnClaim) => Effect.Effect<void, HostedTurnWorkerStoreError>
}

export class HostedTurnWorkerStore extends Context.Service<HostedTurnWorkerStore, HostedTurnWorkerStoreService>()(
  "@rika/product-store/hosted/postgres-turn-worker-store/HostedTurnWorkerStore",
) {}

const failure = (cause: unknown) =>
  HostedTurnWorkerStoreError.make({ message: `Hosted Turn worker store failed: ${String(cause)}` })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(failure))
const transaction = <A>(
  db: PgDrizzle.EffectPgDatabase,
  effect: (tx: PgDrizzle.EffectPgDatabase) => Effect.Effect<A, HostedTurnWorkerStoreError>,
) => db.transaction(effect).pipe(Effect.mapError(failure))
const ExecutionRouteJson = Schema.fromJsonString(ExecutionRouteSnapshot)
const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
const StartTurnJson = Schema.fromJsonString(ExecutionGateway.StartTurn)
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
  prepared: boolean,
) =>
  transaction(db, (tx) =>
    Effect.gen(function* () {
      const row = (yield* source(tx))[0]
      if (row === undefined) return undefined
      if (!Number.isFinite(row.queuedAt)) return yield* failure("Turn queue timestamp is invalid")
      yield* query(
        tx
          .delete(rikaHostedTurnClaims)
          .where(
            and(
              eq(rikaHostedTurnClaims.threadId, row.threadId),
              sql`${rikaHostedTurnClaims.expiresAt} <= ${request.now}`,
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
            claimedAt: request.now,
            heartbeatAt: request.now,
            expiresAt: request.now + request.leaseMillis,
          })
          .onConflictDoNothing()
          .returning({ turnId: rikaHostedTurnClaims.turnId }),
      )
      if (claims[0] === undefined) return undefined
      return {
        workerId: request.workerId,
        claimToken: request.claimToken,
        expiresAt: request.now + request.leaseMillis,
        prepared,
        ownerId: row.ownerId,
        claimedAt: request.now,
        input: yield* decodeInput(row),
        queueWaitMillis: request.now - row.queuedAt,
      }
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
      claim(
        db,
        request,
        (tx) => {
          const claimedTurn = alias(rikaTurns, "claimed_turn")
          const activeClaim = tx
            .select({ value: rikaHostedTurnClaims.turnId })
            .from(rikaHostedTurnClaims)
            .innerJoin(claimedTurn, eq(claimedTurn.id, rikaHostedTurnClaims.turnId))
            .where(and(eq(claimedTurn.threadId, rikaTurns.threadId), gt(rikaHostedTurnClaims.expiresAt, request.now)))
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
                  or(eq(rikaHostedThreads.executorKind, "runner"), readyExecutor(tx)),
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
        },
        false,
      )
    const claimRecovery: HostedTurnWorkerStoreService["claimRecovery"] = (request) =>
      claim(
        db,
        request,
        (tx) =>
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
                  eq(rikaTurns.status, "running"),
                  isNull(rikaTurns.executionLinkJson),
                  or(eq(rikaHostedThreads.executorKind, "runner"), readyExecutor(tx)),
                  notExists(
                    tx
                      .select({ value: rikaHostedTurnClaims.turnId })
                      .from(rikaHostedTurnClaims)
                      .where(
                        and(
                          eq(rikaHostedTurnClaims.turnId, rikaTurns.id),
                          gt(rikaHostedTurnClaims.expiresAt, request.now),
                        ),
                      ),
                  ),
                ),
              )
              .orderBy(asc(rikaTurnAdmissionOutbox.preparedAt), asc(rikaTurnAdmissionOutbox.turnId))
              .limit(1)
              .for("update", { of: rikaTurns, skipLocked: true }),
          ),
        true,
      )
    const prepare: HostedTurnWorkerStoreService["prepare"] = Effect.fn("HostedTurnWorkerStore.prepare")(
      function* (turnClaim, now) {
        const encoded = yield* Schema.encodeEffect(StartTurnJson)(turnClaim.input).pipe(Effect.mapError(failure))
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
                    gt(rikaHostedTurnClaims.expiresAt, now),
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
              const prepared = yield* query(
                tx
                  .select({ turnId: rikaTurnAdmissionOutbox.turnId })
                  .from(rikaTurnAdmissionOutbox)
                  .where(eq(rikaTurnAdmissionOutbox.turnId, turnClaim.input.turnId)),
              )
              return prepared[0] !== undefined
            }
            const transitioned = yield* query(
              tx
                .update(rikaTurns)
                .set({ status: "running", updatedAt: now, queueClaimToken: null })
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
              tx.insert(rikaTurnAdmissionOutbox).values({
                turnId: turnClaim.input.turnId,
                startInputJson: encoded,
                preparedAt: now,
              }),
            )
            return true
          }),
        )
      },
    )
    const renew: HostedTurnWorkerStoreService["renew"] = Effect.fn("HostedTurnWorkerStore.renew")(
      function* (turnClaim, now, leaseMillis) {
        const rows = yield* query(
          db
            .update(rikaHostedTurnClaims)
            .set({ heartbeatAt: now, expiresAt: now + leaseMillis })
            .where(
              and(
                eq(rikaHostedTurnClaims.turnId, turnClaim.input.turnId),
                eq(rikaHostedTurnClaims.workerId, turnClaim.workerId),
                eq(rikaHostedTurnClaims.claimToken, turnClaim.claimToken),
                gt(rikaHostedTurnClaims.expiresAt, now),
              ),
            )
            .returning({ turnId: rikaHostedTurnClaims.turnId }),
        )
        return rows[0] !== undefined
      },
    )
    const complete: HostedTurnWorkerStoreService["complete"] = Effect.fn("HostedTurnWorkerStore.complete")(
      function* (turnClaim, link, now) {
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
                  ),
                )
                .for("update"),
            )
            if (authority[0] === undefined) return yield* failure("Turn claim is no longer owned by this worker")
            const rows = yield* query(
              tx
                .select({ executionLinkJson: rikaTurns.executionLinkJson })
                .from(rikaTurns)
                .where(and(eq(rikaTurns.id, turnClaim.input.turnId), eq(rikaTurns.threadId, turnClaim.input.threadId)))
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
                  .update(rikaTurns)
                  .set({ executionLinkJson: encoded, updatedAt: now })
                  .where(eq(rikaTurns.id, turnClaim.input.turnId)),
              )
            }
            yield* query(
              tx.delete(rikaTurnAdmissionOutbox).where(eq(rikaTurnAdmissionOutbox.turnId, turnClaim.input.turnId)),
            )
            yield* query(
              tx
                .delete(rikaHostedTurnClaims)
                .where(
                  and(
                    eq(rikaHostedTurnClaims.turnId, turnClaim.input.turnId),
                    eq(rikaHostedTurnClaims.claimToken, turnClaim.claimToken),
                  ),
                ),
            )
          }),
        )
      },
    )
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
    return HostedTurnWorkerStore.of({ claimNext, claimRecovery, prepare, renew, complete, release })
  }),
)
