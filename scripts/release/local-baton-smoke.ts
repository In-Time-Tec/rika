import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Function, Layer, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Command, Flag } from "effect/unstable/cli"
import { archiveName } from "../packaging/release-archive"
import { isPackageTarget, type PackageTarget } from "../packaging/package-target-contract"
import {
  tenetkitPackages,
  verifyInstalledBatonPackages,
  type PackedBatonPackage,
} from "./local-baton-package-verification"
import { directoryDigest } from "../upstream/upstream-content-digest"

export const tenetkitReleasePackages = ["tenetkit", "@tenetkit/pg", "@tenetkit/mysql"] as const

type TenetkitReleasePackage = (typeof tenetkitReleasePackages)[number]

type RootManifest = {
  readonly overrides?: Readonly<Record<string, string>>
  readonly workspaces: {
    readonly catalog: Readonly<Record<string, string>>
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

export type BatonReleaseEvidence = {
  readonly schemaVersion: number
  readonly packages: ReadonlyArray<{
    readonly name: string
    readonly version: string
    readonly filename: string
    readonly sha256: string
  }>
}

class LocalBatonSmokeError extends Data.TaggedError("LocalBatonSmokeError")<{
  readonly step: string
  readonly message: string
}> {}

const failure = (step: string, message: string) => new LocalBatonSmokeError({ step, message })

const UnknownJson = Schema.fromJsonString(Schema.Unknown)
const encodeManifest = (manifest: RootManifest): string => Schema.encodeSync(UnknownJson)(manifest)

const tenetkitTarballNameImpl = (packageName: string, version: string): string =>
  `${packageName.replace("@tenetkit/", "tenetkit-")}-${version}.tgz`

export const tenetkitTarballName: {
  (arg0: string, arg1: string): string
  (arg1: string): (arg0: string) => string
} = Function.dual(2, tenetkitTarballNameImpl)

const tenetkitReleaseTarballName = (packageName: TenetkitReleasePackage, version: string): string =>
  tenetkitTarballNameImpl(packageName, version)

const batonReleaseInventoryErrorImpl = (
  evidence: BatonReleaseEvidence,
  version: string,
  checksumNames: ReadonlyArray<string>,
): string | undefined => {
  if (evidence.schemaVersion !== 1)
    return `Expected Baton evidence schema version 1; received ${evidence.schemaVersion}`
  const expectedPackages = tenetkitReleasePackages
    .map((packageName) => ({
      name: packageName,
      version,
      filename: tenetkitReleaseTarballName(packageName, version),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name))
  const actualPackages = evidence.packages
    .map(({ name, version: packageVersion, filename }) => ({ name, version: packageVersion, filename }))
    .toSorted((left, right) => left.name.localeCompare(right.name))
  if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages))
    return "Baton evidence does not contain the exact current public package release train"

  const expectedChecksums = [...expectedPackages.map(({ filename }) => filename), "release-evidence.json"].toSorted()
  if (JSON.stringify(checksumNames.toSorted()) !== JSON.stringify(expectedChecksums))
    return "Baton checksums do not contain exactly every package tarball and release-evidence.json"
  return undefined
}

export const batonReleaseInventoryError: {
  (arg0: BatonReleaseEvidence, arg1: string, arg2: ReadonlyArray<string>): string | undefined
  (arg1: string, arg2: ReadonlyArray<string>): (arg0: BatonReleaseEvidence) => string | undefined
} = Function.dual(3, batonReleaseInventoryErrorImpl)

export const catalogBatonVersion = (catalog: Readonly<Record<string, string>>): string => {
  const versions = new Set(tenetkitPackages.map((packageName) => catalog[packageName]))
  if (versions.size !== 1 || versions.has(undefined))
    throw new Error("Rika must pin every TenetKit package to one exact version")
  const version = [...versions][0]!
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Rika TenetKit catalog version is not exact semver: ${version}`)
  return version
}

const manifestWithLocalBatonTarballsImpl = (
  manifest: RootManifest,
  releaseDirectory: string,
  version: string,
): RootManifest => {
  const tarballs = Object.fromEntries(
    tenetkitPackages.map((packageName) => [
      packageName,
      `file:${releaseDirectory}/${tenetkitTarballName(packageName, version)}`,
    ]),
  )
  return {
    ...manifest,
    overrides: { ...manifest.overrides, ...tarballs },
    workspaces: {
      ...manifest.workspaces,
      catalog: { ...manifest.workspaces.catalog, ...tarballs },
    },
  }
}

export const manifestWithLocalBatonTarballs: {
  (arg0: RootManifest, arg1: string, arg2: string): RootManifest
  (arg1: string, arg2: string): (arg0: RootManifest) => RootManifest
} = Function.dual(3, manifestWithLocalBatonTarballsImpl)

const run = Effect.fn("LocalBatonSmoke.run")(function* (
  command: string,
  arguments_: ReadonlyArray<string>,
  cwd: string,
  environment?: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  yield* Effect.log(`Running ${command} ${arguments_.join(" ")}`)
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, arguments_, {
      cwd,
      ...(environment === undefined ? {} : { env: environment, extendEnv: true }),
    }),
  )
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: 3 },
  )
  if (Number(exitCode) !== 0)
    return yield* failure(
      `${command} ${arguments_.join(" ")}`,
      `exit ${exitCode}\n${stderr.slice(0, 20_000)}\n${stdout.slice(0, 20_000)}`,
    )
  return stdout
})

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

export const provisionProvenHostArchive = Effect.fn("LocalBatonSmoke.provisionProvenHostArchive")(function* (input: {
  readonly sourceRoot: string
  readonly isolatedRoot: string
  readonly version: string
  readonly target: PackageTarget
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const filename = archiveName(input.version, input.target)
  const provenArchive = yield* fileSystem.readFile(path.join(input.isolatedRoot, "artifacts", filename))
  const sourceArtifacts = path.join(input.sourceRoot, "artifacts")
  const destination = path.join(sourceArtifacts, filename)
  yield* fileSystem.makeDirectory(sourceArtifacts, { recursive: true })
  yield* fileSystem.writeFile(destination, provenArchive)
  const provisionedArchive = yield* fileSystem.readFile(destination)
  if (sha256(provisionedArchive) !== sha256(provenArchive))
    return yield* failure("provision proven host archive", `Digest does not match the proven archive: ${filename}`)
  return destination
})

const program = (options: { readonly batonRelease: string; readonly target?: string | undefined }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = path.resolve(import.meta.dir, "../..")
      const releaseDirectory = path.resolve(options.batonRelease)
      const hostTarget = `${process.platform === "darwin" ? "darwin" : process.platform}-${
        process.arch === "x64" ? "x64" : "arm64"
      }`
      const target = options.target ?? hostTarget
      if (!isPackageTarget(target)) return yield* failure("select target", `Unsupported target: ${target}`)
      if (target !== hostTarget)
        return yield* failure(
          "select target",
          `Release smoke must execute the host target ${hostTarget}; received ${target}`,
        )

      const sourceManifestText = yield* fileSystem.readFileString(path.join(root, "package.json"))
      const sourceManifest = (yield* Schema.decodeUnknownEffect(UnknownJson)(sourceManifestText)) as RootManifest
      const version = yield* Effect.try({
        try: () => catalogBatonVersion(sourceManifest.workspaces.catalog),
        catch: (cause) => failure("read Baton version", String(cause)),
      })
      const evidencePath = path.join(releaseDirectory, "release-evidence.json")
      const checksumPath = path.join(releaseDirectory, "SHA256SUMS")
      const evidence = (yield* Schema.decodeUnknownEffect(UnknownJson)(
        yield* fileSystem.readFileString(evidencePath),
      )) as BatonReleaseEvidence
      const checksumEntries = (yield* fileSystem.readFileString(checksumPath))
        .trim()
        .split("\n")
        .map((line) => {
          const match = /^([a-f0-9]{64})  ([^/]+)$/.exec(line)
          if (match === null) throw new Error(`Invalid checksum line: ${line}`)
          return [match[2]!, match[1]!] as const
        })
      const inventoryError = batonReleaseInventoryError(
        evidence,
        version,
        checksumEntries.map(([filename]) => filename),
      )
      if (inventoryError !== undefined) return yield* failure("validate Baton release inventory", inventoryError)
      const checksums = new Map(checksumEntries)
      for (const [filename, digest] of checksums) {
        const bytes = yield* fileSystem.readFile(path.join(releaseDirectory, filename))
        if (sha256(bytes) !== digest)
          return yield* failure("validate Baton checksums", `Digest mismatch for ${filename}`)
      }
      for (const item of evidence.packages) {
        if (checksums.get(item.filename) !== item.sha256)
          return yield* failure(
            "validate Baton evidence",
            `Evidence digest does not match SHA256SUMS for ${item.filename}`,
          )
      }

      const packedPackages = new Map<string, PackedBatonPackage>()
      const packedPackageRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-local-baton-packages-" })
      for (const name of tenetkitPackages) {
        const filename = tenetkitTarballName(name, version)
        const item = evidence.packages.find((candidate) => candidate.name === name)
        if (
          item === undefined ||
          item.version !== version ||
          item.filename !== filename ||
          checksums.get(filename) !== item.sha256
        )
          return yield* failure("validate Baton evidence", `${name} does not match ${filename} at ${version}`)
        const tarball = path.join(releaseDirectory, filename)
        const manifestText = yield* run("tar", ["-xOzf", tarball, "package/package.json"], root)
        const manifest = (yield* Schema.decodeUnknownEffect(UnknownJson)(manifestText)) as {
          readonly name?: string
          readonly version?: string
        }
        if (manifest.name !== name || manifest.version !== version)
          return yield* failure(
            "validate Baton tarball",
            `${filename} has identity ${manifest.name}@${manifest.version}`,
          )
        const extractedRoot = path.join(packedPackageRoot, packageName)
        yield* fileSystem.makeDirectory(extractedRoot, { recursive: true })
        yield* run("tar", ["-xzf", tarball, "-C", extractedRoot], root)
        packedPackages.set(name, {
          manifest: manifestText.trim(),
          directoryDigest: yield* directoryDigest(path.join(extractedRoot, "package")),
        })
      }

      const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-local-baton-smoke-" })
      const files = (yield* run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root))
        .split("\0")
        .filter((file) => file.length > 0)
      for (const file of files) {
        const source = path.join(root, file)
        if (!(yield* fileSystem.exists(source))) continue
        const info = yield* fileSystem.stat(source)
        if (info.type !== "File") continue
        const destination = path.join(temporary, file)
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true })
        yield* fileSystem.copyFile(source, destination)
        yield* fileSystem.chmod(destination, info.mode)
      }

      const localManifest = manifestWithLocalBatonTarballs(sourceManifest, releaseDirectory, version)
      yield* fileSystem.writeFileString(path.join(temporary, "package.json"), `${encodeManifest(localManifest)}\n`)
      yield* fileSystem.remove(path.join(temporary, "bun.lock"), { force: true })

      const [revision, objectDirectory] = yield* Effect.all(
        [
          run("git", ["rev-parse", "HEAD"], root),
          run("git", ["rev-parse", "--path-format=absolute", "--git-path", "objects"], root),
        ],
        { concurrency: 2 },
      )
      yield* run("git", ["init", "--quiet"], temporary)
      yield* fileSystem.writeFileString(path.join(temporary, ".git", "HEAD"), `${revision.trim()}\n`)
      const environment = {
        BUN_INSTALL_CACHE_DIR: path.join(temporary, ".bun-install-cache"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory.trim(),
        NODE_OPTIONS: "",
        NODE_PATH: "",
      }
      yield* run("git", ["read-tree", "HEAD"], temporary, environment)
      yield* run("bun", ["install", "--linker=isolated"], temporary, environment)

      const localLock = yield* fileSystem.readFileString(path.join(temporary, "bun.lock"))
      if (localLock.includes("npmjs.org/tenetkit"))
        return yield* failure("verify isolated install", "Local consumer resolved a TenetKit package from npm")
      for (const packageName of tenetkitPackages) {
        const filename = tenetkitTarballName(packageName, version)
        if (!localLock.includes(filename))
          return yield* failure("verify isolated install", `Local lock does not name ${filename}`)
      }
      const installedPackages = yield* verifyInstalledBatonPackages({
        isolatedRoot: temporary,
        version,
        packedPackages,
      })
      for (const installed of installedPackages) {
        const filename = tenetkitTarballName(installed.name, version)
        yield* Effect.log(`Verified ${installed.name}@${version} from ${filename} at ${installed.directory}`)
      }

      for (const consumer of ["packages/baton-execution", "packages/extensions"])
        yield* run("bun", ["run", "typecheck"], path.join(temporary, consumer), environment)
      yield* run("bun", ["run", "package", "--", "--target", target], temporary, environment)
      yield* run("bun", ["run", "release-smoke", "--", "--target", target], temporary, environment)
      const rikaManifest = (yield* Schema.decodeUnknownEffect(UnknownJson)(
        yield* fileSystem.readFileString(path.join(temporary, "apps", "rika", "package.json")),
      )) as { readonly version: string }
      const provisionedArchive = yield* provisionProvenHostArchive({
        sourceRoot: root,
        isolatedRoot: temporary,
        version: rikaManifest.version,
        target,
      })
      yield* Effect.log(`Provisioned proven host archive at ${provisionedArchive}`)
      yield* Effect.log(`Local Baton tarball release smoke passed for Rika ${target} with Baton ${version}`)
    }),
  )

const command = Command.make(
  "local-baton-smoke",
  {
    batonRelease: Flag.directory("baton-release", { mustExist: true }),
    target: Flag.string("target").pipe(Flag.optional),
  },
  ({ batonRelease, target }) => program({ batonRelease, target: Option.getOrUndefined(target) }),
)

const main = Command.run(command, { version: "0.0.0" })

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
  )
