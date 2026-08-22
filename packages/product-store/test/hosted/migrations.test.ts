import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { migrations } from "../../src/hosted/migrations"

it.effect("keeps hosted PostgreSQL migration identities and checksums exact", () =>
  Effect.gen(function* () {
    expect(migrations.map(({ id }) => id)).toEqual([
      "product/0000_hosted_authority_reset",
      "product/0001_hosted_authority",
      "product/0002_hosted_identity_ancestry",
      "product/0003_hosted_authority_fences",
      "product/0004_local_executor",
      "product/0005_local_executor_recovery",
      "product/0006_product_state",
      "product/0007_hosted_prompt_admission",
      "product/0008_hosted_turn_worker",
      "product/0009_provider_credentials",
      "product/0010_logical_workspace_identity",
      "product/0011_executor_operation_identity",
      "product/0012_executor_operation_lifecycle",
      "product/0013_thread_protocol",
      "product/0014_local_runner_registration",
      "product/0015_environment_and_egress",
      "product/0016_authority_revocation",
      "product/0017_executor_recovery_capabilities",
      "product/0018_workspace_preparation",
      "product/0019_approved_repository_publication",
      "product/0020_tool_policy_audit",
      "product/0021_independent_assignment_identity",
    ])
    for (const migration of migrations) {
      const sql = yield* Effect.promise(() => Bun.file(migration.url).arrayBuffer())
      expect(migration.checksum).toBe(createHash("sha256").update(Buffer.from(sql)).digest("hex"))
    }
  }),
)

it.effect("resets only the known pre-owner hosted authority", () =>
  Effect.gen(function* () {
    const migration = migrations[0]
    expect(migration?.id).toBe("product/0000_hosted_authority_reset")
    const sql = yield* Effect.promise(() => Bun.file(migration!.url).text())
    expect(sql).toContain("hosted authority reset found an unsupported product migration history")
    expect(sql).toContain("'product/0001_hosted_authority', '80916a77")
    expect(sql).toContain("'product/0005_local_executor_recovery', '77cbc8eb")
    expect(sql).toContain("ALTER TABLE \"member\" DROP CONSTRAINT IF EXISTS member_id_organization_unique")
    expect(sql).toContain("DELETE FROM rika_api_migration WHERE id LIKE 'product/%'")
  }),
)

it.effect("removes obsolete assignment and Thread identity constraints", () =>
  Effect.gen(function* () {
    const migration = migrations.find(({ id }) => id === "product/0021_independent_assignment_identity")
    expect(migration).toBeDefined()
    const sql = yield* Effect.promise(() => Bun.file(migration!.url).text())
    expect(sql).toContain("DROP CONSTRAINT rika_hosted_executor_assignments_id_thread_id")
    expect(sql).toContain("DROP CONSTRAINT rika_hosted_thread_events_assignment_thread_id")
    expect(sql).toContain("DROP CONSTRAINT rika_hosted_checkpoints_assignment_thread_id")
  }),
)
