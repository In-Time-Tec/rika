import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, PlatformError, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { runBehavioralProbes, runBoundedProbe } from "../../scripts/release/release-smoke"

const SmokeInvocations = Schema.Array(
  Schema.Struct({ purpose: Schema.String, arguments: Schema.Array(Schema.String) }),
)

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.mkString(Stream.decodeText(stream))

it.layer(BunServices.layer)("release smoke", (test) => {
  test.effect("uses one packaged in-process client and only the public Runner entrypoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const child = yield* spawner.spawn(
          ChildProcess.make("bun", ["run", "scripts/release/release-smoke.ts", "--dry-run"]),
        )
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [child.exitCode, collect(child.stdout), collect(child.stderr)],
          { concurrency: "unbounded" },
        )

        expect(Number(exitCode)).toBe(0)
        expect(stderr).toBe("")
        const invocations = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SmokeInvocations))(stdout)
        expect(invocations).toEqual([
          { purpose: "version", arguments: ["--version"] },
          { purpose: "public help", arguments: ["--help"] },
          { purpose: "in-process client PTY", arguments: [] },
          { purpose: "public runner unauthenticated", arguments: ["--no-tui"] },
        ])
        expect(stdout).not.toMatch(/private-runtime-role|--internal-|RIKA_INTERNAL_/)
      }),
    ),
  )

  test.effect.each([0, 130])(
    "accepts documented PTY SIGINT exit %i and reaches unauthenticated Runner dispatch",
    (sigintExitCode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-release-smoke-test-" })
          const binary = path.join(root, "rika")
          yield* fileSystem.writeFileString(
            binary,
            `#!/bin/sh
if [ "$1" = "--no-tui" ]; then
  echo 'Run rika auth login first' >&2
  exit 1
fi
test ! -e "$HOME/.config/rika/hosted.json" || exit 3
trap 'exit ${sigintExitCode}' INT
printf '\\033[?2026hfixture frame\\033[?2026l'
while :; do sleep 1; done
`,
          )
          yield* fileSystem.chmod(binary, 0o755)

          const result = yield* Effect.tryPromise(() => runBehavioralProbes(binary, root))

          expect(result.client.output).toContain("fixture frame")
          expect(result.client.exitCode).toBe(sigintExitCode)
          expect(result.runner.exitCode).toBe(1)
          expect(result.runner.stderr).toContain("Run rika auth login first")
        }),
      ),
  )

  test.effect.each(["--version", "--help"])("times out and cleans up a hanging %s probe", (argument) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-release-smoke-hang-" })
        const binary = path.join(root, "rika")
        yield* fileSystem.writeFileString(binary, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n")
        yield* fileSystem.chmod(binary, 0o755)

        const result = yield* Effect.exit(Effect.tryPromise(() => runBoundedProbe(binary, [argument], root, 50)))
        expect(result).toHaveProperty("_tag", "Failure")
        expect(String(result)).toContain(`${argument} probe timed out`)
      }),
    ),
  )
})
