import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Effect, Redacted, Schema } from "effect"
import { make } from "../src/provider"

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
  const templateId = yield* required("E2B_TEMPLATE_ID")
  const templateBuildId = yield* required("E2B_TEMPLATE_BUILD_ID")
  const provider = make({ apiKey })
  const create = provider.create({
    appId: "rika",
    deploymentId: "live-validation",
    templateId,
    templateBuildId,
    assignmentId: "live-validation",
    threadId: "live-validation",
    generation: 1,
    idleTimeoutMillis: 900_000,
    allowedEgress: ["controller.invalid", "github.com", "api.github.com"],
    environment: {
      RIKA_EXECUTOR_TARGET: "e2b",
      RIKA_EXECUTOR_ASSIGNMENT_ID: "live-validation",
      RIKA_EXECUTOR_GENERATION: "1",
      RIKA_EXECUTOR_ID: "live-validation:g1",
      RIKA_EXECUTOR_TEMPLATE_BUILD_ID: templateBuildId,
      RIKA_EXECUTOR_API_URL: "wss://api.invalid/executors",
    },
  })
  return yield* Effect.acquireUseRelease(
    create,
    (sandbox) =>
      Effect.gen(function* () {
        yield* provider.bootstrap({
          sandboxId: sandbox.sandboxId,
          credential: Redacted.make("live-validation-bootstrap"),
          identity: {
            target: "e2b",
            assignmentId: "live-validation",
            assignmentGeneration: 1,
            instanceId: sandbox.sandboxId,
            executorId: "live-validation:g1",
            templateBuildId,
            apiUrl: "wss://api.invalid/executors",
            workspace: "/workspace",
          },
        })
        yield* provider.touch(sandbox.sandboxId, 900_000)
        yield* provider.pauseFilesystem(sandbox.sandboxId)
        yield* provider.connect(sandbox.sandboxId, 900_000)
        yield* Console.log(json({ sandboxId: sandbox.sandboxId, status: "filesystem-pause-resume-validated" }))
      }),
    (sandbox) => provider.kill(sandbox.sandboxId).pipe(Effect.ignore),
  )
})

BunRuntime.runMain(program)
