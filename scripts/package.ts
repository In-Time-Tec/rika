import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export const targets = {
  "darwin-arm64": {
    bun: "bun-darwin-arm64",
    opentui: "@opentui/core-darwin-arm64",
    fff: "@ff-labs/fff-bin-darwin-arm64",
  },
  "darwin-x64": { bun: "bun-darwin-x64", opentui: "@opentui/core-darwin-x64", fff: "@ff-labs/fff-bin-darwin-x64" },
  "linux-arm64": {
    bun: "bun-linux-arm64",
    opentui: "@opentui/core-linux-arm64",
    fff: "@ff-labs/fff-bin-linux-arm64-gnu",
  },
  "linux-x64": {
    bun: "bun-linux-x64",
    opentui: "@opentui/core-linux-x64",
    fff: "@ff-labs/fff-bin-linux-x64-gnu",
  },
}

const platformPackageVersion = "0.4.2"
const platformPackages = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
]

const PackageManifest = Schema.Struct({ name: Schema.String, version: Schema.String })
const Sha256Output = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)))
const JsonString = Schema.fromJsonString(Schema.String)

const targetByName = (name: string) => {
  switch (name) {
    case "darwin-arm64":
      return targets["darwin-arm64"]
    case "darwin-x64":
      return targets["darwin-x64"]
    case "linux-arm64":
      return targets["linux-arm64"]
    case "linux-x64":
      return targets["linux-x64"]
    default:
      return undefined
  }
}

export const isManagedPackagingEntry = (name: string) =>
  name === "SHA256SUMS" ||
  name === "release-evidence.json" ||
  name.startsWith(".platform-packages-") ||
  Object.keys(targets).some((target) => name === `rika-${target}` || name === `rika-${target}.tar.gz`)

class PackagingError extends Data.TaggedError("PackagingError")<{
  readonly operation: string
  readonly message: string
}> {}

const failure = (operation: string, message: string) => new PackagingError({ operation, message })
const mapFailure = (operation: string) =>
  Effect.mapError((error: { readonly message: string }) => failure(operation, error.message))

const run = Effect.fn("Package.run")((command: string, args: ReadonlyArray<string>, operation: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const exitCode = yield* spawner
      .exitCode(ChildProcess.make(command, args, { stdout: "inherit", stderr: "inherit" }))
      .pipe(mapFailure(operation))
    if (Number(exitCode) !== 0) return yield* failure(operation, `${command} exited with code ${exitCode}`)
  }),
)

const sha256 = Effect.fn("Package.sha256")((file: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const output = yield* spawner.string(ChildProcess.make("sha256sum", [file])).pipe(mapFailure("hash archive"))
    const digest = output.trim().split(/\s+/, 1)[0]
    if (digest === undefined) return yield* failure("hash archive", `sha256sum returned no digest for ${file}`)
    return yield* Schema.decodeUnknownEffect(Sha256Output)(digest).pipe(
      Effect.mapError((error) => failure("hash archive", error.message)),
    )
  }),
)

const locatePackage = Effect.fn("Package.locatePackage")((root: string, name: string, version: string, cache: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const exact = path.join(root, "node_modules", ...name.split("/"))
    if (yield* fileSystem.exists(exact).pipe(mapFailure("locate installed package"))) return exact
    const bunModules = path.join(root, "node_modules", ".bun")
    const prefix = name.replace("/", "+") + "@"
    const entries = yield* fileSystem.readDirectory(bunModules).pipe(mapFailure("scan Bun package store"))
    const found = entries.toSorted().find((entry) => entry.startsWith(prefix))
    if (found !== undefined) return path.join(bunModules, found, "node_modules", ...name.split("/"))
    const destination = path.join(cache, name.replace("/", "+"))
    yield* fileSystem.makeDirectory(destination, { recursive: true }).pipe(mapFailure("create package cache"))
    yield* run(
      "npm",
      ["pack", `${name}@${version}`, "--ignore-scripts", "--pack-destination", destination],
      `fetch pinned optional package ${name}@${version}`,
    )
    const archives = yield* fileSystem.readDirectory(destination).pipe(mapFailure("find downloaded package"))
    const archive = archives.find((entry) => entry.endsWith(".tgz"))
    if (archive === undefined)
      return yield* failure("find downloaded package", `npm did not produce an archive for ${name}@${version}`)
    yield* run("tar", ["-xzf", path.join(destination, archive), "-C", destination], "extract downloaded package")
    const source = yield* fileSystem
      .readFileString(path.join(destination, "package", "package.json"))
      .pipe(mapFailure("read downloaded package manifest"))
    const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(source).pipe(
      Effect.mapError((error) => failure("validate downloaded package manifest", error.message)),
    )
    if (manifest.name !== name || manifest.version !== version) {
      return yield* failure(
        "validate downloaded package manifest",
        `Fetched optional package did not match ${name}@${version}`,
      )
    }
    return path.join(destination, "package")
  }),
)

const pythonArchive = `
import gzip, os, tarfile, sys
root, name, output = sys.argv[1:]
with open(output, "wb") as raw:
  with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
    with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as archive:
      for base, dirs, files in os.walk(os.path.join(root, name)):
        dirs.sort(); files.sort()
        for entry in dirs + files:
          path = os.path.join(base, entry); info = archive.gettarinfo(path, os.path.relpath(path, root))
          info.uid = info.gid = 0; info.uname = info.gname = ""; info.mtime = 0
          if info.isfile():
            with open(path, "rb") as source: archive.addfile(info, source)
          else: archive.addfile(info)
`

const program = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* path.fromFileUrl(new URL("..", import.meta.url)).pipe(mapFailure("resolve project root"))
    const output = path.join(root, "artifacts")
    const targetIndex = Bun.argv.indexOf("--target")
    const selected = targetIndex < 0 ? Object.keys(targets) : [Bun.argv[targetIndex + 1] ?? ""]
    yield* Effect.forEach(
      selected,
      (name) =>
        targetByName(name) === undefined ? failure("validate target", `Unsupported target: ${name}`) : Effect.void,
      { discard: true },
    )
    yield* fileSystem.makeDirectory(output, { recursive: true }).pipe(mapFailure("create artifact directory"))
    const outputEntries = yield* fileSystem.readDirectory(output).pipe(mapFailure("scan artifact directory"))
    yield* Effect.forEach(
      outputEntries.filter(isManagedPackagingEntry),
      (entry) =>
        fileSystem
          .remove(path.join(output, entry), { recursive: true, force: true })
          .pipe(mapFailure("clear managed package output")),
      { concurrency: 4, discard: true },
    )
    const packageCache = yield* fileSystem
      .makeTempDirectoryScoped({ directory: output, prefix: ".platform-packages-" })
      .pipe(mapFailure("create package cache"))
    const buildTarget = Effect.fn("Package.buildTarget")((name: string) =>
      Effect.gen(function* () {
        const target = targetByName(name)
        if (target === undefined) return yield* failure("validate target", `Unsupported target: ${name}`)
        const stageName = `rika-${name}`
        const stage = path.join(output, stageName)
        yield* Effect.acquireRelease(
          fileSystem
            .makeDirectory(path.join(stage, "bin"), { recursive: true })
            .pipe(mapFailure("create staging directory")),
          () => fileSystem.remove(stage, { recursive: true, force: true }).pipe(Effect.ignore),
        )
        const packageSource = yield* locatePackage(root, target.opentui, platformPackageVersion, packageCache)
        const fffSource = yield* locatePackage(root, target.fff, "0.9.6", packageCache)
        const fffNodeSource = yield* locatePackage(root, "@ff-labs/fff-node", "0.9.6", packageCache)
        const ffiSource = yield* locatePackage(root, "ffi-rs", "1.3.2", packageCache)
        const resolutionPackage = path.join(root, "node_modules", ...target.opentui.split("/"))
        const resolutionExists = yield* fileSystem
          .exists(resolutionPackage)
          .pipe(mapFailure("check resolution package"))
        if (!resolutionExists) {
          yield* Effect.acquireRelease(
            Effect.gen(function* () {
              yield* fileSystem
                .makeDirectory(resolutionPackage, { recursive: true })
                .pipe(mapFailure("create resolution package"))
              yield* fileSystem.copy(packageSource, resolutionPackage).pipe(mapFailure("copy resolution package"))
            }),
            () => fileSystem.remove(resolutionPackage, { recursive: true, force: true }).pipe(Effect.ignore),
          )
        }
        yield* run(
          "bun",
          [
            "build",
            "--compile",
            `--target=${target.bun}`,
            ...platformPackages
              .filter((packageName) => packageName !== target.opentui)
              .flatMap((packageName) => ["--external", packageName]),
            "--outfile",
            path.join(stage, "bin", "rika"),
            path.join(root, "apps/rika/src/main.ts"),
          ],
          `build ${name}`,
        )
        yield* fileSystem.chmod(path.join(stage, "bin", "rika"), 0o755).pipe(mapFailure("make binary executable"))
        const packages = [
          { name: target.opentui, source: packageSource },
          { name: target.fff, source: fffSource },
          { name: "@ff-labs/fff-node", source: fffNodeSource },
          { name: "ffi-rs", source: ffiSource },
        ]
        yield* Effect.forEach(
          packages,
          (packageToCopy) => {
            const destination = path.join(stage, "bin", "node_modules", ...packageToCopy.name.split("/"))
            return fileSystem
              .makeDirectory(destination, { recursive: true })
              .pipe(
                Effect.andThen(fileSystem.copy(packageToCopy.source, destination)),
                mapFailure(`copy ${packageToCopy.name}`),
              )
          },
          { concurrency: 4, discard: true },
        )
        yield* fileSystem
          .writeFileString(
            path.join(stage, "INSTALL"),
            "Install bin/rika on PATH. Keep node_modules adjacent to bin.\n",
          )
          .pipe(mapFailure("write install instructions"))
        const archive = path.join(output, `${stageName}.tar.gz`)
        yield* run("python3", ["-c", pythonArchive, output, stageName, archive], `archive ${name}`)
        return {
          target: name,
          archive: path.basename(archive),
          sha256: yield* sha256(archive),
          opentui: target.opentui,
        }
      }),
    )
    const evidence = yield* Effect.forEach(selected, buildTarget, { concurrency: 1 })
    const bunVersion = yield* Schema.encodeEffect(JsonString)(Bun.version).pipe(
      Effect.mapError((error) => failure("encode release evidence", error.message)),
    )
    const artifactJson = yield* Effect.forEach(evidence, (item) =>
      Effect.gen(function* () {
        const target = yield* Schema.encodeEffect(JsonString)(item.target)
        const archive = yield* Schema.encodeEffect(JsonString)(item.archive)
        const sha = yield* Schema.encodeEffect(JsonString)(item.sha256)
        const opentui = yield* Schema.encodeEffect(JsonString)(item.opentui)
        return `    {\n      "target": ${target},\n      "archive": ${archive},\n      "sha256": ${sha},\n      "opentui": ${opentui}\n    }`
      }).pipe(Effect.mapError((error) => failure("encode release evidence", error.message))),
    )
    yield* fileSystem
      .writeFileString(
        path.join(output, "release-evidence.json"),
        `{\n  "schemaVersion": 1,\n  "bun": ${bunVersion},\n  "artifacts": [\n${artifactJson.join(",\n")}\n  ]\n}\n`,
      )
      .pipe(mapFailure("write release evidence"))
    yield* fileSystem
      .writeFileString(
        path.join(output, "SHA256SUMS"),
        evidence.map((item) => `${item.sha256}  ${item.archive}`).join("\n") + "\n",
      )
      .pipe(mapFailure("write checksums"))
  }),
)

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
  )
}
