import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { archiveName, archiveRoot } from "./release-archive"
import { launcherManifest, launcherShim } from "./npm-launcher"
import { platformManifest } from "./npm-platform-package"
import { targetNames } from "./package-target-contract"

export class NpmPackageError extends Data.TaggedError("NpmPackageError")<{
  readonly step: string
  readonly message: string
}> {}

const npmPackageError = (step: string, message: string) => new NpmPackageError({ step, message })

const PackageManifestJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const writeJson = Effect.fn("NpmPackage.writeJson")(function* (file: string, value: unknown) {
  const fileSystem = yield* FileSystem.FileSystem
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value)
  yield* fileSystem.writeFileString(file, `${encoded}\n`)
})

export const buildNpmPackages = Effect.fn("NpmPackage.build")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = path.resolve(import.meta.dir, "../..")
  const artifacts = path.join(root, "artifacts")
  const output = path.join(artifacts, "npm")
  const manifest = yield* fileSystem
    .readFileString(path.join(root, "apps/rika/package.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageManifestJson)))
  const version = manifest.version

  yield* fileSystem.remove(output, { recursive: true, force: true })
  yield* fileSystem.makeDirectory(output, { recursive: true })

  const readme = yield* fileSystem
    .readFileString(path.join(root, "README.md"))
    .pipe(Effect.orElseSucceed(() => "# Rika\n"))
  const license = yield* fileSystem.readFileString(path.join(root, "LICENSE"))

  const launcher = path.join(output, "cli")
  yield* fileSystem.makeDirectory(path.join(launcher, "bin"), { recursive: true })
  yield* writeJson(path.join(launcher, "package.json"), launcherManifest(version))
  yield* fileSystem.writeFileString(path.join(launcher, "bin", "rika.js"), launcherShim)
  yield* fileSystem.writeFileString(path.join(launcher, "README.md"), readme)
  yield* fileSystem.writeFileString(path.join(launcher, "LICENSE"), license)

  const built: Array<string> = []
  for (const target of targetNames) {
    const archive = path.join(artifacts, archiveName(version, target))
    if (!(yield* fileSystem.exists(archive))) continue
    const directory = path.join(output, `cli-${target}`)
    yield* fileSystem.makeDirectory(directory, { recursive: true })
    const staging = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-npm-" })
    const exitCode = yield* spawner.exitCode(ChildProcess.make("tar", ["-xzf", archive, "-C", staging]))
    if (Number(exitCode) !== 0)
      return yield* npmPackageError("extract", `extract ${target}: tar exited with code ${exitCode}`)
    yield* fileSystem.copy(path.join(staging, archiveRoot(version, target), "bin"), path.join(directory, "bin"))
    yield* writeJson(path.join(directory, "package.json"), platformManifest(target, version))
    yield* fileSystem.writeFileString(path.join(directory, "LICENSE"), license)
    built.push(target)
  }

  if (built.length === 0)
    return yield* npmPackageError("collect", `no release archives found in ${artifacts}; run \`bun run package\` first`)

  yield* Effect.log(`Built npm packages for ${built.join(", ")} at version ${version}`)
  return { version, targets: built, output }
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(buildNpmPackages(), context)),
    ),
  )
