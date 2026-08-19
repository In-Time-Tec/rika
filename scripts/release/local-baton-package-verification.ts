import { Data, Effect, FileSystem, Path, Schema } from "effect"
import { directoryDigest } from "../upstream/upstream-content-digest"

/**
 * TenetKit ships one package with subpath exports, so the list holds whole package names rather
 * than the scope-relative suffixes the thirteen `@batonfx/*` packages needed.
 */
export const tenetkitPackages = ["tenetkit"] as const

class LocalBatonSmokeError extends Data.TaggedError("LocalBatonSmokeError")<{
  readonly step: string
  readonly message: string
}> {}

const failure = (step: string, message: string) => new LocalBatonSmokeError({ step, message })
const UnknownJson = Schema.UnknownFromJsonString

export type PackedBatonPackage = {
  readonly manifest: string
  readonly directoryDigest: string
}

export type InstalledBatonPackage = {
  readonly name: string
  readonly directory: string
}

export const verifyInstalledBatonPackages = Effect.fn("LocalBatonSmoke.verifyInstalledBatonPackages")(
  function* (input: {
    readonly isolatedRoot: string
    readonly version: string
    readonly packedPackages: ReadonlyMap<string, PackedBatonPackage>
  }) {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const isolatedRealPath = yield* fileSystem.realPath(input.isolatedRoot)
    const nodeModules = path.join(input.isolatedRoot, "node_modules")
    const store = path.join(nodeModules, ".bun")
    const storeEntries = (yield* fileSystem.exists(store))
      ? yield* fileSystem.readDirectory(store, { recursive: true })
      : []
    const installed: Array<InstalledBatonPackage> = []

    for (const name of tenetkitPackages) {
      const rootDirectory = path.join(nodeModules, ...name.split("/"))
      const manifestSuffix = `node_modules/${name}/package.json`
      const candidates = (yield* fileSystem.exists(rootDirectory))
        ? [rootDirectory]
        : storeEntries
            .filter((entry) => entry.replaceAll("\\", "/").endsWith(manifestSuffix))
            .map((entry) => path.dirname(path.join(store, entry)))
      const expected = input.packedPackages.get(name)
      if (expected === undefined)
        return yield* failure("verify isolated install", `Missing packed package evidence for ${name}`)
      const matchingDirectories = new Set<string>()
      for (const candidate of candidates) {
        const installedRealPath = yield* fileSystem.realPath(candidate)
        if (!installedRealPath.startsWith(`${isolatedRealPath}${path.sep}`))
          return yield* failure(
            "verify isolated install",
            `${name} escaped the isolated consumer: ${installedRealPath}`,
          )
        const installedManifest = yield* fileSystem.readFileString(path.join(candidate, "package.json"))
        const manifest = (yield* Schema.decodeUnknownEffect(UnknownJson)(installedManifest)) as {
          readonly name?: string
          readonly version?: string
        }
        if (
          manifest.name === name &&
          manifest.version === input.version &&
          installedManifest.trim() === expected.manifest &&
          (yield* directoryDigest(candidate)) === expected.directoryDigest
        )
          matchingDirectories.add(installedRealPath)
      }
      if (matchingDirectories.size !== 1)
        return yield* failure(
          "verify isolated install",
          `Expected exactly one installed ${name}@${input.version} matching the packed package; found ${matchingDirectories.size}`,
        )
      installed.push({ name, directory: [...matchingDirectories][0]! })
    }

    return installed
  },
)
