import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Effect, Redacted, Schema } from "effect"
import { make } from "../src/e2b-provider"

class LiveConfigurationError extends Schema.TaggedError<LiveConfigurationError>()("LiveConfigurationError", {
  message: Schema.String,
}) {}

const required = (name: string) => {
  const value = Bun.env[name]
  return value === undefined || value.length === 0
    ? Effect.fail(LiveConfigurationError.make({ message: `${name} is required` }))
    : Effect.succeed(value)
}

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const program = Effect.gen(function* () {
  const apiKey = Redacted.make(yield* required("E2B_API_KEY"), { label: "e2b-api-key" })
  const templateBuildId = yield* required("E2B_TEMPLATE_BUILD_ID")
  const provider = make({ apiKey })
  const sandbox = yield* provider.create({
    templateBuildId,
    assignmentId: "live-validation",
    workspaceId: "live-validation",
    generation: 1,
    idleTimeoutMillis: 900_000,
    allowedEgress: ["controller.invalid", "github.com", "api.github.com"],
    environment: {
      RIKA_EXECUTOR_TARGET: "e2b",
      RIKA_EXECUTOR_ASSIGNMENT_ID: "live-validation",
      RIKA_EXECUTOR_GENERATION: "1",
      RIKA_EXECUTOR_ID: "live-validation:g1",
      RIKA_EXECUTOR_CONTROLLER_URL: "wss://controller.invalid/executors",
    },
    secrets: { RIKA_EXECUTOR_BOOTSTRAP_TOKEN: Redacted.make("live-validation-bootstrap") },
  })
  return yield* Effect.acquireUseRelease(
    Effect.succeed(sandbox),
    (active) =>
      Effect.gen(function* () {
        yield* provider.touch(active.sandboxId, 900_000)
        yield* provider.pauseFilesystem(active.sandboxId)
        yield* provider.connect(active.sandboxId, 900_000)
        yield* Console.log(json({ sandboxId: active.sandboxId, status: "filesystem-pause-resume-validated" }))
      }),
    (active) => provider.kill(active.sandboxId).pipe(Effect.ignore),
  )
})

BunRuntime.runMain(program)
