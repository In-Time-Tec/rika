import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { dual } from "effect/Function"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { archiveName, archiveRoot, targetNames, type PackageTarget } from "./package-contract"

export class NpmPackageError extends Data.TaggedError("NpmPackageError")<{
  readonly step: string
  readonly message: string
}> {}

const npmPackageError = (step: string, message: string) => new NpmPackageError({ step, message })

const PackageManifestJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

export const scope = "@rikafx"

export const launcherName = `${scope}/cli`

export const platformPackageName = (target: PackageTarget): string => `${scope}/cli-${target}`

export const platformConstraints = (target: PackageTarget) => {
  const [os, cpu] = target.split("-")
  return { os: os!, cpu: cpu! }
}

export const packedName: {
  (version: string): (name: string) => string
  (name: string, version: string): string
} = dual(2, (name: string, version: string): string => `${name.replace("@", "").replace("/", "-")}-${version}.tgz`)

const sharedManifest = (version: string) => ({
  version,
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/In-Time-Tec/rika.git" },
  homepage: "https://github.com/In-Time-Tec/rika",
  engines: { node: ">=18" },
})

export const launcherManifest = (version: string) => ({
  name: launcherName,
  description: "Rika — a local durable coding agent for your terminal",
  ...sharedManifest(version),
  bin: { rika: "bin/rika.js" },
  files: ["bin/rika.js", "README.md"],
  optionalDependencies: Object.fromEntries(
    targetNames.map((target) => [platformPackageName(target), version] as const),
  ),
})

export const launcherShim = `#!/usr/bin/env node
"use strict"

const { spawnSync } = require("node:child_process")

const target = \`\${process.platform}-\${process.arch}\`
const packageName = "${scope}/cli-" + target

let binary
try {
  binary = require.resolve(packageName + "/bin/rika")
} catch {
  console.error(
    "rika: no binary for " +
      target + ".\\nSupported: ${targetNames.join(", ")}." +
      "\\nIf your platform is supported, reinstall without --no-optional or --ignore-optional.",
  )
  process.exit(1)
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" })
if (result.error !== undefined) {
  console.error("rika: failed to start " + binary + ": " + result.error.message)
  process.exit(1)
}
if (typeof result.signal === "string") process.kill(process.pid, result.signal)
process.exit(result.status === null ? 1 : result.status)
`

export const platformManifest: {
  (version: string): (target: PackageTarget) => Schema.JsonObject
  (target: PackageTarget, version: string): Schema.JsonObject
} = dual(2, (target: PackageTarget, version: string) => ({
  name: platformPackageName(target),
  description: `Rika binaries for ${target}`,
  ...sharedManifest(version),
  ...platformConstraints(target),
  files: ["bin/rika"],
  preferUnplugged: true,
}))

const writeJson = Effect.fn("NpmPackage.writeJson")(function* (file: string, value: Schema.Json) {
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
    yield* fileSystem.makeDirectory(path.join(directory, "bin"), { recursive: true })
    yield* fileSystem.copyFile(
      path.join(staging, archiveRoot(version, target), "bin", "rika"),
      path.join(directory, "bin", "rika"),
    )
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
