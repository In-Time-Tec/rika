import * as PgClient from "@effect/sql-pg/PgClient"
import {
  EnvironmentReference,
  SourceCommitSha,
  type EnvironmentPhase,
  type EnvironmentReference as EnvironmentReferenceValue,
  type SourceEnvironmentApproval,
  type StoredEnvironmentCandidate,
} from "@rika/product/environment-policy"
import { EnvironmentStore, EnvironmentStoreError, type EnvironmentStoreService } from "@rika/product/environment-store"
import { BetterAuthUserId, OwnerId, ProjectId, Timestamp } from "@rika/product/hosted-model"
import { Effect, Layer, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

interface EnvironmentRow {
  readonly id: string
  readonly ownerId: string
  readonly projectId: string | null
  readonly scope: "personal" | "organization" | "project"
  readonly scopeId: string
  readonly name: string
  readonly classification: "plain" | "secret"
  readonly phases: ReadonlyArray<EnvironmentPhase>
  readonly revision: string
  readonly valueDigest: string
  readonly state: "active" | "revoked"
  readonly keyVersion: number | null
  readonly nonce: Uint8Array | null
  readonly ciphertext: Uint8Array | null
  readonly authenticationTag: Uint8Array | null
  readonly updatedByUserId: string
  readonly updatedAt: string
}

interface ApprovalRow {
  readonly ownerId: string
  readonly projectId: string | null
  readonly sourceOwner: string
  readonly sourceCommitSha: string
  readonly phase: EnvironmentPhase
  readonly approvedByUserId: string
  readonly approvedAt: string
  readonly revokedAt: string | null
}

const failure = (kind: EnvironmentStoreError["kind"], message: string) => EnvironmentStoreError.make({ kind, message })
const database = () => failure("database", "Environment authority database operation failed")
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(database))
const transaction = <A>(sql: SqlClient, effect: Effect.Effect<A, EnvironmentStoreError>) =>
  sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", database))

const reference = (row: EnvironmentRow): Effect.Effect<EnvironmentReferenceValue, EnvironmentStoreError> =>
  Schema.decodeUnknownEffect(EnvironmentReference)({
    id: row.id,
    ownerId: row.ownerId,
    ...(row.projectId === null ? {} : { projectId: row.projectId }),
    scope: row.scope,
    scopeId: row.scopeId,
    name: row.name,
    classification: row.classification,
    phases: row.phases,
    revision: row.revision,
    valueDigest: row.valueDigest,
    state: row.state,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  }).pipe(Effect.mapError(database))

const stored = Effect.fn("PostgresEnvironmentStore.stored")(function* (
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

const selectColumns = `id, owner_id AS "ownerId", project_id AS "projectId", scope, scope_id AS "scopeId",
  name, classification, phases, revision::text AS revision, value_digest AS "valueDigest", state,
  key_version AS "keyVersion", nonce, ciphertext, authentication_tag AS "authenticationTag",
  updated_by_user_id AS "updatedByUserId",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`

const approvalValue = (row: ApprovalRow): SourceEnvironmentApproval => ({
  ownerId: OwnerId.make(row.ownerId),
  ...(row.projectId === null ? {} : { projectId: ProjectId.make(row.projectId) }),
  sourceOwner: row.sourceOwner,
  sourceCommitSha: SourceCommitSha.make(row.sourceCommitSha),
  phase: row.phase,
  approvedByUserId: BetterAuthUserId.make(row.approvedByUserId),
  approvedAt: Timestamp.make(row.approvedAt),
  revokedAt: row.revokedAt === null ? null : Timestamp.make(row.revokedAt),
})

const make = Effect.gen(function* (): Effect.fn.Return<EnvironmentStoreService, never, PgClient.PgClient> {
  const sql = yield* PgClient.PgClient
  const selectValue = (ownerId: string, scope: string, scopeId: string, name: string) =>
    query(
      sql.unsafe<EnvironmentRow>(
        `SELECT ${selectColumns} FROM rika_hosted_environment_values
       WHERE owner_id = $1 AND scope = $2 AND scope_id = $3 AND name = $4`,
        [ownerId, scope, scopeId, name],
      ),
    )

  const putValue: EnvironmentStoreService["putValue"] = Effect.fn("PostgresEnvironmentStore.putValue")(
    function* (input) {
      if (input.phases.length === 0 || new Set(input.phases).size !== input.phases.length)
        return yield* failure("invalid", "Environment phases must be non-empty and unique")
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          const rows = yield* query(sql`INSERT INTO rika_hosted_environment_values
            (id, owner_id, project_id, scope, scope_id, name, classification, phases, revision, value_digest,
              state, key_version, nonce, ciphertext, authentication_tag, created_by_user_id, updated_by_user_id)
            VALUES (${input.id}, ${input.ownerId}, ${input.projectId ?? null}, ${input.scope}, ${input.scopeId},
              ${input.name}, ${input.classification}, ${input.phases}, 1, ${input.valueDigest}, 'active',
              ${input.encrypted.keyVersion}, ${input.encrypted.nonce}, ${input.encrypted.ciphertext},
              ${input.encrypted.authenticationTag}, ${input.actorUserId}, ${input.actorUserId})
            ON CONFLICT (owner_id, scope, scope_id, name) DO UPDATE SET
              project_id = EXCLUDED.project_id, classification = EXCLUDED.classification, phases = EXCLUDED.phases,
              revision = rika_hosted_environment_values.revision + 1, value_digest = EXCLUDED.value_digest,
              state = 'active', key_version = EXCLUDED.key_version, nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext,
              authentication_tag = EXCLUDED.authentication_tag, updated_by_user_id = EXCLUDED.updated_by_user_id,
              updated_at = transaction_timestamp(), revoked_at = NULL
            RETURNING id`)
          if (rows[0] === undefined) return yield* database()
          const selected = (yield* selectValue(input.ownerId, input.scope, input.scopeId, input.name))[0]
          if (selected === undefined) return yield* database()
          return yield* reference(selected)
        }),
      )
    },
  )

  const revokeValue: EnvironmentStoreService["revokeValue"] = Effect.fn("PostgresEnvironmentStore.revokeValue")(
    function* (input) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          const rows = yield* query(sql`UPDATE rika_hosted_environment_values SET
            state = 'revoked', revision = revision + 1, key_version = NULL, nonce = NULL, ciphertext = NULL,
            authentication_tag = NULL, updated_by_user_id = ${input.actorUserId},
            updated_at = transaction_timestamp(), revoked_at = transaction_timestamp()
            WHERE owner_id = ${input.ownerId} AND scope = ${input.scope} AND scope_id = ${input.scopeId}
              AND name = ${input.name} RETURNING id`)
          if (rows[0] === undefined) return yield* failure("not-found", "Environment value is not configured")
          const selected = (yield* selectValue(input.ownerId, input.scope, input.scopeId, input.name))[0]
          if (selected === undefined) return yield* database()
          return yield* reference(selected)
        }),
      )
    },
  )

  const putOrganizationPolicy: EnvironmentStoreService["putOrganizationPolicy"] = Effect.fn(
    "PostgresEnvironmentStore.putOrganizationPolicy",
  )(function* (input) {
    yield* query(sql`INSERT INTO rika_hosted_organization_environment_policy
      (owner_id, personal_overrides, updated_by_user_id) VALUES
      (${input.ownerId}, ${input.personalOverrides}, ${input.actorUserId})
      ON CONFLICT (owner_id) DO UPDATE SET personal_overrides = EXCLUDED.personal_overrides,
        updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = transaction_timestamp()`)
  })

  const approvalRows = (input: {
    readonly ownerId: string
    readonly projectId?: string
    readonly sourceOwner: string
    readonly sourceCommitSha: string
    readonly phase: EnvironmentPhase
  }) =>
    query(sql<ApprovalRow>`SELECT owner_id AS "ownerId", project_id AS "projectId",
      source_owner AS "sourceOwner", source_commit_sha AS "sourceCommitSha", phase,
      approved_by_user_id AS "approvedByUserId",
      to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "approvedAt",
      CASE WHEN revoked_at IS NULL THEN NULL
        ELSE to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "revokedAt"
      FROM rika_hosted_source_environment_approvals
      WHERE owner_id = ${input.ownerId} AND project_id IS NOT DISTINCT FROM ${input.projectId ?? null}
        AND lower(source_owner) = lower(${input.sourceOwner})
        AND lower(source_commit_sha) = lower(${input.sourceCommitSha}) AND phase = ${input.phase}`)

  const putApproval: EnvironmentStoreService["putApproval"] = Effect.fn("PostgresEnvironmentStore.putApproval")(
    function* (input) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          yield* query(sql`DELETE FROM rika_hosted_source_environment_approvals
            WHERE owner_id = ${input.ownerId} AND project_id IS NOT DISTINCT FROM ${input.projectId ?? null}
              AND lower(source_owner) = lower(${input.sourceOwner})
              AND lower(source_commit_sha) = lower(${input.sourceCommitSha}) AND phase = ${input.phase}`)
          yield* query(sql`INSERT INTO rika_hosted_source_environment_approvals
            (owner_id, project_id, source_owner, source_commit_sha, phase, approved_by_user_id)
            VALUES (${input.ownerId}, ${input.projectId ?? null}, ${input.sourceOwner}, ${input.sourceCommitSha},
              ${input.phase}, ${input.actorUserId})`)
          const selected = (yield* approvalRows(input))[0]
          if (selected === undefined) return yield* database()
          return approvalValue(selected)
        }),
      )
    },
  )

  const revokeApproval: EnvironmentStoreService["revokeApproval"] = Effect.fn(
    "PostgresEnvironmentStore.revokeApproval",
  )(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const rows = yield* query(sql`UPDATE rika_hosted_source_environment_approvals SET
          revoked_at = transaction_timestamp()
          WHERE owner_id = ${input.ownerId} AND project_id IS NOT DISTINCT FROM ${input.projectId ?? null}
            AND lower(source_owner) = lower(${input.sourceOwner})
            AND lower(source_commit_sha) = lower(${input.sourceCommitSha}) AND phase = ${input.phase}
          RETURNING id`)
        if (rows[0] === undefined) return yield* failure("not-found", "Source approval is not configured")
        const selected = (yield* approvalRows(input))[0]
        if (selected === undefined) return yield* database()
        return approvalValue(selected)
      }),
    )
  })

  const putEgress: EnvironmentStoreService["putEgress"] = Effect.fn("PostgresEnvironmentStore.putEgress")(
    function* (input) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          yield* query(sql`DELETE FROM rika_hosted_phase_egress_policy
            WHERE owner_id = ${input.ownerId} AND project_id IS NOT DISTINCT FROM ${input.projectId ?? null}
              AND phase = ${input.policy.phase}`)
          yield* query(sql`INSERT INTO rika_hosted_phase_egress_policy
            (owner_id, project_id, phase, allowlist, updated_by_user_id)
            VALUES (${input.ownerId}, ${input.projectId ?? null}, ${input.policy.phase}, ${input.policy.allow},
              ${input.actorUserId})`)
          return input.policy
        }),
      )
    },
  )

  const resolvePhase: EnvironmentStoreService["resolvePhase"] = Effect.fn("PostgresEnvironmentStore.resolvePhase")(
    function* (input) {
      const rows = yield* query(
        sql.unsafe<EnvironmentRow>(
          `SELECT ${selectColumns} FROM rika_hosted_environment_values value
         WHERE value.owner_id = $1 AND (
           (value.scope = 'personal' AND value.scope_id = $2)
           OR (value.scope = 'organization' AND value.scope_id = $1)
           OR (value.scope = 'project' AND value.scope_id = $3)
         ) ORDER BY value.name, value.scope, value.id FOR SHARE OF value`,
          [input.ownerId, input.userId, input.projectId ?? null],
        ),
      )
      const approvals = yield* query(sql<ApprovalRow>`SELECT owner_id AS "ownerId", project_id AS "projectId",
        source_owner AS "sourceOwner", source_commit_sha AS "sourceCommitSha", phase,
        approved_by_user_id AS "approvedByUserId",
        to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "approvedAt",
        CASE WHEN revoked_at IS NULL THEN NULL
          ELSE to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "revokedAt"
        FROM rika_hosted_source_environment_approvals
        WHERE owner_id = ${input.ownerId}
          AND (project_id = ${input.projectId ?? null} OR project_id IS NULL)
          AND lower(source_owner) = lower(${input.source.owner})
          AND lower(source_commit_sha) = lower(${input.source.commitSha}) AND phase = ${input.phase}
        ORDER BY project_id NULLS LAST LIMIT 1 FOR SHARE`)
      const policies = yield* query(
        sql<{ readonly personalOverrides: boolean }>`SELECT personal_overrides AS "personalOverrides"
          FROM rika_hosted_organization_environment_policy WHERE owner_id = ${input.ownerId} FOR SHARE`,
      )
      const egressRows = yield* query(
        sql<{ readonly allow: ReadonlyArray<string> }>`SELECT allowlist AS allow FROM rika_hosted_phase_egress_policy
          WHERE owner_id = ${input.ownerId} AND phase = ${input.phase}
            AND (project_id = ${input.projectId ?? null} OR project_id IS NULL)
          ORDER BY project_id NULLS LAST LIMIT 1 FOR SHARE`,
      )
      return {
        candidates: yield* Effect.forEach(
          rows.filter((row) => row.state === "active" && row.phases.includes(input.phase)),
          stored,
        ),
        ...(approvals[0] === undefined ? {} : { approval: approvalValue(approvals[0]) }),
        organizationPersonalOverrides: policies[0]?.personalOverrides ?? true,
        egress: { phase: input.phase, allow: [...(egressRows[0]?.allow ?? [])] },
      }
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
