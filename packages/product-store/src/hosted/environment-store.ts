import * as PgClient from "@effect/sql-pg/PgClient"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import {
  EnvironmentReference,
  SourceCommitSha,
  defaultEgressDestinations,
  type EnvironmentPhase,
  type EnvironmentReference as EnvironmentReferenceValue,
  type SourceEnvironmentApproval,
  type StoredEnvironmentCandidate,
} from "@rika/product/environment-policy"
import { EnvironmentStore, EnvironmentStoreError, type EnvironmentStoreService } from "@rika/product/environment-store"
import { BetterAuthUserId, OwnerId, ProjectId, Timestamp } from "@rika/product/hosted-model"
import { and, asc, eq, isNull, or, sql as expression } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import {
  rikaHostedEnvironmentValues,
  rikaHostedOrganizationEnvironmentPolicy,
  rikaHostedPhaseEgressPolicy,
  rikaHostedSourceEnvironmentApprovals,
} from "../database/schema/product"

type EnvironmentRow = typeof rikaHostedEnvironmentValues.$inferSelect
type ApprovalRow = typeof rikaHostedSourceEnvironmentApprovals.$inferSelect

const failure = (kind: EnvironmentStoreError["kind"], message: string) => EnvironmentStoreError.make({ kind, message })
const database = () => failure("database", "Environment authority database operation failed")
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(database))
const timestampText = (value: Date) => value.toISOString()

const reference = (row: EnvironmentRow): Effect.Effect<EnvironmentReferenceValue, EnvironmentStoreError> =>
  Schema.decodeUnknownEffect(EnvironmentReference)(
    row.projectId === null
      ? {
          id: row.id,
          ownerId: row.ownerId,
          scope: row.scope,
          scopeId: row.scopeId,
          name: row.name,
          classification: row.classification,
          phases: row.phases,
          revision: String(row.revision),
          valueDigest: row.valueDigest,
          state: row.state,
          updatedByUserId: row.updatedByUserId,
          updatedAt: timestampText(row.updatedAt),
        }
      : {
          id: row.id,
          ownerId: row.ownerId,
          projectId: row.projectId,
          scope: row.scope,
          scopeId: row.scopeId,
          name: row.name,
          classification: row.classification,
          phases: row.phases,
          revision: String(row.revision),
          valueDigest: row.valueDigest,
          state: row.state,
          updatedByUserId: row.updatedByUserId,
          updatedAt: timestampText(row.updatedAt),
        },
  ).pipe(Effect.mapError(database))

const stored = Effect.fn("EnvironmentStore.stored")(function* (
  row: EnvironmentRow,
): Effect.fn.Return<StoredEnvironmentCandidate, EnvironmentStoreError> {
  if (
    row.state !== "active" ||
    row.keyVersion !== 1 ||
    row.nonce === null ||
    row.ciphertext === null ||
    row.authenticationTag === null
  )
    return yield* failure("invalid", "Active environment material is incomplete")
  if (
    !(row.nonce instanceof Uint8Array) ||
    !(row.ciphertext instanceof Uint8Array) ||
    !(row.authenticationTag instanceof Uint8Array)
  )
    return yield* failure("database", "Active environment material has an invalid binary representation")
  return {
    reference: yield* reference(row),
    encrypted: {
      keyVersion: 1,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authenticationTag: row.authenticationTag,
    },
  }
})

const approvalValue = (row: ApprovalRow): SourceEnvironmentApproval => {
  const phase: EnvironmentPhase = row.phase === "setup" ? "setup" : "runtime"
  return row.projectId === null
    ? {
        ownerId: OwnerId.make(row.ownerId),
        sourceOwner: row.sourceOwner,
        sourceCommitSha: SourceCommitSha.make(row.sourceCommitSha),
        phase,
        approvedByUserId: BetterAuthUserId.make(row.approvedByUserId),
        approvedAt: Timestamp.make(timestampText(row.approvedAt)),
        revokedAt: row.revokedAt === null ? null : Timestamp.make(timestampText(row.revokedAt)),
      }
    : {
        ownerId: OwnerId.make(row.ownerId),
        projectId: ProjectId.make(row.projectId),
        sourceOwner: row.sourceOwner,
        sourceCommitSha: SourceCommitSha.make(row.sourceCommitSha),
        phase,
        approvedByUserId: BetterAuthUserId.make(row.approvedByUserId),
        approvedAt: Timestamp.make(timestampText(row.approvedAt)),
        revokedAt: row.revokedAt === null ? null : Timestamp.make(timestampText(row.revokedAt)),
      }
}

const approvalPredicate = (input: {
  readonly ownerId: string
  readonly projectId?: string
  readonly sourceOwner: string
  readonly sourceCommitSha: string
  readonly phase: EnvironmentPhase
}) =>
  and(
    eq(rikaHostedSourceEnvironmentApprovals.ownerId, input.ownerId),
    expression`${rikaHostedSourceEnvironmentApprovals.projectId} is not distinct from ${input.projectId ?? null}`,
    expression`lower(${rikaHostedSourceEnvironmentApprovals.sourceOwner}) = lower(${input.sourceOwner})`,
    expression`lower(${rikaHostedSourceEnvironmentApprovals.sourceCommitSha}) = lower(${input.sourceCommitSha})`,
    eq(rikaHostedSourceEnvironmentApprovals.phase, input.phase),
  )

const make = Effect.gen(function* (): Effect.fn.Return<EnvironmentStoreService, never, PgClient.PgClient> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()
  const putValue: EnvironmentStoreService["putValue"] = Effect.fn("EnvironmentStore.putValue")(function* (input) {
    if (input.phases.length === 0 || new Set(input.phases).size !== input.phases.length)
      return yield* failure("invalid", "Environment phases must be non-empty and unique")
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* query(
            tx
              .insert(rikaHostedEnvironmentValues)
              .values({
                id: input.id,
                ownerId: input.ownerId,
                projectId: input.projectId ?? null,
                scope: input.scope,
                scopeId: input.scopeId,
                name: input.name,
                classification: input.classification,
                phases: [...input.phases],
                revision: 1,
                valueDigest: input.valueDigest,
                state: "active",
                keyVersion: input.encrypted.keyVersion,
                nonce: input.encrypted.nonce,
                ciphertext: input.encrypted.ciphertext,
                authenticationTag: input.encrypted.authenticationTag,
                createdByUserId: input.actorUserId,
                updatedByUserId: input.actorUserId,
              })
              .onConflictDoUpdate({
                target: [
                  rikaHostedEnvironmentValues.ownerId,
                  rikaHostedEnvironmentValues.scope,
                  rikaHostedEnvironmentValues.scopeId,
                  rikaHostedEnvironmentValues.name,
                ],
                set: {
                  projectId: expression`excluded.project_id`,
                  classification: expression`excluded.classification`,
                  phases: expression`excluded.phases`,
                  revision: expression`${rikaHostedEnvironmentValues.revision} + 1`,
                  valueDigest: expression`excluded.value_digest`,
                  state: "active",
                  keyVersion: expression`excluded.key_version`,
                  nonce: expression`excluded.nonce`,
                  ciphertext: expression`excluded.ciphertext`,
                  authenticationTag: expression`excluded.authentication_tag`,
                  updatedByUserId: expression`excluded.updated_by_user_id`,
                  updatedAt: expression`transaction_timestamp()`,
                  revokedAt: null,
                },
              })
              .returning({ id: rikaHostedEnvironmentValues.id }),
          )
          if (rows[0] === undefined) return yield* database()
          const selected = (yield* query(
            tx
              .select()
              .from(rikaHostedEnvironmentValues)
              .where(
                and(
                  eq(rikaHostedEnvironmentValues.ownerId, input.ownerId),
                  eq(rikaHostedEnvironmentValues.scope, input.scope),
                  eq(rikaHostedEnvironmentValues.scopeId, input.scopeId),
                  eq(rikaHostedEnvironmentValues.name, input.name),
                ),
              ),
          ))[0]
          if (selected === undefined) return yield* database()
          return yield* reference(selected)
        }),
      )
      .pipe(Effect.catchTag("SqlError", database))
  })

  const revokeValue: EnvironmentStoreService["revokeValue"] = Effect.fn("EnvironmentStore.revokeValue")(
    function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const predicate = and(
              eq(rikaHostedEnvironmentValues.ownerId, input.ownerId),
              eq(rikaHostedEnvironmentValues.scope, input.scope),
              eq(rikaHostedEnvironmentValues.scopeId, input.scopeId),
              eq(rikaHostedEnvironmentValues.name, input.name),
            )
            const rows = yield* query(
              tx
                .update(rikaHostedEnvironmentValues)
                .set({
                  state: "revoked",
                  revision: expression`${rikaHostedEnvironmentValues.revision} + 1`,
                  keyVersion: null,
                  nonce: null,
                  ciphertext: null,
                  authenticationTag: null,
                  updatedByUserId: input.actorUserId,
                  updatedAt: expression`transaction_timestamp()`,
                  revokedAt: expression`transaction_timestamp()`,
                })
                .where(predicate)
                .returning({ id: rikaHostedEnvironmentValues.id }),
            )
            if (rows[0] === undefined) return yield* failure("not-found", "Environment value is not configured")
            const selected = (yield* query(tx.select().from(rikaHostedEnvironmentValues).where(predicate)))[0]
            if (selected === undefined) return yield* database()
            return yield* reference(selected)
          }),
        )
        .pipe(Effect.catchTag("SqlError", database))
    },
  )

  const putOrganizationPolicy: EnvironmentStoreService["putOrganizationPolicy"] = Effect.fn(
    "EnvironmentStore.putOrganizationPolicy",
  )(function* (input) {
    yield* query(
      db
        .insert(rikaHostedOrganizationEnvironmentPolicy)
        .values({
          ownerId: input.ownerId,
          personalOverrides: input.personalOverrides,
          updatedByUserId: input.actorUserId,
        })
        .onConflictDoUpdate({
          target: rikaHostedOrganizationEnvironmentPolicy.ownerId,
          set: {
            personalOverrides: expression`excluded.personal_overrides`,
            updatedByUserId: expression`excluded.updated_by_user_id`,
            updatedAt: expression`transaction_timestamp()`,
          },
        }),
    )
  })

  const putApproval: EnvironmentStoreService["putApproval"] = Effect.fn("EnvironmentStore.putApproval")(
    function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* query(tx.delete(rikaHostedSourceEnvironmentApprovals).where(approvalPredicate(input)))
            yield* query(
              tx.insert(rikaHostedSourceEnvironmentApprovals).values({
                ownerId: input.ownerId,
                projectId: input.projectId ?? null,
                sourceOwner: input.sourceOwner,
                sourceCommitSha: input.sourceCommitSha,
                phase: input.phase,
                approvedByUserId: input.actorUserId,
              }),
            )
            const selected = (yield* query(
              tx.select().from(rikaHostedSourceEnvironmentApprovals).where(approvalPredicate(input)),
            ))[0]
            if (selected === undefined) return yield* database()
            return approvalValue(selected)
          }),
        )
        .pipe(Effect.catchTag("SqlError", database))
    },
  )

  const revokeApproval: EnvironmentStoreService["revokeApproval"] = Effect.fn("EnvironmentStore.revokeApproval")(
    function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* query(
              tx
                .update(rikaHostedSourceEnvironmentApprovals)
                .set({ revokedAt: expression`transaction_timestamp()` })
                .where(approvalPredicate(input))
                .returning({ id: rikaHostedSourceEnvironmentApprovals.id }),
            )
            if (rows[0] === undefined) return yield* failure("not-found", "Source approval is not configured")
            const selected = (yield* query(
              tx.select().from(rikaHostedSourceEnvironmentApprovals).where(approvalPredicate(input)),
            ))[0]
            if (selected === undefined) return yield* database()
            return approvalValue(selected)
          }),
        )
        .pipe(Effect.catchTag("SqlError", database))
    },
  )

  const putEgress: EnvironmentStoreService["putEgress"] = Effect.fn("EnvironmentStore.putEgress")(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const predicate = and(
            eq(rikaHostedPhaseEgressPolicy.ownerId, input.ownerId),
            expression`${rikaHostedPhaseEgressPolicy.projectId} is not distinct from ${input.projectId ?? null}`,
            eq(rikaHostedPhaseEgressPolicy.phase, input.policy.phase),
          )
          yield* query(tx.delete(rikaHostedPhaseEgressPolicy).where(predicate))
          yield* query(
            tx.insert(rikaHostedPhaseEgressPolicy).values({
              ownerId: input.ownerId,
              projectId: input.projectId ?? null,
              phase: input.policy.phase,
              allowlist: [...input.policy.allow],
              updatedByUserId: input.actorUserId,
            }),
          )
          return input.policy
        }),
      )
      .pipe(Effect.catchTag("SqlError", database))
  })

  const resolvePhase: EnvironmentStoreService["resolvePhase"] = Effect.fn("EnvironmentStore.resolvePhase")(
    function* (input) {
      const rows = yield* query(
        db
          .select()
          .from(rikaHostedEnvironmentValues)
          .where(
            and(
              eq(rikaHostedEnvironmentValues.ownerId, input.ownerId),
              or(
                and(
                  eq(rikaHostedEnvironmentValues.scope, "personal"),
                  eq(rikaHostedEnvironmentValues.scopeId, input.userId),
                ),
                and(
                  eq(rikaHostedEnvironmentValues.scope, "organization"),
                  eq(rikaHostedEnvironmentValues.scopeId, input.ownerId),
                ),
                input.projectId === undefined
                  ? undefined
                  : and(
                      eq(rikaHostedEnvironmentValues.scope, "project"),
                      eq(rikaHostedEnvironmentValues.scopeId, input.projectId),
                    ),
              ),
            ),
          )
          .orderBy(
            asc(rikaHostedEnvironmentValues.name),
            asc(rikaHostedEnvironmentValues.scope),
            asc(rikaHostedEnvironmentValues.id),
          )
          .for("share", { of: rikaHostedEnvironmentValues }),
      )
      const approvals = yield* query(
        db
          .select()
          .from(rikaHostedSourceEnvironmentApprovals)
          .where(
            and(
              eq(rikaHostedSourceEnvironmentApprovals.ownerId, input.ownerId),
              or(
                input.projectId === undefined
                  ? undefined
                  : eq(rikaHostedSourceEnvironmentApprovals.projectId, input.projectId),
                isNull(rikaHostedSourceEnvironmentApprovals.projectId),
              ),
              expression`lower(${rikaHostedSourceEnvironmentApprovals.sourceOwner}) = lower(${input.source.owner})`,
              expression`lower(${rikaHostedSourceEnvironmentApprovals.sourceCommitSha}) = lower(${input.source.commitSha})`,
              eq(rikaHostedSourceEnvironmentApprovals.phase, input.phase),
            ),
          )
          .orderBy(expression`${rikaHostedSourceEnvironmentApprovals.projectId} asc nulls last`)
          .limit(1)
          .for("share"),
      )
      const policies = yield* query(
        db
          .select({
            personalOverrides: rikaHostedOrganizationEnvironmentPolicy.personalOverrides,
          })
          .from(rikaHostedOrganizationEnvironmentPolicy)
          .where(eq(rikaHostedOrganizationEnvironmentPolicy.ownerId, input.ownerId))
          .for("share"),
      )
      const egressRows = yield* query(
        db
          .select({ allow: rikaHostedPhaseEgressPolicy.allowlist })
          .from(rikaHostedPhaseEgressPolicy)
          .where(
            and(
              eq(rikaHostedPhaseEgressPolicy.ownerId, input.ownerId),
              eq(rikaHostedPhaseEgressPolicy.phase, input.phase),
              or(
                input.projectId === undefined ? undefined : eq(rikaHostedPhaseEgressPolicy.projectId, input.projectId),
                isNull(rikaHostedPhaseEgressPolicy.projectId),
              ),
            ),
          )
          .orderBy(expression`${rikaHostedPhaseEgressPolicy.projectId} asc nulls last`)
          .limit(1)
          .for("share"),
      )
      const resolved = {
        candidates: yield* Effect.forEach(
          rows.filter((row) => row.state === "active" && row.phases.includes(input.phase)),
          stored,
        ),
        organizationPersonalOverrides: policies[0]?.personalOverrides ?? true,
        egress: {
          phase: input.phase,
          allow: [...(egressRows[0]?.allow ?? defaultEgressDestinations(input.phase))],
        },
      }
      return approvals[0] === undefined ? resolved : { ...resolved, approval: approvalValue(approvals[0]) }
    },
  )

  return EnvironmentStore.of({
    putValue,
    revokeValue,
    putOrganizationPolicy,
    putApproval,
    revokeApproval,
    putEgress,
    resolvePhase,
  })
})

export const layer = Layer.effect(EnvironmentStore, make)
