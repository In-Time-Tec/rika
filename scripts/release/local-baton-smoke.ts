import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Function, Layer, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Command, Flag } from "effect/unstable/cli"
import { isPackageTarget } from "../packaging/package-target-contract"

export const batonPackages = ["core", "mcp", "providers", "runtime", "skills", "test"] as const

type BatonPackage = (typeof batonPackages)[number]

type RootManifest = {
  readonly overrides?: Readonly<Record<string, string>>
  readonly workspaces: {
    readonly catalog: Readonly<Record<string, string>>
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

type BatonReleaseEvidence = {
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

const UnknownJson = Schema.UnknownFromJsonString
const encodeManifest = (manifest: RootManifest): string => Schema.encodeSync(UnknownJson)(manifest)

const batonTarballNameImpl = (packageName: BatonPackage, version: string): string =>
  `batonfx-${packageName}-${version}.tgz`

export const batonTarballName: {
  (arg0: BatonPackage, arg1: string): string
  (arg1: string): (arg0: BatonPackage) => string
} = Function.dual(2, batonTarballNameImpl)

export const catalogBatonVersion = (catalog: Readonly<Record<string, string>>): string => {
  const versions = new Set(batonPackages.map((packageName) => catalog[`@batonfx/${packageName}`]))
  if (versions.size !== 1 || versions.has(undefined))
    throw new Error("Rika must pin every Baton package to one exact version")
  const version = [...versions][0]!
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Rika Baton catalog version is not exact semver: ${version}`)
  return version
}

const manifestWithLocalBatonTarballsImpl = (
  manifest: RootManifest,
  releaseDirectory: string,
  version: string,
): RootManifest => {
  const tarballs = Object.fromEntries(
    batonPackages.map((packageName) => [
      `@batonfx/${packageName}`,
      `file:${releaseDirectory}/${batonTarballName(packageName, version)}`,
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
const sha512 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha512").update(bytes).digest("base64")

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
      const sourceLock = yield* fileSystem.readFileString(path.join(root, "bun.lock"))
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
      if (evidence.schemaVersion !== 1 || evidence.packages.length !== 11)
        return yield* failure("validate Baton evidence", "Expected schema version 1 and exactly eleven Baton packages")
      const checksums = new Map(
        (yield* fileSystem.readFileString(checksumPath))
          .trim()
          .split("\n")
          .map((line) => {
            const match = /^([a-f0-9]{64})  ([^/]+)$/.exec(line)
            if (match === null) throw new Error(`Invalid checksum line: ${line}`)
            return [match[2]!, match[1]!] as const
          }),
      )
      if (checksums.size !== 12) return yield* failure("validate Baton checksums", "Expected twelve checksum entries")
      for (const [filename, digest] of checksums) {
        const bytes = yield* fileSystem.readFile(path.join(releaseDirectory, filename))
        if (sha256(bytes) !== digest)
          return yield* failure("validate Baton checksums", `Digest mismatch for ${filename}`)
      }

      const packedManifests = new Map<string, string>()
      for (const packageName of batonPackages) {
        const name = `@batonfx/${packageName}`
        const filename = batonTarballName(packageName, version)
        const item = evidence.packages.find((candidate) => candidate.name === name)
        if (
          item === undefined ||
          item.version !== version ||
          item.filename !== filename ||
          checksums.get(filename) !== item.sha256
        )
          return yield* failure("validate Baton evidence", `${name} does not match ${filename} at ${version}`)
        const tarball = path.join(releaseDirectory, filename)
        const tarballBytes = yield* fileSystem.readFile(tarball)
        const integrity = `sha512-${sha512(tarballBytes)}`
        if (!sourceLock.includes(`"${name}@${version}"`) || !sourceLock.includes(integrity))
          return yield* failure("validate Rika lock", `${name}@${version} is not locked to the local tarball integrity`)
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
        packedManifests.set(name, manifestText.trim())
      }

      const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-local-baton-smoke-" })
      const temporaryRealPath = yield* fileSystem.realPath(temporary)
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
      if (localLock.includes("npmjs.org/@batonfx"))
        return yield* failure("verify isolated install", "Local consumer resolved a Baton package from npm")
      for (const packageName of batonPackages) {
        const name = `@batonfx/${packageName}`
        const filename = batonTarballName(packageName, version)
        if (!localLock.includes(filename))
          return yield* failure("verify isolated install", `Local lock does not name ${filename}`)
        const installedDirectory = path.join(temporary, "node_modules", "@batonfx", packageName)
        const installedRealPath = yield* fileSystem.realPath(installedDirectory)
        if (!installedRealPath.startsWith(`${temporaryRealPath}${path.sep}`))
          return yield* failure(
            "verify isolated install",
            `${name} escaped the isolated consumer: ${installedRealPath}`,
          )
        const installedManifest = (yield* fileSystem.readFileString(
          path.join(installedDirectory, "package.json"),
        )).trim()
        if (installedManifest !== packedManifests.get(name))
          return yield* failure("verify isolated install", `${name} is not the exact manifest from ${filename}`)
        yield* Effect.log(`Verified ${name}@${version} from ${filename} at ${installedRealPath}`)
      }

      for (const consumer of ["packages/baton-execution", "packages/extensions"])
        yield* run("bun", ["run", "typecheck"], path.join(temporary, consumer), environment)
      yield* run("bun", ["run", "package", "--", "--target", target], temporary, environment)
      yield* run("bun", ["run", "release-smoke", "--", "--target", target], temporary, environment)
      yield* Effect.log(`Local Baton tarball release smoke passed for Rika ${target} with Baton ${version}`)
    }),
  )

const command = Command.make(
  "release-local",
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
