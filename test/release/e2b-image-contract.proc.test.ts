import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import { Effect, FileSystem, PlatformError, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { live } from "../support/platform"

const root = new URL("../..", import.meta.url)
const imageRoot = new URL("../../infra/e2b/executor-v1/", import.meta.url)

class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  message: Schema.String,
}) {}

const DoctorResult = Schema.Struct({
  ok: Schema.Boolean,
  image: Schema.String,
  buildId: Schema.String,
  manifestSha256: Schema.String,
  manifestToolCount: Schema.Finite,
  manifestPackageCount: Schema.Finite,
  checks: Schema.Array(Schema.Struct({ name: Schema.String, ok: Schema.Boolean })),
})
const ToolManifest = Schema.Struct({
  tools: Schema.Array(Schema.Unknown),
  aptPackages: Schema.Array(Schema.Unknown),
})

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => output + chunk,
    ),
  )

const run = Effect.fn("e2bImageContract.run")(function* (parts: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(
    ChildProcess.make(parts[0]!, parts.slice(1), { cwd: root.pathname, stdout: "pipe", stderr: "pipe" }),
  )
  const [exitCode, stdout, stderr] = yield* Effect.all([child.exitCode, collect(child.stdout), collect(child.stderr)], {
    concurrency: "unbounded",
  })
  if (Number(exitCode) !== 0)
    return yield* CommandError.make({ message: `${parts.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}` })
  return stdout.trim()
})

const commandReady = Effect.fn("e2bImageContract.commandReady")(function* (command: ReadonlyArray<string>) {
  return yield* run([...command, "version"]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
})

const detectContainerCommand = Effect.gen(function* () {
  if (yield* commandReady(["docker"])) return ["docker"] as const
  if (yield* commandReady(["sudo", "-n", "podman"])) return ["sudo", "podman", "--cgroup-manager=cgroupfs"] as const
  if (yield* commandReady(["podman"])) return ["podman"] as const
  return undefined
})

const containerCommand = await Effect.runPromise(live(detectContainerCommand))

describe.skipIf(containerCommand === undefined)("E2B executor image", () => {
  it.layer(BunServices.layer)("builds the pinned image and executes its complete doctor contract", (test) =>
    test.effect(
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const tag = `rika-executor-contract:${process.pid}`
            yield* Effect.addFinalizer(() =>
              run([...containerCommand!, "image", "rm", "--force", tag]).pipe(Effect.ignore),
            )
            yield* run([
              ...containerCommand!,
              "build",
              "--pull",
              "--file",
              "infra/e2b/executor-v1/e2b.Dockerfile",
              "--tag",
              tag,
              ".",
            ])
            const output = yield* run([
              ...containerCommand!,
              "run",
              "--rm",
              "--entrypoint",
              "rika",
              "--env",
              "RIKA_DOCTOR_NETWORK_URL=https://example.com/",
              tag,
              "executor",
              "doctor",
              "--json",
            ])
            const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DoctorResult))(output)
            const manifestBytes = yield* fileSystem.readFile(new URL("tool-manifest.json", imageRoot).pathname)
            const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ToolManifest))(
              new TextDecoder().decode(manifestBytes),
            )
            expect(result.ok).toBe(true)
            expect(result.image).toBe("rika-executor-v1")
            expect(result.buildId).toBe("template-readiness")
            expect(result.manifestSha256).toBe(createHash("sha256").update(manifestBytes).digest("hex"))
            expect(result.manifestToolCount).toBe(manifest.tools.length)
            expect(result.manifestPackageCount).toBe(manifest.aptPackages.length)
            expect(result.checks.length).toBeGreaterThan(30)
            expect(result.checks.every(({ ok }) => ok)).toBe(true)
            const names = new Set(result.checks.map(({ name }) => name))
            expect(names.size).toBe(result.checks.length)
            for (const name of [
              "workspace:ready",
              "kernel:persistence",
              "browser:headless",
              "network:outbound",
              "credentials:absent",
              "credentials:broker-ready",
            ])
              expect(names).toContain(name)

            const container = yield* run([...containerCommand!, "run", "--detach", "--rm", tag])
            yield* Effect.addFinalizer(() =>
              run([...containerCommand!, "rm", "--force", container]).pipe(Effect.ignore),
            )
            let ready = false
            for (let attempt = 0; attempt < 40 && !ready; attempt++) {
              ready = yield* run([
                ...containerCommand!,
                "exec",
                container,
                "curl",
                "--fail",
                "--silent",
                "http://127.0.0.1:7070/health",
              ]).pipe(
                Effect.map((health) => health === "ready"),
                Effect.orElseSucceed(() => false),
              )
              if (!ready) yield* Effect.sleep("250 millis")
            }
            expect(ready).toBe(true)
            expect(yield* run([...containerCommand!, "inspect", "--format", "{{.Config.User}}", container])).toBe(
              "rika-executor",
            )
          }),
        ),
      900_000,
    ),
  )
})
