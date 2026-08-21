import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Sandbox } from "e2b"
import { Effect, Layer, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"

const DoctorResult = Schema.Struct({
  ok: Schema.Boolean,
  buildId: Schema.String,
  manifestSha256: Schema.String,
  checks: Schema.Array(Schema.Struct({ ok: Schema.Boolean })),
})
const SmokeArtifact = Schema.Struct({ ...DoctorResult.fields, sandboxId: Schema.String })

class SmokeError extends Schema.TaggedError<SmokeError>()("SmokeError", { message: Schema.String }) {}

const decodeDoctorResult = Schema.decodeUnknownEffect(Schema.fromJsonString(DoctorResult))
const encodeSmokeArtifact = Schema.encodeEffect(Schema.fromJsonString(SmokeArtifact))

const smoke = Effect.fn("ExecutorImageSmoke.run")(function* (buildId: string) {
  yield* Effect.acquireUseRelease(
    Effect.tryPromise(() =>
      Sandbox.create(`rika-executor-v1:${buildId}`, {
        timeoutMs: 300_000,
        secure: true,
        allowInternetAccess: true,
        envs: {
          RIKA_EXECUTOR_TEMPLATE_BUILD_ID: buildId,
          RIKA_DOCTOR_NETWORK_URL: "https://example.com/",
        },
      }),
    ),
    (sandbox) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise(() =>
          sandbox.commands.run("rika executor doctor --json", { timeoutMs: 180_000 }),
        ).pipe(Effect.flatMap((command) => decodeDoctorResult(command.stdout)))
        if (
          result.ok !== true ||
          result.buildId !== buildId ||
          result.checks.some((check) => check.ok !== true)
        )
          return yield* SmokeError.make({ message: "Promoted E2B image failed its doctor contract" })
        const artifact = yield* encodeSmokeArtifact({ ...result, sandboxId: sandbox.sandboxId })
        yield* Effect.tryPromise(() =>
          Bun.write("executor-smoke.json", `${artifact}\n`),
        )
      }),
    (sandbox) => Effect.tryPromise(() => sandbox.kill()).pipe(Effect.ignore),
  )
})

const command = Command.make(
  "image-smoke",
  { buildId: Argument.string("build-id") },
  ({ buildId }) => smoke(buildId),
)

const main = Command.run(command, { version: "0.0.0" })

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
  )
