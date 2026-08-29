import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { and, asc, eq, exists, gt, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as HostedObservability from "@rika/product/hosted-observability"
import { Context, Effect, Layer, Schema } from "effect"
import {
  rikaHostedExecutorAssignments,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreads,
  rikaHostedWorkspacePreparations,
  rikaThreadQueueState,
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
  readonly preparedExecution: ExecutionGateway.PreparedTurn
  readonly admissionLink: ExecutionGateway.ExecutionLink
  readonly activationRequested: boolean
  readonly ownerId: string
  readonly claimedAt: number
  readonly input: { readonly threadId: string; readonly turnId: string }
}

export interface HostedTurnWorkerStoreService {
  readonly claimNext: (request: ClaimRequest) => Effect.Effect<TurnClaim | undefined, HostedTurnWorkerStoreError>
  readonly renew: (claim: TurnClaim, leaseMillis: number) => Effect.Effect<boolean, HostedTurnWorkerStoreError>
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
const PreparedTurnJson = Schema.fromJsonString(ExecutionGateway.PreparedTurn)
const ExecutionLinkJson = Schema.fromJsonString(ExecutionGateway.ExecutionLink)

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

export const layer = Layer.effect(
  HostedTurnWorkerStore,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults()

    const claimNext: HostedTurnWorkerStoreService["claimNext"] = Effect.fn("HostedTurnWorkerStore.claimNext")(
      function* (request) {
        const claimed = yield* transaction(db, (tx) =>
          Effect.gen(function* () {
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
            const activeCommand = alias(rikaHostedThreadProtocolCommands, "active_work_command")
            const activeWorkClaim = tx
              .select({ value: activeCommand.commandId })
              .from(activeCommand)
              .where(
                and(
                  eq(activeCommand.threadId, rikaHostedThreadProtocolCommands.threadId),
                  ne(activeCommand.commandId, rikaHostedThreadProtocolCommands.commandId),
                  sql`${activeCommand.workState} is not null`,
                  sql`${activeCommand.claimExpiresAt} > transaction_timestamp()`,
                ),
              )
            const row = (yield* query(
              tx
                .select({
                  ownerId: rikaHostedThreadProtocolCommands.ownerId,
                  threadId: rikaHostedThreadProtocolCommands.threadId,
                  commandId: rikaHostedThreadProtocolCommands.commandId,
                  turnId: rikaHostedThreadProtocolCommands.turnId,
                  workState: rikaHostedThreadProtocolCommands.workState,
                  preparedTurnJson: rikaHostedThreadProtocolCommands.preparedTurnJson,
                  admissionLinkJson: rikaTurns.executionLinkJson,
                  queuedAt: rikaTurns.createdAt,
                  status: rikaTurns.status,
                })
                .from(rikaHostedThreadProtocolCommands)
                .innerJoin(rikaTurns, eq(rikaTurns.id, rikaHostedThreadProtocolCommands.turnId))
                .innerJoin(
                  rikaHostedThreads,
                  and(
                    eq(rikaHostedThreads.id, rikaHostedThreadProtocolCommands.threadId),
                    eq(rikaHostedThreads.ownerId, rikaHostedThreadProtocolCommands.ownerId),
                  ),
                )
                .where(
                  and(
                    sql`${rikaHostedThreadProtocolCommands.workState} is not null`,
                    or(
                      isNull(rikaHostedThreadProtocolCommands.claimToken),
                      sql`${rikaHostedThreadProtocolCommands.claimExpiresAt} <= transaction_timestamp()`,
                    ),
                    or(
                      eq(rikaHostedThreadProtocolCommands.workState, "turn-activation-requested"),
                      eq(rikaTurns.status, "cancelled"),
                      and(
                        inArray(rikaTurns.status, ["accepted", "queued"]),
                        or(eq(rikaHostedThreads.executorKind, "runner"), readyExecutor(tx)),
                        sql`not exists (${activeLane})`,
                        sql`not exists (${activeWorkClaim})`,
                      ),
                    ),
                  ),
                )
                .orderBy(
                  sql`case ${rikaHostedThreadProtocolCommands.workState} when 'turn-activation-requested' then 0 else 1 end`,
                  asc(rikaHostedThreadProtocolCommands.completedAt),
                  asc(rikaHostedThreadProtocolCommands.commandId),
                )
                .limit(1)
                .for("update", { of: rikaHostedThreadProtocolCommands, skipLocked: true }),
            ))[0]
            if (
              row === undefined ||
              row.turnId === null ||
              row.workState === null ||
              row.preparedTurnJson === null ||
              row.admissionLinkJson === null
            )
              return undefined
            const updated = yield* query(
              tx
                .update(rikaHostedThreadProtocolCommands)
                .set({
                  claimToken: request.claimToken,
                  claimExpiresAt: sql`transaction_timestamp() + ${request.leaseMillis} * interval '1 millisecond'`,
                })
                .where(
                  and(
                    eq(rikaHostedThreadProtocolCommands.threadId, row.threadId),
                    eq(rikaHostedThreadProtocolCommands.commandId, row.commandId),
                  ),
                )
                .returning({
                  claimedAt: sql<number>`floor(extract(epoch from transaction_timestamp()) * 1000)::bigint`,
                  expiresAt: sql<number>`floor(extract(epoch from claim_expires_at) * 1000)::bigint`,
                }),
            )
            return {
              row,
              expiresAt: updated[0]!.expiresAt,
              claimedAt: updated[0]!.claimedAt,
            }
          }),
        )
        if (claimed === undefined) return undefined
        if (
          claimed.row.turnId === null ||
          claimed.row.preparedTurnJson === null ||
          claimed.row.admissionLinkJson === null
        )
          return yield* failure("Claimed activation work is incomplete")
        const preparedExecution = yield* Schema.decodeEffect(PreparedTurnJson)(claimed.row.preparedTurnJson).pipe(
          Effect.mapError(failure),
        )
        const admissionLink = yield* Schema.decodeEffect(ExecutionLinkJson)(claimed.row.admissionLinkJson).pipe(
          Effect.mapError(failure),
        )
        const turnClaim: TurnClaim = {
          workerId: request.workerId,
          claimToken: request.claimToken,
          expiresAt: claimed.expiresAt,
          preparedExecution,
          admissionLink,
          activationRequested: claimed.row.workState === "turn-activation-requested",
          ownerId: claimed.row.ownerId,
          claimedAt: claimed.claimedAt,
          input: { threadId: claimed.row.threadId, turnId: claimed.row.turnId },
        }
        yield* HostedObservability.event("turn_claim", "success", turnClaim.input)
        yield* HostedObservability.queueWaitObserved(turnClaim.input, turnClaim.claimedAt - claimed.row.queuedAt)
        return turnClaim
      },
    )

    const claimAuthority = (tx: PgDrizzle.EffectPgDatabase, claim: TurnClaim) =>
      query(
        tx
          .select({ commandId: rikaHostedThreadProtocolCommands.commandId })
          .from(rikaHostedThreadProtocolCommands)
          .where(
            and(
              eq(rikaHostedThreadProtocolCommands.turnId, claim.input.turnId),
              eq(rikaHostedThreadProtocolCommands.claimToken, claim.claimToken),
              sql`${rikaHostedThreadProtocolCommands.workState} is not null`,
              gt(rikaHostedThreadProtocolCommands.claimExpiresAt, sql`transaction_timestamp()`),
            ),
          )
          .for("update"),
      )

    const renew: HostedTurnWorkerStoreService["renew"] = (claim, leaseMillis) =>
      query(
        db
          .update(rikaHostedThreadProtocolCommands)
          .set({ claimExpiresAt: sql`transaction_timestamp() + ${leaseMillis} * interval '1 millisecond'` })
          .where(
            and(
              eq(rikaHostedThreadProtocolCommands.turnId, claim.input.turnId),
              eq(rikaHostedThreadProtocolCommands.claimToken, claim.claimToken),
              sql`${rikaHostedThreadProtocolCommands.workState} is not null`,
              gt(rikaHostedThreadProtocolCommands.claimExpiresAt, sql`transaction_timestamp()`),
            ),
          )
          .returning({ commandId: rikaHostedThreadProtocolCommands.commandId }),
      ).pipe(Effect.map((rows) => rows[0] !== undefined))

    const requestActivation: HostedTurnWorkerStoreService["requestActivation"] = Effect.fn(
      "HostedTurnWorkerStore.requestActivation",
    )(function* (claim, now) {
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          if ((yield* claimAuthority(tx, claim))[0] === undefined)
            return yield* failure("Turn claim is no longer owned by this worker")
          const turn = (yield* query(
            tx
              .select({ status: rikaTurns.status })
              .from(rikaTurns)
              .where(eq(rikaTurns.id, claim.input.turnId))
              .for("update"),
          ))[0]
          if (turn === undefined) return yield* failure("Claimed Turn does not exist")
          if (turn.status === "cancelled") return false
          if (turn.status === "queued") {
            const active = yield* query(
              tx
                .select({ id: rikaTurns.id })
                .from(rikaTurns)
                .where(
                  and(
                    eq(rikaTurns.threadId, claim.input.threadId),
                    ne(rikaTurns.id, claim.input.turnId),
                    inArray(rikaTurns.status, ["accepted", "running", "waiting", "cancelling"]),
                  ),
                )
                .limit(1),
            )
            if (active[0] !== undefined) return yield* failure("Thread execution lane is occupied")
            const queue = yield* query(
              tx
                .update(rikaThreadQueueState)
                .set({
                  revision: sql`${rikaThreadQueueState.revision} + 1`,
                  queuedCount: sql`greatest(${rikaThreadQueueState.queuedCount} - 1, 0)`,
                })
                .where(eq(rikaThreadQueueState.threadId, claim.input.threadId))
                .returning({ threadId: rikaThreadQueueState.threadId }),
            )
            if (queue[0] === undefined) return yield* failure("Turn queue state is missing")
            yield* query(
              tx
                .update(rikaTurns)
                .set({ status: "accepted", updatedAt: now })
                .where(eq(rikaTurns.id, claim.input.turnId)),
            )
          } else if (turn.status !== "accepted" && turn.status !== "running") {
            return yield* failure("Claimed Turn cannot be activated")
          }
          yield* query(
            tx
              .update(rikaHostedThreadProtocolCommands)
              .set({ workState: "turn-activation-requested" })
              .where(eq(rikaHostedThreadProtocolCommands.turnId, claim.input.turnId)),
          )
          return true
        }),
      )
    })

    const completeActivation: HostedTurnWorkerStoreService["completeActivation"] = Effect.fn(
      "HostedTurnWorkerStore.completeActivation",
    )(function* (claim, status, now) {
      yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          if ((yield* claimAuthority(tx, claim))[0] === undefined)
            return yield* failure("Turn claim is no longer owned by this worker")
          yield* query(
            tx
              .update(rikaTurns)
              .set({ status, updatedAt: now })
              .where(and(eq(rikaTurns.id, claim.input.turnId), eq(rikaTurns.status, "accepted"))),
          )
          yield* query(
            tx
              .update(rikaHostedThreadProtocolCommands)
              .set({ workState: null, claimToken: null, claimExpiresAt: null })
              .where(eq(rikaHostedThreadProtocolCommands.turnId, claim.input.turnId)),
          )
        }),
      )
    })

    const release: HostedTurnWorkerStoreService["release"] = (claim) =>
      query(
        db
          .update(rikaHostedThreadProtocolCommands)
          .set({ claimToken: null, claimExpiresAt: null })
          .where(
            and(
              eq(rikaHostedThreadProtocolCommands.turnId, claim.input.turnId),
              eq(rikaHostedThreadProtocolCommands.claimToken, claim.claimToken),
              sql`${rikaHostedThreadProtocolCommands.workState} is not null`,
            ),
          ),
      ).pipe(Effect.asVoid)

    return HostedTurnWorkerStore.of({ claimNext, renew, requestActivation, completeActivation, release })
  }),
)
