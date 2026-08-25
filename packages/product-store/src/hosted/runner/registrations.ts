import * as PgClient from "@effect/sql-pg/PgClient"
import type { RunnerProfile } from "@rika/product/runner-registration"
import { and, asc, eq, inArray, isNull, lte, not, or, sql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Context, Effect, Layer, Schema } from "effect"
import { rikaHostedExecutorAssignments, rikaHostedRunnerRegistrations } from "../../database/schema/product"

export class RunnerRegistrationsError extends Schema.TaggedError<RunnerRegistrationsError>()(
  "RunnerRegistrationsError",
  { message: Schema.String },
) {}

export interface RunnerAssignmentPoll {
  readonly assignmentId: string
  readonly threadId: string
  readonly workspaceId: string
  readonly resume: boolean
  readonly leaseExpiresAt: number | null
}

export type SupervisorPoll =
  | { readonly claimed: false }
  | { readonly claimed: true; readonly assignment?: RunnerAssignmentPoll }

export interface RunnerRegistrationsService {
  readonly upsert: (input: {
    readonly deviceId: string
    readonly userId: string
    readonly checkoutFingerprint: string
    readonly profile: RunnerProfile
  }) => Effect.Effect<"stored" | "user-mismatch", RunnerRegistrationsError>
  readonly setRemoteThreadCreation: (input: {
    readonly deviceId: string
    readonly userId: string
    readonly checkoutFingerprint: string
    readonly allowed: boolean
  }) => Effect.Effect<boolean, RunnerRegistrationsError>
  readonly claimSupervisorAndPoll: (input: {
    readonly deviceId: string
    readonly userId: string
    readonly checkoutFingerprint: string
    readonly supervisorId: string
    readonly activeAssignmentIds: ReadonlyArray<string>
  }) => Effect.Effect<SupervisorPoll, RunnerRegistrationsError>
}

export class RunnerRegistrations extends Context.Service<RunnerRegistrations, RunnerRegistrationsService>()(
  "@rika/product-store/hosted/runner/registrations/RunnerRegistrations",
) {}

const databaseError = (cause: unknown) =>
  RunnerRegistrationsError.make({
    message: `Runner registration database operation failed: ${String(cause)}`,
  })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))

const make = Effect.gen(function* () {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()

  const upsert: RunnerRegistrationsService["upsert"] = (input) =>
    query(
      db
        .insert(rikaHostedRunnerRegistrations)
        .values({
          deviceId: input.deviceId,
          userId: input.userId,
          checkoutFingerprint: input.checkoutFingerprint,
          workspaceId: input.profile.workspaceIdentity,
          projectId: input.profile.projectId ?? null,
          repository: input.profile.repository,
          kernelProfile: input.profile.kernel,
          capabilities: input.profile.capabilities,
        })
        .onConflictDoUpdate({
          target: [rikaHostedRunnerRegistrations.deviceId, rikaHostedRunnerRegistrations.checkoutFingerprint],
          set: {
            workspaceId: input.profile.workspaceIdentity,
            projectId: input.profile.projectId ?? null,
            repository: input.profile.repository,
            kernelProfile: input.profile.kernel,
            capabilities: input.profile.capabilities,
            updatedAt: sql`transaction_timestamp()`,
          },
          setWhere: eq(rikaHostedRunnerRegistrations.userId, input.userId),
        })
        .returning({ deviceId: rikaHostedRunnerRegistrations.deviceId }),
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? "user-mismatch" : "stored")))

  const setRemoteThreadCreation: RunnerRegistrationsService["setRemoteThreadCreation"] = (input) =>
    query(
      db
        .update(rikaHostedRunnerRegistrations)
        .set({
          remoteThreadCreationAllowed: input.allowed,
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(
          and(
            eq(rikaHostedRunnerRegistrations.deviceId, input.deviceId),
            eq(rikaHostedRunnerRegistrations.userId, input.userId),
            eq(rikaHostedRunnerRegistrations.checkoutFingerprint, input.checkoutFingerprint),
          ),
        )
        .returning({ deviceId: rikaHostedRunnerRegistrations.deviceId }),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))

  const claimSupervisorAndPoll: RunnerRegistrationsService["claimSupervisorAndPoll"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const claimed = yield* query(
            tx
              .update(rikaHostedRunnerRegistrations)
              .set({
                supervisorId: input.supervisorId,
                supervisorExpiresAt: sql`clock_timestamp() + interval '10 seconds'`,
                updatedAt: sql`transaction_timestamp()`,
              })
              .where(
                and(
                  eq(rikaHostedRunnerRegistrations.deviceId, input.deviceId),
                  eq(rikaHostedRunnerRegistrations.checkoutFingerprint, input.checkoutFingerprint),
                  eq(rikaHostedRunnerRegistrations.userId, input.userId),
                  or(
                    eq(rikaHostedRunnerRegistrations.supervisorId, input.supervisorId),
                    isNull(rikaHostedRunnerRegistrations.supervisorExpiresAt),
                    lte(rikaHostedRunnerRegistrations.supervisorExpiresAt, sql`clock_timestamp()`),
                  ),
                ),
              )
              .returning({ deviceId: rikaHostedRunnerRegistrations.deviceId }),
          )
          if (claimed[0] === undefined) return { claimed: false as const }
          const resume = sql<boolean>`${rikaHostedExecutorAssignments.lifecycle} = 'active' AND ${rikaHostedExecutorAssignments.leaseExpiresAt} > clock_timestamp()`
          const activeOrder = sql`CASE WHEN ${rikaHostedExecutorAssignments.lifecycle} = 'active' THEN ${rikaHostedExecutorAssignments.lastActiveAt} ELSE ${rikaHostedExecutorAssignments.createdAt} END`
          const assignment = (yield* query(
            tx
              .select({
                assignmentId: rikaHostedExecutorAssignments.id,
                threadId: rikaHostedExecutorAssignments.threadId,
                workspaceId: rikaHostedExecutorAssignments.workspaceId,
                resume,
                leaseExpiresAt: sql<
                  number | null
                >`(extract(epoch FROM ${rikaHostedExecutorAssignments.leaseExpiresAt}) * 1000)::float8`,
              })
              .from(rikaHostedExecutorAssignments)
              .innerJoin(
                rikaHostedRunnerRegistrations,
                and(
                  eq(rikaHostedRunnerRegistrations.deviceId, input.deviceId),
                  eq(rikaHostedRunnerRegistrations.checkoutFingerprint, input.checkoutFingerprint),
                  eq(rikaHostedRunnerRegistrations.userId, input.userId),
                ),
              )
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.executorKind, "runner"),
                  input.activeAssignmentIds.length === 0
                    ? sql`true`
                    : not(inArray(rikaHostedExecutorAssignments.id, input.activeAssignmentIds)),
                  or(
                    inArray(rikaHostedExecutorAssignments.lifecycle, ["pending", "paused"]),
                    and(
                      inArray(rikaHostedExecutorAssignments.lifecycle, ["provisioning", "awaiting_bootstrap"]),
                      lte(rikaHostedExecutorAssignments.bootstrapExpiresAt, sql`clock_timestamp()`),
                    ),
                    eq(rikaHostedExecutorAssignments.lifecycle, "active"),
                  ),
                  eq(
                    sql`${rikaHostedExecutorAssignments.placement} ->> 'deviceId'`,
                    rikaHostedRunnerRegistrations.deviceId,
                  ),
                  eq(
                    sql`${rikaHostedExecutorAssignments.placement} ->> 'checkoutFingerprint'`,
                    rikaHostedRunnerRegistrations.checkoutFingerprint,
                  ),
                  or(
                    eq(
                      sql`${rikaHostedExecutorAssignments.placement} ->> 'requestingDeviceId'`,
                      rikaHostedRunnerRegistrations.deviceId,
                    ),
                    eq(rikaHostedRunnerRegistrations.remoteThreadCreationAllowed, true),
                  ),
                ),
              )
              .orderBy(asc(resume), asc(activeOrder), asc(rikaHostedExecutorAssignments.id))
              .limit(1)
              .for("update", { of: rikaHostedExecutorAssignments, skipLocked: true }),
          ))[0]
          return assignment === undefined ? { claimed: true as const } : { claimed: true as const, assignment }
        }),
      )
      .pipe(Effect.mapError(databaseError))

  return RunnerRegistrations.of({
    upsert,
    setRemoteThreadCreation,
    claimSupervisorAndPoll,
  })
})

export const layer = Layer.effect(RunnerRegistrations, make)
