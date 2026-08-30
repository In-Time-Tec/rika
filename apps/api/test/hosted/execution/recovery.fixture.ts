import { identityMigrations, runMigration } from "@rika/identity"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as ExecutionPostgres from "@rika/execution/postgres"
import { FileSystem, Config, Effect } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Pool } from "pg"
import { Address, ExecutableManifest, Message } from "tenetkit/runtime"
import { SqlCodecs } from "tenetkit/runtime/driver/sql"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const principal = { userId: "recovery-user", deviceId: "recovery-device", clientId: "recovery-client" }
const executable: ReturnType<typeof ExecutableManifest.makeTest> = ExecutableManifest.makeTest("recovery", "test")
const executableRef = SqlCodecs.encodeExecutableRef(executable.ref)
const executableManifest = SqlCodecs.encodeExecutableManifest(executable.manifest)
const storedMessage = (suffix: string) =>
  SqlCodecs.encodeMessage(
    Message.make({
      id: `message-${suffix}`,
      to: Address.make("agent:recovery"),
      sessionId: `session-${suffix}`,
      prompt: Prompt.make("recover"),
      idempotencyKey: `run-${suffix}`,
      correlationId: `run-${suffix}`,
    }),
  )

const migrate = (url: string, pool: Pool) =>
  Effect.gen(function* () {
    for (const migration of [...identityMigrations, ...productMigrations]) {
      const sql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(migration.url.pathname),
      )
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    yield* ExecutionPostgres.applySchema({ url, source: "hosted-recovery-live" })
  })

export const recoveryFixture = {
  databaseUrl,
  principal,
  executableRef,
  executableManifest,
  storedMessage,
  migrate,
}
