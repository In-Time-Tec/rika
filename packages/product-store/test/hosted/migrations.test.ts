import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { migrations } from "../../src/hosted/migrations"

it.effect("keeps hosted PostgreSQL migration identities and checksums exact", () =>
  Effect.gen(function* () {
    expect(migrations.map(({ id }) => id)).toEqual([
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
    ])
    for (const migration of migrations) {
      const sql = yield* Effect.promise(() => Bun.file(migration.url).arrayBuffer())
      expect(migration.checksum).toBe(createHash("sha256").update(Buffer.from(sql)).digest("hex"))
    }
  }),
)
