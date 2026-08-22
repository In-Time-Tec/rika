import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Effect, Redacted, Schema } from "effect"
import { Sandbox } from "e2b"
import { make } from "../src/provider"

class LiveConfigurationError extends Schema.TaggedError<LiveConfigurationError>()("LiveConfigurationError", {
  message: Schema.String,
}) {}

class LiveValidationError extends Schema.TaggedError<LiveValidationError>()("LiveValidationError", {
  message: Schema.String,
}) {}

const required = (name: string) => {
  const value = Bun.env[name]
  return value === undefined || value.length === 0
    ? Effect.fail(LiveConfigurationError.make({ message: `${name} is required` }))
    : Effect.succeed(value)
}

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => LiveValidationError.make({ message: `${operation} failed` }),
  })
const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((value, index) => value === right[index])

const program = Effect.gen(function* () {
  const apiKeyValue = yield* required("E2B_API_KEY")
  const apiKey = Redacted.make(apiKeyValue, { label: "e2b-api-key" })
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
      RIKA_EXECUTOR_TARGET: "orb",
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
            target: "orb",
            ownerId: "live-owner",
            threadId: "live-thread",
            assignmentId: "live-validation",
            assignmentGeneration: 1,
            instanceId: sandbox.sandboxId,
            executorId: "live-validation:g1",
            templateBuildId,
            apiUrl: "wss://api.invalid/executors",
            workspaceId: "live-validation-workspace",
            repository: null,
            lifecycle: "fresh",
            environmentDigest: `sha256:${"a".repeat(64)}`,
            setupCache: false,
          },
          restore: null,
        })
        yield* provider.touch(sandbox.sandboxId, 900_000)
        const connection = { apiKey: apiKeyValue, requestTimeoutMs: 30_000, timeoutMs: 900_000 }
        const modified = Uint8Array.from([0, 255, 109, 111, 100, 105, 102, 105, 101, 100])
        const untracked = Uint8Array.from([117, 110, 116, 114, 97, 99, 107, 101, 100, 0, 255])
        let remote = yield* attempt("connect validation sandbox", () => Sandbox.connect(sandbox.sandboxId, connection))
        yield* attempt("write validation files", () =>
          remote.files.write([
            { path: "/home/user/tracked-modified.bin", data: modified.buffer as ArrayBuffer },
            { path: "/home/user/untracked.bin", data: untracked.buffer as ArrayBuffer },
          ]),
        )
        for (let cycle = 1; cycle <= 2; cycle += 1) {
          yield* provider.pauseFilesystem(sandbox.sandboxId)
          yield* provider.connect(sandbox.sandboxId, 900_000)
          remote = yield* attempt("reconnect validation sandbox", () => Sandbox.connect(sandbox.sandboxId, connection))
          const [restoredModified, restoredUntracked] = yield* Effect.all([
            attempt("read modified validation file", () =>
              remote.files.read("/home/user/tracked-modified.bin", { format: "bytes" }),
            ),
            attempt("read untracked validation file", () =>
              remote.files.read("/home/user/untracked.bin", { format: "bytes" }),
            ),
          ])
          if (!sameBytes(restoredModified, modified) || !sameBytes(restoredUntracked, untracked))
            return yield* LiveValidationError.make({ message: `filesystem validation failed after wake ${cycle}` })
        }
        yield* Console.log(
          json({ sandboxId: sandbox.sandboxId, wakes: 2, status: "filesystem-pause-resume-validated" }),
        )
      }),
    (sandbox) => provider.kill(sandbox.sandboxId).pipe(Effect.ignore),
  )
})

BunRuntime.runMain(program)
