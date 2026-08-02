import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { parseChangedFiles } from "../src/interactive/process/process-files"
import { readChangedFiles } from "../src/interactive/process/process-workspace"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

const command = (name: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    return yield* spawner.exitCode(ChildProcess.make(name, args))
  })

test(
  "loads tracked counts from a repository without HEAD and omits untracked counts",
  () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-unborn-head-" })
          yield* command("git", "init", "-q", root)
          yield* fileSystem.writeFileString(path.join(root, "staged.ts"), "one\ntwo\nthree\n")
          yield* fileSystem.writeFileString(path.join(root, "untracked.ts"), "one\ntwo")
          yield* command("git", "-C", root, "add", "staged.ts")
          expect(yield* readChangedFiles(root)).toEqual([
            { path: "staged.ts", status: "A", added: 3, removed: 0 },
            { path: "untracked.ts", status: "??" },
          ])
        }),
      ),
    ),
  15_000,
)

test(
  "does not read untracked file contents while listing changed files",
  () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-untracked-files-" })
          yield* command("git", "init", "-q", root)
          const paths = Array.from({ length: 256 }, (_, index) => `untracked-${index}.ts`)
          yield* Effect.forEach(
            paths,
            (relative) => fileSystem.writeFileString(path.join(root, relative), "one\ntwo\nthree\n"),
            { concurrency: 16, discard: true },
          )
          let readFileCalls = 0
          const countingFileSystem: FileSystem.FileSystem = {
            ...fileSystem,
            readFile: (filename) => {
              readFileCalls += 1
              return fileSystem.readFile(filename)
            },
          }

          const changed = yield* readChangedFiles(root).pipe(
            Effect.provideService(FileSystem.FileSystem, countingFileSystem),
          )
          expect(changed).toHaveLength(paths.length)
          expect(readFileCalls).toBe(0)
          expect(changed.every((file) => file.added === undefined && file.removed === undefined)).toBe(true)
        }),
      ),
    ),
  15_000,
)

test(
  "parses the exact NUL-delimited output from a real Git repository",
  () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const spawner = yield* ChildProcessSpawner
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-changed-files-" })
          yield* command("git", "init", "-q", root)
          yield* command("git", "-C", root, "config", "user.email", "test@example.com")
          yield* command("git", "-C", root, "config", "user.name", "Test")
          yield* fileSystem.writeFileString(path.join(root, "old name.ts"), "one\ntwo\nthree\n")
          yield* command("git", "-C", root, "add", ".")
          yield* command("git", "-C", root, "commit", "-qm", "initial")
          yield* fileSystem.makeDirectory(path.join(root, "docs", "nested"), { recursive: true })
          yield* fileSystem.makeDirectory(path.join(root, "untracked", "deep"), { recursive: true })
          yield* command("git", "-C", root, "mv", "old name.ts", "docs/nested/new -> name.ts")
          yield* fileSystem.writeFileString(path.join(root, "untracked", "deep", "file with spaces.ts"), "new")
          const status = yield* spawner.string(
            ChildProcess.make("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"]),
          )
          const numstat = yield* spawner.string(
            ChildProcess.make("git", ["-C", root, "diff", "--numstat", "-z", "-M", "HEAD"]),
          )
          expect(parseChangedFiles(status, numstat)).toEqual([
            { path: "docs/nested/new -> name.ts", status: "R", added: 0, removed: 0 },
            { path: "untracked/deep/file with spaces.ts", status: "??" },
          ])
        }),
      ),
    ),
  15_000,
)
