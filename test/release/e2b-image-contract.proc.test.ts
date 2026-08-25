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

const run = Effect.fn("e2bImageContract.run")(function* (parts: ReadonlyArray<string>, timeout = 30_000) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(
        ChildProcess.make(parts[0]!, parts.slice(1), {
          cwd: root.pathname,
          detached: false,
          forceKillAfter: "5 seconds",
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      const [stdout, stderr] = yield* Effect.all([collect(child.stdout), collect(child.stderr)], {
        concurrency: "unbounded",
      })
      const exitCode = yield* child.exitCode.pipe(
        Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
      )
      if (exitCode === undefined) yield* child.unref.pipe(Effect.asVoid)
      else if (Number(exitCode) !== 0)
        return yield* CommandError.make({
          message: `${parts.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}`,
        })
      return { stdout: stdout.trim(), stderr: stderr.trim() }
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => CommandError.make({ message: `${parts.join(" ")} timed out after ${timeout}ms` }),
    }),
  )
})

const commandReady = Effect.fn("e2bImageContract.commandReady")(function* (command: ReadonlyArray<string>) {
  return yield* run([...command, "version"]).pipe(
    Effect.map(({ stdout }) => stdout.length > 0),
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
  it.layer(BunServices.layer, { excludeTestServices: true })((test) =>
    test.effect(
      "builds the pinned image and executes its complete doctor contract",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const tag = `rika-executor-contract:${process.pid}`
            yield* Effect.addFinalizer(() =>
              run([...containerCommand!, "image", "rm", "--force", tag]).pipe(Effect.ignore),
            )
            const build = yield* spawner.spawn(
              ChildProcess.make(
                containerCommand![0],
                [
                  ...containerCommand!.slice(1),
                  "build",
                  "--pull",
                  "--file",
                  "infra/e2b/executor-v1/e2b.Dockerfile",
                  "--tag",
                  tag,
                  ".",
                ],
                {
                  cwd: root.pathname,
                  detached: false,
                  forceKillAfter: "5 seconds",
                  stdin: "ignore",
                  stdout: "inherit",
                  stderr: "inherit",
                },
              ),
            )
            yield* Effect.gen(function* () {
              while (true) {
                const image = yield* run([...containerCommand!, "image", "inspect", tag]).pipe(
                  Effect.orElseSucceed(() => ({ stdout: "", stderr: "" })),
                )
                if (image.stdout.length > 0) return
                yield* Effect.sleep("250 millis")
              }
            }).pipe(
              Effect.timeoutOrElse({
                duration: 300_000,
                orElse: () => CommandError.make({ message: `executor image build timed out after 300000ms` }),
              }),
            )
            yield* build.unref.pipe(Effect.asVoid)
            const doctorContainer = `rika-executor-doctor-${process.pid}`
            yield* Effect.addFinalizer(() =>
              run([...containerCommand!, "rm", "--force", doctorContainer]).pipe(Effect.ignore),
            )
            const doctorId = (yield* run(
              [
                ...containerCommand!,
                "run",
                "--detach",
                "--name",
                doctorContainer,
                "--entrypoint",
                "rika",
                "--env",
                "RIKA_DOCTOR_NETWORK_URL=https://example.com/",
                tag,
                "executor",
                "doctor",
                "--json",
              ],
              120_000,
            )).stdout
            if (doctorId.length === 0)
              return yield* CommandError.make({ message: "executor image doctor container did not start" })
            yield* Effect.gen(function* () {
              while (true) {
                const state = yield* run([
                  ...containerCommand!,
                  "inspect",
                  "--format",
                  "{{.State.Status}}",
                  doctorContainer,
                ])
                if (state.stdout === "exited") return
                yield* Effect.sleep("250 millis")
              }
            }).pipe(
              Effect.timeoutOrElse({
                duration: 120_000,
                orElse: () => CommandError.make({ message: "executor image doctor timed out after 120000ms" }),
              }),
            )
            const output = (yield* run([...containerCommand!, "logs", doctorContainer])).stdout
            const result = yield* Schema.decodeEffect(Schema.fromJsonString(DoctorResult))(output)
            const manifestBytes = yield* fileSystem.readFile(new URL("tool-manifest.json", imageRoot).pathname)
            const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(ToolManifest))(
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

            const container = (yield* run([...containerCommand!, "run", "--detach", "--rm", tag], 120_000)).stdout
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
                Effect.map(({ stdout }) => stdout === "ready"),
                Effect.orElseSucceed(() => false),
              )
              if (!ready) yield* Effect.sleep("250 millis")
            }
            expect(ready).toBe(true)
            expect(
              (yield* run([...containerCommand!, "inspect", "--format", "{{.Config.User}}", container])).stdout,
            ).toBe("rika-executor")
          }),
        ),
      900_000,
    ),
  )
})
