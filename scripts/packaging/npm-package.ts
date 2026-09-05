import { Data, Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  archiveName,
  archiveRoot,
  packageBinEntries,
  packageExecutables,
  targetNames,
  type PackageTarget,
} from "./package-contract"

class NpmPackageError extends Data.TaggedError("NpmPackageError")<{
  readonly step: string
  readonly message: string
}> {}

const npmPackageError = (step: string, message: string) => new NpmPackageError({ step, message })

const PackageManifestJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const scope = "@rikafx"

const launcherName = `${scope}/cli`

const platformPackageName = (target: PackageTarget): string => `${scope}/cli-${target}`

const platformConstraints = (target: PackageTarget) => {
  const [os, cpu] = target.split("-")
  return { os: os!, cpu: cpu! }
}

const sharedManifest = (version: string) => ({
  version,
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/In-Time-Tec/rika.git" },
  homepage: "https://github.com/In-Time-Tec/rika",
  engines: { node: ">=18" },
})

const launcherManifest = (version: string) => ({
  name: launcherName,
  description: "Rika — a local durable coding agent for your terminal",
  ...sharedManifest(version),
  bin: { rika: "bin/rika.js" },
  files: ["bin/rika.js", "README.md"],
  optionalDependencies: Object.fromEntries(
    targetNames.map((target) => [platformPackageName(target), version] as const),
  ),
})

const launcherShim = `#!/usr/bin/env node
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

const platformManifest = (target: PackageTarget, version: string) => ({
  name: platformPackageName(target),
  description: `Rika binaries for ${target}`,
  ...sharedManifest(version),
  ...platformConstraints(target),
  files: packageBinEntries.map((entry) => `bin/${entry}`),
  preferUnplugged: true,
})

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

  const readme = yield* fileSystem.readFileString(path.join(root, "README.md"))
  const license = yield* fileSystem.readFileString(path.join(root, "LICENSE"))

  const launcher = path.join(output, "cli")
  yield* fileSystem.makeDirectory(path.join(launcher, "bin"), { recursive: true })
  yield* writeJson(path.join(launcher, "package.json"), launcherManifest(version))
  yield* fileSystem.writeFileString(path.join(launcher, "bin", "rika.js"), launcherShim)
  yield* fileSystem.writeFileString(path.join(launcher, "README.md"), readme)
  yield* fileSystem.writeFileString(path.join(launcher, "LICENSE"), license)

  for (const target of targetNames) {
    const archive = path.join(artifacts, archiveName(version, target))
    const directory = path.join(output, `cli-${target}`)
    yield* fileSystem.makeDirectory(directory, { recursive: true })
    const staging = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-npm-" })
    const exitCode = yield* spawner.exitCode(ChildProcess.make("tar", ["-xzf", archive, "-C", staging]))
    if (Number(exitCode) !== 0)
      return yield* npmPackageError("extract", `extract ${target}: tar exited with code ${exitCode}`)
    yield* fileSystem.makeDirectory(path.join(directory, "bin"), { recursive: true })
    yield* Effect.forEach(
      packageBinEntries,
      (entry) =>
        fileSystem.copyFile(
          path.join(staging, archiveRoot(version, target), "bin", entry),
          path.join(directory, "bin", entry),
        ),
      { concurrency: "unbounded", discard: true },
    )
    yield* Effect.forEach(packageExecutables, (entry) => fileSystem.chmod(path.join(directory, "bin", entry), 0o755), {
      concurrency: "unbounded",
      discard: true,
    })
    yield* writeJson(path.join(directory, "package.json"), platformManifest(target, version))
    yield* fileSystem.writeFileString(path.join(directory, "LICENSE"), license)
  }

  yield* Effect.log(`Assembled npm packages for ${targetNames.join(", ")} at version ${version}`)
})
