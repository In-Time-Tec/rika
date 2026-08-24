import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { expect, test } from "vitest"
import { packedTarballName, tarballDirectory, tarballPrefix } from "../../scripts/upstream/upstream-package-contract"
import { extractedDigest, packSibling } from "../../scripts/upstream/upstream-sibling-pack"
import { directoryDigest } from "../../scripts/upstream/upstream-content-digest"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

class InstallError extends Schema.TaggedError<InstallError>()("InstallError", {
  stderr: Schema.String,
}) {}

const sibling = Effect.fn("UpstreamLinkTest.sibling")(function* (directory: string, marker: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fileSystem.makeDirectory(path.join(directory, "dist"), { recursive: true })
  yield* fileSystem.writeFileString(
    path.join(directory, "package.json"),
    '{\n  "name": "@upstream-fixture/library",\n  "version": "1.2.3",\n  "main": "dist/library.js",\n  "files": [\n    "dist"\n  ]\n}\n',
  )
  yield* fileSystem.writeFileString(path.join(directory, "dist", "library.js"), `export const marker = "${marker}"\n`)
})

const pack = Effect.fn("UpstreamLinkTest.pack")(function* (source: string, destination: string) {
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.remove(destination, { recursive: true, force: true })
  yield* fileSystem.makeDirectory(destination, { recursive: true })
  const packed = yield* packSibling(source, destination)
  expect(packed).toBeDefined()
  return packed
})

const installedMarker = Effect.fn("UpstreamLinkTest.installedMarker")(function* (consumer: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fileSystem.readFileString(
    path.join(consumer, "node_modules", "@upstream-fixture", "library", "dist", "library.js"),
  )
})

const install = Effect.fn("UpstreamLinkTest.install")(function* (consumer: string, specifier: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  yield* fileSystem.writeFileString(
    path.join(consumer, "package.json"),
    `{\n  "name": "upstream-fixture-consumer",\n  "version": "0.0.0",\n  "dependencies": {\n    "@upstream-fixture/library": "${specifier}"\n  }\n}\n`,
  )
  const child = yield* spawner.spawn(
    ChildProcess.make("bun", ["install"], { cwd: consumer, stdout: "ignore", stderr: "pipe" }),
  )
  const [exitCode, stderr] = yield* Effect.all(
    [child.exitCode, Stream.mkString(Stream.decodeText(child.stderr))],
    { concurrency: 2 },
  )
  if (exitCode !== 0) return yield* InstallError.make({ stderr })
})

test("re-linking a rebuilt sibling installs the rebuilt content instead of the previously cached copy", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-upstream-link-" })
        const source = path.join(workspace, "sibling")
        const consumer = path.join(workspace, "consumer")
        const artifacts = path.join(consumer, tarballDirectory)
        const staging = path.join(workspace, "staging")
        yield* fileSystem.makeDirectory(artifacts, { recursive: true })
        yield* sibling(source, "BEFORE_REBUILD")

        const first = yield* pack(source, staging)
        expect(first.name.startsWith(tarballPrefix("@upstream-fixture/library"))).toBe(true)
        const firstName = packedTarballName(first)
        yield* fileSystem.copyFile(first.file, path.join(artifacts, firstName))
        yield* install(consumer, `file:${tarballDirectory}/${firstName}`)
        expect(yield* installedMarker(consumer)).toContain("BEFORE_REBUILD")

        yield* sibling(source, "AFTER_REBUILD")
        const second = yield* pack(source, staging)
        const secondName = packedTarballName(second)
        expect(secondName).not.toBe(firstName)

        yield* fileSystem.copyFile(second.file, path.join(artifacts, firstName))
        yield* install(consumer, `file:${tarballDirectory}/${firstName}`)
        expect(yield* installedMarker(consumer)).toContain("BEFORE_REBUILD")

        yield* fileSystem.copyFile(second.file, path.join(artifacts, secondName))
        yield* install(consumer, `file:${tarballDirectory}/${secondName}`)
        expect(yield* installedMarker(consumer)).toContain("AFTER_REBUILD")

        const packedDigest = yield* extractedDigest(path.join(artifacts, secondName), staging)
        const installed = yield* directoryDigest(
          path.join(consumer, "node_modules", "@upstream-fixture", "library"),
        )
        expect(installed).toBe(packedDigest)
      }),
    ),
  ),
)

test("a content digest separates rebuilt bytes from an unchanged tree at identical file paths", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-upstream-digest-" })
        const tree = path.join(workspace, "tree")
        const library = path.join(tree, "dist", "library.js")
        yield* sibling(tree, "BEFORE_REBUILD")
        const before = yield* directoryDigest(tree)
        expect(yield* directoryDigest(tree)).toBe(before)

        yield* fileSystem.writeFileString(library, `export const marker = "AFTER_REBUILD"\n`)
        expect(yield* directoryDigest(tree)).not.toBe(before)

        yield* fileSystem.writeFileString(library, `export const marker = "BEFORE_REBUILD"\n`)
        expect(yield* directoryDigest(tree)).toBe(before)

        yield* fileSystem.writeFileString(path.join(tree, "dist", "extra.js"), "export const extra = 1\n")
        expect(yield* directoryDigest(tree)).not.toBe(before)
      }),
    ),
  ),
)

test("packing an unchanged sibling twice keeps the same name so re-linking is idempotent", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-upstream-pack-" })
        const source = path.join(workspace, "sibling")
        yield* sibling(source, "STABLE")
        const first = yield* pack(source, path.join(workspace, "first"))
        const second = yield* pack(source, path.join(workspace, "second"))
        expect(packedTarballName(second)).toBe(packedTarballName(first))

        yield* sibling(source, "CHANGED")
        const third = yield* pack(source, path.join(workspace, "third"))
        expect(packedTarballName(third)).not.toBe(packedTarballName(first))
      }),
    ),
  ),
)
