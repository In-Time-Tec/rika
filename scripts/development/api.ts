import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Data, Deferred, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { DevelopmentTemplateIdentity } from "../../packages/e2b-executor/src/development-template"
import { spawnOwned } from "./owned-child-process"

class DevelopmentApiError extends Data.TaggedError("DevelopmentApiError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const failure = (message: string, cause?: unknown) => new DevelopmentApiError({ message, cause })
const apiCommand = ChildProcess.make("bun", ["./src/main.ts"], {
  cwd: "apps/api",
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
})

const exitSuccessfully = (process: string, exitCode: number) =>
  exitCode === 0 ? Effect.void : Effect.fail(failure(`${process} exited with code ${exitCode}`))

const program = Effect.gen(function* () {
  const target = yield* Config.option(Config.string("RIKA_DEV_EXECUTOR_ORIGIN"))
  if (Option.isNone(target)) {
    const api = yield* spawnOwned(apiCommand)
    return yield* api.exitCode.pipe(Effect.flatMap((exitCode) => exitSuccessfully("API", Number(exitCode))))
  }

  const fileSystem = yield* FileSystem.FileSystem
  const sourceDigest = yield* Config.string("RIKA_DEV_E2B_SOURCE_DIGEST")
  const identityPath = yield* Config.string("RIKA_DEV_E2B_IDENTITY_PATH")
  const identity = yield* fileSystem.readFileString(identityPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DevelopmentTemplateIdentity))),
    Effect.mapError((cause) => failure("Development E2B template identity is invalid", cause)),
  )
  if (identity.sourceDigest !== sourceDigest)
    return yield* failure("Development E2B template does not match the current source")

  const tunnel = yield* spawnOwned(
    ChildProcess.make("cloudflared", ["tunnel", "--no-autoupdate", "--url", target.value], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    }),
  )
  const published = yield* Deferred.make<string>()
  let pending = ""
  yield* Stream.runForEach(Stream.decodeText(tunnel.stderr), (chunk) => {
    pending = `${pending}${chunk}`.slice(-4096)
    const url = pending.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0]
    return url === undefined ? Effect.void : Deferred.succeed(published, url).pipe(Effect.asVoid)
  }).pipe(Effect.forkScoped)
  const publicExecutorOrigin = yield* Deferred.await(published).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(failure("Cloudflare tunnel did not publish a URL")),
    }),
  )
  const executor = new URL("/api/v1/executors", publicExecutorOrigin)
  executor.protocol = "wss:"
  const api = yield* spawnOwned(
    ChildProcess.make("bun", ["./src/main.ts"], {
      cwd: "apps/api",
      env: {
        E2B_TEMPLATE_ID: identity.templateId,
        E2B_TEMPLATE_BUILD_ID: identity.buildId,
        RIKA_EXECUTOR_API_URL: executor.toString(),
      },
      extendEnv: true,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }),
  )
  const exited = yield* Effect.race(
    api.exitCode.pipe(Effect.map((exitCode) => ({ process: "API", exitCode: Number(exitCode) }))),
    tunnel.exitCode.pipe(Effect.map((exitCode) => ({ process: "Cloudflare tunnel", exitCode: Number(exitCode) }))),
  )
  if (exited.process !== "API")
    return yield* failure(`${exited.process} exited unexpectedly with code ${exited.exitCode}`)
  return yield* exitSuccessfully(exited.process, exited.exitCode)
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
  )
