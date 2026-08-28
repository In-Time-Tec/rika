import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { restoreArchive } from "@rika/remote-execution/workspace-archive"
import { Effect, FileSystem } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { prepareWorkspaceSeed, sourceRepository } from "../../../src/hosted/workspace/seed"

it.each([
  ["https://github.com/In-Time-Tec/rika.git", { owner: "In-Time-Tec", name: "rika" }],
  ["ssh://git@github.com/In-Time-Tec/rika.git", { owner: "In-Time-Tec", name: "rika" }],
  ["git@github.com:In-Time-Tec/rika.git", { owner: "In-Time-Tec", name: "rika" }],
])("identifies the GitHub repository from %s", (remote, expected) => {
  expect(sourceRepository(remote)).toEqual(expected)
})

it.each([undefined, "https://gitlab.com/In-Time-Tec/rika.git", "not a remote"])(
  "does not claim a GitHub repository for %s",
  (remote) => {
    expect(sourceRepository(remote)).toBeUndefined()
  },
)

it.layer(BunServices.layer)((test) => {
  test.effect("captures the repository root when Rika starts from a nested folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-seed-root-" })
        const target = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-seed-target-" })
        yield* fileSystem.makeDirectory(`${root}/nested`, { recursive: true })
        yield* fileSystem.writeFileString(`${root}/root.txt`, "root state")
        yield* fileSystem.writeFileString(`${root}/nested/local.txt`, "nested state")
        for (const arguments_ of [
          ["init", "--quiet"],
          ["remote", "add", "origin", "git@github.com:In-Time-Tec/rika.git"],
          ["add", "root.txt", "nested/local.txt"],
        ]) {
          const code = yield* spawner.exitCode(ChildProcess.make("git", ["-C", root, ...arguments_]))
          if (Number(code) !== 0) return yield* Effect.die(`git exited ${code}`)
        }

        const seed = yield* prepareWorkspaceSeed(`${root}/nested`)
        yield* restoreArchive(target, seed.archive)

        expect(seed.sourceRepository).toEqual({ owner: "In-Time-Tec", name: "rika" })
        expect(yield* fileSystem.readFileString(`${target}/root.txt`)).toBe("root state")
        expect(yield* fileSystem.readFileString(`${target}/nested/local.txt`)).toBe("nested state")
      }),
    ),
  )
})
