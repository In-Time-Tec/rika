import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Sandbox } from "e2b"
import { Effect, Layer, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"

const ImageManifest = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  aptPackages: Schema.Array(Schema.Struct({ name: Schema.String })),
})
const DoctorResult = Schema.Struct({
  ok: Schema.Boolean,
  image: Schema.Literal("rika-executor-v1"),
  manifestSchemaVersion: Schema.Literal(1),
  buildId: Schema.String,
  manifestSha256: Schema.String,
  manifestToolCount: Schema.Int,
  manifestPackageCount: Schema.Int,
  checks: Schema.Array(Schema.Struct({ name: Schema.String, ok: Schema.Boolean, detail: Schema.String })),
})
const SmokeArtifact = Schema.Struct({ ...DoctorResult.fields, sandboxId: Schema.String })
const requiredChecks = [
  "workspace:ready",
  "kernel:persistence",
  "browser:headless",
  "network:outbound",
  "credentials:absent",
  "credentials:broker-ready",
] as const

const acceptsDoctorResult = (
  result: typeof DoctorResult.Type,
  buildId: string,
  manifestSha256: string,
  manifest: typeof ImageManifest.Type,
) => {
  const names = new Set(result.checks.map(({ name }) => name))
  return (
    result.ok === true &&
    result.buildId === buildId &&
    result.manifestSha256 === manifestSha256 &&
    result.manifestToolCount === manifest.tools.length &&
    result.manifestPackageCount === manifest.aptPackages.length &&
    result.checks.every((check) => check.ok === true) &&
    names.size === result.checks.length &&
    manifest.tools.every(({ name }) => names.has(`tool:${name}`)) &&
    manifest.aptPackages.every(({ name }) => names.has(`package:${name}`)) &&
    requiredChecks.every((name) => names.has(name))
  )
}

export const testing = { acceptsDoctorResult } as const

class SmokeError extends Schema.TaggedError<SmokeError>()("SmokeError", { message: Schema.String }) {}

const decodeImageManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ImageManifest))
const decodeDoctorResult = Schema.decodeUnknownEffect(Schema.fromJsonString(DoctorResult))
const encodeSmokeArtifact = Schema.encodeEffect(Schema.fromJsonString(SmokeArtifact))

const smoke = Effect.fn("ExecutorImageSmoke.run")(function* (
  templateId: string,
  buildId: string,
  manifestSha256: string,
) {
  const environment = {
    HOME: "/home/rika-executor",
    LANG: "en_US.UTF-8",
    PATH: "/run/rika/bin:/opt/rika-python/bin:/usr/local/bin:/usr/bin:/bin",
    GH_CONFIG_DIR: "/run/rika/gh",
    RIKA_IMAGE_MANIFEST: "/opt/rika/tool-manifest.json",
    RIKA_EXECUTOR_WORKSPACE: "/home/rika-workspace/workspace/repo",
    RIKA_EXECUTOR_TEMPLATE_BUILD_ID: buildId,
    RIKA_DOCTOR_NETWORK_URL: "https://example.com/",
  }
  const manifest = yield* Effect.tryPromise(() =>
    Bun.file(new URL("../../../infra/e2b/executor-v1/tool-manifest.json", import.meta.url)).text(),
  ).pipe(Effect.flatMap(decodeImageManifest))
  yield* Effect.acquireUseRelease(
    Effect.tryPromise(() =>
      Sandbox.create(`${templateId}:${buildId}`, {
        timeoutMs: 300_000,
        secure: true,
        allowInternetAccess: true,
        envs: environment,
      }),
    ),
    (sandbox) =>
      Effect.gen(function* () {
        const user = yield* Effect.tryPromise(() =>
          sandbox.commands.run("id -un", { user: "rika-executor", envs: environment }),
        )
        if (user.stdout.trim() !== "rika-executor")
          return yield* SmokeError.make({ message: `Promoted E2B command user is ${user.stdout.trim()}` })
        const result = yield* Effect.tryPromise(() =>
          sandbox.commands.run('rika executor doctor --json || [ "$?" -eq 1 ]', {
            timeoutMs: 180_000,
            user: "rika-executor",
            envs: environment,
          }),
        ).pipe(Effect.flatMap((command) => decodeDoctorResult(command.stdout)))
        const artifact = yield* encodeSmokeArtifact({ ...result, sandboxId: sandbox.sandboxId })
        yield* Effect.tryPromise(() => Bun.write("executor-smoke.json", `${artifact}\n`))
        if (!acceptsDoctorResult(result, buildId, manifestSha256, manifest)) {
          const failed = result.checks.filter(({ ok }) => !ok).map(({ name, detail }) => `${name}: ${detail}`)
          return yield* SmokeError.make({
            message: failed.length === 0 ? "Promoted E2B image failed its doctor contract" : failed.join("; "),
          })
        }
      }),
    (sandbox) => Effect.tryPromise(() => sandbox.kill()).pipe(Effect.ignore),
  )
})

const command = Command.make(
  "image-smoke",
  {
    templateId: Argument.string("template-id"),
    buildId: Argument.string("build-id"),
    manifestSha256: Argument.string("manifest-sha256"),
  },
  ({ templateId, buildId, manifestSha256 }) => smoke(templateId, buildId, manifestSha256),
)

const main = Command.run(command, { version: "0.0.0" })

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
  )
