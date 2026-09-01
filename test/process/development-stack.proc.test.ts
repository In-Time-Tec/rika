import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Config, Effect, FileSystem, Layer, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

const temporaryRoot = Effect.fn("DevelopmentStackTest.temporaryRoot")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-development-stack-" })
  const bin = path.join(root, "bin")
  yield* fileSystem.makeDirectory(bin)
  yield* fileSystem.writeFileString(
    path.join(bin, "alchemy"),
    `#!/bin/sh
printf '%s\\0' "$@" > "$RIKA_TEST_ARGUMENTS"
printf '%s\\n' "$RIKA_ALCHEMY_TARGET:$RIKA_ALCHEMY_OPERATION" > "$RIKA_TEST_TARGET"
stage="$5"
if [ "$1" = deploy ]; then
  mkdir -p ".alchemy/state/Rika/$stage"
  printf '{"resourceType":"Railway.Project","props":{"name":"rika-%s"},"attr":{"projectId":"project-1"}}\\n' "$stage" > ".alchemy/state/Rika/$stage/Project.json"
elif [ "$1" = destroy ] && [ "\${FAKE_EXIT_CODE:-0}" = 0 ]; then
  rm -rf ".alchemy/state/Rika/$stage"
fi
exit "\${FAKE_EXIT_CODE:-0}"
`,
    { mode: 0o700 },
  )
  return root
})

const run = Effect.fn("DevelopmentStackTest.run")(function* (
  root: string,
  operation: "local" | "remote" | "destroy",
  exitCode = 0,
  extraArguments: ReadonlyArray<string> = [],
) {
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const systemPath = yield* Config.string("PATH")
  const argumentsPath = path.join(root, "arguments")
  const targetPath = path.join(root, "target")
  const wrapper = path.resolve(process.cwd(), "scripts/development/stack.ts")
  const child = yield* Effect.acquireRelease(
    spawner.spawn(
      ChildProcess.make(process.execPath, [wrapper, operation, ...extraArguments], {
        cwd: root,
        env: {
          PATH: `${path.join(root, "bin")}:${systemPath}`,
          ALCHEMY_STAGE: "production",
          FAKE_EXIT_CODE: String(exitCode),
          RIKA_TEST_ARGUMENTS: argumentsPath,
          RIKA_TEST_TARGET: targetPath,
        },
        extendEnv: true,
        stdout: "pipe",
        stderr: "pipe",
      }),
    ),
    (process) => process.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore),
  )
  const [code, stdout, stderr] = yield* Effect.all([child.exitCode, collect(child.stdout), collect(child.stderr)], {
    concurrency: 3,
  })
  return { code: Number(code), stdout, stderr, argumentsPath, targetPath }
})

const argumentsOf = Effect.fn("DevelopmentStackTest.argumentsOf")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem
  return (yield* fileSystem.readFileString(path)).split("\0").filter(Boolean)
})

it.effect("local development delegates to Alchemy without a Railway identity", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* temporaryRoot()
      const local = yield* run(root, "local")
      expect(local.code, local.stderr).toBe(0)
      expect(yield* argumentsOf(local.argumentsPath)).toEqual(["dev"])
      expect((yield* fileSystem.readFileString(local.targetPath)).trim()).toBe("local:local")
      expect(yield* fileSystem.exists(path.join(root, ".alchemy/rika-dev-stage"))).toBe(false)
    }),
  ),
)

it.effect("remote deployment and destroy use only the persistent guarded stage", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* temporaryRoot()
      const deployed = yield* run(root, "remote")
      expect(deployed.code, deployed.stderr).toBe(0)
      const identity = path.join(root, ".alchemy/rika-dev-stage")
      const stage = (yield* fileSystem.readFileString(identity)).trim()
      expect(stage).toMatch(/^dev-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
      expect(yield* argumentsOf(deployed.argumentsPath)).toEqual([
        "deploy",
        "--config",
        "alchemy.run.ts",
        "--stage",
        stage,
        "--adopt",
        "--force",
        "--yes",
      ])
      expect((yield* fileSystem.readFileString(deployed.targetPath)).trim()).toBe("railway:remote")

      const destroyed = yield* run(root, "destroy")
      expect(destroyed.code, destroyed.stderr).toBe(0)
      expect(yield* argumentsOf(destroyed.argumentsPath)).toEqual([
        "destroy",
        "--config",
        "alchemy.run.ts",
        "--stage",
        stage,
        "--yes",
      ])
      expect((yield* fileSystem.readFileString(destroyed.targetPath)).trim()).toBe("railway:destroy")
      expect((yield* fileSystem.readFileString(identity)).trim()).toBe(stage)
      expect(yield* fileSystem.exists(path.join(root, ".alchemy", "state", "Rika", stage))).toBe(true)
    }),
  ),
)

it.effect("failed deployment propagates its exit and preserves the retry identity", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* temporaryRoot()
      const failed = yield* run(root, "remote", 23)
      expect(failed.code, failed.stderr).toBe(23)
      const identity = path.join(root, ".alchemy/rika-dev-stage")
      const stage = (yield* fileSystem.readFileString(identity)).trim()
      const retried = yield* run(root, "remote")
      expect(retried.code, retried.stderr).toBe(0)
      expect((yield* fileSystem.readFileString(identity)).trim()).toBe(stage)
    }),
  ),
)

it.effect("destroy without a valid identity never invokes Alchemy", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* temporaryRoot()
      const missing = yield* run(root, "destroy")
      expect(missing.code).not.toBe(0)
      expect(yield* fileSystem.exists(missing.argumentsPath)).toBe(false)

      yield* fileSystem.makeDirectory(path.join(root, ".alchemy"), { recursive: true })
      yield* fileSystem.writeFileString(
        path.join(root, ".alchemy/rika-dev-stage"),
        "dev-01234567-89ab-4cde-8fab-0123456789ab\n",
        { mode: 0o600 },
      )
      const unattested = yield* run(root, "destroy")
      expect(unattested.code).not.toBe(0)
      expect(yield* fileSystem.exists(unattested.argumentsPath)).toBe(false)

      yield* fileSystem.writeFileString(path.join(root, ".alchemy/rika-dev-stage"), "production\n", { mode: 0o600 })
      const protectedStage = yield* run(root, "destroy")
      expect(protectedStage.code).not.toBe(0)
      expect(yield* fileSystem.exists(protectedStage.argumentsPath)).toBe(false)
    }),
  ),
)

it.effect("rejects every forwarded argument before invoking Alchemy", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* temporaryRoot()
      const overridden = yield* run(root, "remote", 0, ["--stage", "production"])
      expect(overridden.code).not.toBe(0)
      expect(yield* fileSystem.exists(overridden.argumentsPath)).toBe(false)
    }),
  ),
)

it.effect("rejects a symbolic-link project attestation before destroy", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* temporaryRoot()
      const deployed = yield* run(root, "remote")
      expect(deployed.code, deployed.stderr).toBe(0)
      const stage = (yield* fileSystem.readFileString(path.join(root, ".alchemy/rika-dev-stage"))).trim()
      const projectState = path.join(root, ".alchemy", "state", "Rika", stage, "Project.json")
      const redirected = path.join(root, "redirected-project-state.json")
      yield* fileSystem.writeFileString(redirected, yield* fileSystem.readFileString(projectState), { mode: 0o600 })
      yield* fileSystem.remove(projectState)
      yield* fileSystem.symlink(redirected, projectState)
      yield* fileSystem.remove(deployed.argumentsPath)

      const destroyed = yield* run(root, "destroy")
      expect(destroyed.code).not.toBe(0)
      expect(yield* fileSystem.exists(destroyed.argumentsPath)).toBe(false)
    }),
  ),
)
