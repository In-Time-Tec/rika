import { describe, expect, test } from "vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { run, runTest, sandbox } from "./process"

const Status = Schema.Literals(["present", "missing"])
const CredentialStatus = Schema.Literals(["present", "missing", "not-configured"])
const DoctorReport = Schema.fromJsonString(
  Schema.Struct({
    databases: Schema.Struct({ product: Status, relay: Status }),
    upstream: Schema.Record(Schema.String, Status),
    config: Schema.Struct({
      diagnostics: Schema.Array(Schema.Struct({ path: Schema.String, source: Schema.String, message: Schema.String })),
      global: Status,
      workspace: Status,
    }),
    credentials: Schema.Struct({ parallel: Status }),
    model: Schema.Struct({
      route: Schema.Struct({ alias: Schema.String, providerId: Schema.String, model: Schema.String }),
      apiKey: CredentialStatus,
    }),
  }),
)

describe("packaged local installation doctor", () => {
  test(
    "reports missing configuration and database presence with a stable schema and successful exit",
    () =>
      runTest(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* sandbox
            const fileSystem = yield* FileSystem.FileSystem
            expect(yield* fileSystem.exists(context.env.RIKA_DATABASE!)).toBe(false)
            expect(yield* fileSystem.exists(context.env.RIKA_RELAY_DATABASE!)).toBe(false)

            const result = yield* run(context, ["doctor"])
            expect(result.exitCode).toBe(0)
            expect(result.stderr).toBe("")
            const report = Schema.decodeUnknownSync(DoctorReport)(result.stdout)
            expect(Object.keys(report).toSorted()).toEqual(["config", "credentials", "databases", "model", "upstream"])
            expect(report.databases).toEqual({ product: "present", relay: "missing" })
            expect(report.config).toMatchObject({ diagnostics: [], global: "missing", workspace: "missing" })
            expect(report.upstream).toEqual({ baton: "present", relay: "present" })
            expect(yield* fileSystem.exists(context.env.RIKA_DATABASE!)).toBe(true)
            expect(yield* fileSystem.exists(context.env.RIKA_RELAY_DATABASE!)).toBe(false)
            yield* context.dispose
          }),
        ),
      ),
    20_000,
  )

  test(
    "fails without a healthy report when global or workspace configuration is corrupt",
    () =>
      runTest(
        Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            for (const location of ["global", "workspace"] as const) {
              const context = yield* sandbox
              const configPath =
                location === "global"
                  ? path.join(context.env.HOME!, ".config", "rika", "settings.json")
                  : path.join(context.workspace, ".rika", "settings.json")
              yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true })
              yield* fileSystem.writeFileString(configPath, '{"providers":{"openai":{"apiKey":"must-not-leak"}}}')

              const result = yield* run(context, ["doctor"])
              expect(result.exitCode).not.toBe(0)
              expect(result.stdout).not.toContain('"databases"')
              expect(result.stderr).not.toBe("")
              expect(`${result.stdout}${result.stderr}`).not.toContain("must-not-leak")
              yield* context.dispose
            }
          }),
        ),
      ),
    20_000,
  )

  test(
    "reports the configured model route and credential presence without a provider call or secret disclosure",
    () =>
      runTest(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* sandbox
            const fileSystem = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const configPath = path.join(context.workspace, ".rika", "settings.json")
            yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true })
            yield* fileSystem.writeFileString(
              configPath,
              JSON.stringify({
                providers: { openai: { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "DOCTOR_MODEL_KEY" } },
              }),
            )
            context.env.DOCTOR_MODEL_KEY = "doctor-model-secret"
            context.env.PARALLEL_API_KEY = "doctor-parallel-secret"
            delete context.env.RIKA_TEST_MODEL_RESPONSE

            const result = yield* run(context, ["doctor"])
            expect(result.exitCode).toBe(0)
            const report = Schema.decodeUnknownSync(DoctorReport)(result.stdout)
            expect(report.config.workspace).toBe("present")
            expect(report.config.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
              "providers",
              "parallelApiKey",
              "providerCredentials.DOCTOR_MODEL_KEY",
            ])
            expect(report.credentials.parallel).toBe("present")
            expect(report.model).toMatchObject({
              route: { alias: "terra", providerId: "openai", model: "gpt-5.6-terra" },
              apiKey: "present",
            })
            expect(`${result.stdout}${result.stderr}`).not.toContain("doctor-model-secret")
            expect(`${result.stdout}${result.stderr}`).not.toContain("doctor-parallel-secret")
            yield* context.dispose
          }),
        ),
      ),
    20_000,
  )
})
