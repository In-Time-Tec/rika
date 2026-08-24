import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer } from "effect"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { migrations } from "../../src/hosted/migrations"

const readFile = (url: URL) =>
  Effect.scoped(
    Layer.build(BunServices.layer).pipe(
      Effect.flatMap((context) =>
        Effect.provide(
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFile(fileURLToPath(url))),
          context,
        ),
      ),
    ),
  )
const readFileString = (url: URL) =>
  Effect.scoped(
    Layer.build(BunServices.layer).pipe(
      Effect.flatMap((context) =>
        Effect.provide(
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(fileURLToPath(url))),
          context,
        ),
      ),
    ),
  )

it.effect("keeps hosted PostgreSQL migration identities and checksums exact", () =>
  Effect.gen(function* () {
    expect(migrations.map(({ id }) => id)).toEqual([
      "product/0001_hosted_authority",
      "product/0002_hosted_identity_ancestry",
      "product/0003_hosted_authority_fences",
      "product/0004_runner",
      "product/0005_runner_recovery",
      "product/0006_product_state",
      "product/0007_hosted_prompt_admission",
      "product/0008_hosted_turn_worker",
      "product/0009_provider_credentials",
      "product/0010_logical_workspace_identity",
      "product/0011_executor_operation_identity",
      "product/0012_executor_operation_lifecycle",
      "product/0013_thread_protocol",
      "product/0014_runner_registration",
      "product/0015_environment_and_egress",
      "product/0016_authority_revocation",
      "product/0017_executor_recovery_capabilities",
      "product/0018_workspace_preparation",
      "product/0019_approved_repository_publication",
      "product/0020_tool_policy_audit",
      "product/0021_independent_assignment_identity",
      "product/0022_openai_account_credentials",
    ])
    for (const migration of migrations) {
      const sql = yield* readFile(migration.url)
      expect(migration.checksum).toBe(createHash("sha256").update(sql).digest("hex"))
    }
  }),
)

it.effect("removes obsolete assignment and Thread identity constraints", () =>
  Effect.gen(function* () {
    const migration = migrations.find(({ id }) => id === "product/0021_independent_assignment_identity")
    expect(migration).toBeDefined()
    const sql = yield* readFileString(migration!.url)
    expect(sql).toContain("DROP CONSTRAINT rika_hosted_executor_assignments_id_thread_id")
    expect(sql).toContain("DROP CONSTRAINT rika_hosted_thread_events_assignment_thread_id")
    expect(sql).toContain("DROP CONSTRAINT rika_hosted_checkpoints_assignment_thread_id")
  }),
)
