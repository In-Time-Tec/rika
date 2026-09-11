import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { RepositoryInputError, RepositoryTransport, type RepositoryTransportContract } from "../src/repository"

export const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

export const runGit = Effect.fn("RepositoryInputTest.runGit")(function* (
  directory: string,
  arguments_: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.exitCode(
    ChildProcess.make("git", ["-C", directory, ...arguments_], { stdout: "ignore", stderr: "ignore" }),
  )
  if (Number(child) !== 0) return yield* Effect.die(`git exited ${child}`)
})

export const gitOutput = Effect.fn("RepositoryInputTest.gitOutput")(function* (
  directory: string,
  arguments_: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const output = yield* spawner.string(
    ChildProcess.make("git", ["-C", directory, ...arguments_], { stderr: "ignore", stdout: "pipe" }),
  )
  return output.trim()
})

export const layerLocalRepositoryTransport = (
  source: string,
): Layer.Layer<RepositoryTransport, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    RepositoryTransport,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fetch: RepositoryTransportContract["fetch"] = (request) =>
        spawner
          .exitCode(
            ChildProcess.make(
              "git",
              [
                "-c",
                "protocol.file.allow=always",
                "-c",
                "fetch.unpackLimit=1",
                "--git-dir",
                request.directory,
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-write-fetch-head",
                "--depth=1",
                "--no-recurse-submodules",
                source,
                `${request.commitSha}:refs/heads/rika-input`,
              ],
              { stderr: "ignore", stdout: "ignore" },
            ),
          )
          .pipe(
            Effect.mapError(() => RepositoryInputError.make({ kind: "git", message: "Local repository fetch failed" })),
            Effect.flatMap((code) =>
              Number(code) === 0
                ? Effect.void
                : Effect.fail(RepositoryInputError.make({ kind: "git", message: "Local repository fetch failed" })),
            ),
          )
      return RepositoryTransport.of({ fetch })
    }),
  )
