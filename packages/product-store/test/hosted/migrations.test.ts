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
      "product/0023_staged_turn_admission",
      "product/0024_workspace_preparation_deadline",
      "product/0025_terminal_receipt_recovery",
      "product/0026_runner_supervisor_lease",
      "product/0027_executor_recovery_authority",
      "product/0028_tool_policy_decision_identity",
      "product/0029_command_application_and_prompt_cancellation",
      "product/0030_tenetkit_recovery_authority",
      "product/0031_transactional_thread_notifications",
      "product/0032_terminalize_unrecoverable_turns",
      "product/0033_transcript_projection_notifications",
      "product/0034_atomic_thread_replacement",
      "product/0035_workspace_seeds",
      "product/0036_explicit_command_turn_identity",
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

it.effect("terminalizes only legacy Turns without a recoverable staged admission", () =>
  Effect.gen(function* () {
    const migration = migrations.find(({ id }) => id === "product/0032_terminalize_unrecoverable_turns")
    expect(migration).toBeDefined()
    const sql = yield* readFileString(migration!.url)
    expect(sql).toContain("turn_record.execution_link_json IS NULL")
    expect(sql).toContain("admission.prepared_turn_json IS NOT NULL")
    expect(sql).toContain("status = 'failed'")
  }),
)

it.effect("notifies Thread sockets after a transcript projection commits", () =>
  Effect.gen(function* () {
    const migration = migrations.find(({ id }) => id === "product/0033_transcript_projection_notifications")
    expect(migration).toBeDefined()
    const sql = yield* readFileString(migration!.url)
    expect(sql).toContain("AFTER INSERT OR UPDATE ON rika_transcript_checkpoints")
    expect(sql).toContain("rika_hosted_notify_thread_change()")
  }),
)
