import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import {
  batonPackages,
  verifyInstalledBatonPackages,
  type PackedBatonPackage,
} from "../../scripts/release/local-baton-package-verification"
import {
  batonReleaseInventoryError,
  batonReleasePackages,
  batonTarballName,
  catalogBatonVersion,
  manifestWithLocalBatonTarballs,
  provisionProvenHostArchive,
  type BatonReleaseEvidence,
} from "../../scripts/release/local-baton-smoke"
import { directoryDigest } from "../../scripts/upstream/upstream-content-digest"

const version = "0.20.2"
const evidence: BatonReleaseEvidence = {
  schemaVersion: 1,
  packages: batonReleasePackages.map((packageName) => ({
    name: `@batonfx/${packageName}`,
    version,
    filename: `batonfx-${packageName}-${version}.tgz`,
    sha256: packageName.padEnd(64, "0"),
  })),
}
const checksumNames = [...evidence.packages.map(({ filename }) => filename), "release-evidence.json"]
const rootManifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
  readonly scripts: Readonly<Record<string, string>>
}

it.layer(BunServices.layer)("local Baton release smoke", (test) => {
  test("exposes one canonical root command", () => {
    expect(rootManifest.scripts["local-baton-smoke"]).toBe("bun run scripts/release/local-baton-smoke.ts")
  })

  test("rewrites all eight consumed packages and only Baton catalog entries", () => {
    expect(batonPackages).toEqual(["core", "mcp", "providers", "runtime", "skills", "harness", "repl", "test"])
    const catalog = Object.fromEntries(batonPackages.map((packageName) => [`@batonfx/${packageName}`, version]))
    const manifest = {
      name: "consumer",
      workspaces: { packages: ["packages/*"], catalog: { ...catalog, effect: "4.0.0" } },
    }

    expect(catalogBatonVersion(catalog)).toBe(version)
    const tarballs = Object.fromEntries(
      batonPackages.map((packageName) => [
        `@batonfx/${packageName}`,
        `file:/release/${batonTarballName(packageName, version)}`,
      ]),
    )
    expect(manifestWithLocalBatonTarballs(manifest, "/release", version)).toEqual({
      ...manifest,
      overrides: tarballs,
      workspaces: {
        ...manifest.workspaces,
        catalog: {
          effect: "4.0.0",
          ...tarballs,
        },
      },
    })
  })

  test("accepts only Baton's exact thirteen-package evidence and fourteen-entry checksum inventory", () => {
    expect(batonReleasePackages).toHaveLength(13)
    expect(checksumNames).toHaveLength(14)
    expect(batonReleaseInventoryError(evidence, version, checksumNames)).toBeUndefined()
    expect(
      batonReleaseInventoryError({ ...evidence, packages: evidence.packages.slice(1) }, version, checksumNames),
    ).toContain("exact current public package release train")
    expect(
      batonReleaseInventoryError(
        { ...evidence, packages: [...evidence.packages, { ...evidence.packages[0]!, name: "@batonfx/rogue" }] },
        version,
        checksumNames,
      ),
    ).toContain("exact current public package release train")
    expect(batonReleaseInventoryError(evidence, version, checksumNames.slice(1))).toContain(
      "exactly every package tarball",
    )
    expect(batonReleaseInventoryError({ ...evidence, schemaVersion: 2 }, version, checksumNames)).toContain(
      "schema version 1",
    )
  })

  test("rejects a mixed or non-exact consumed Baton catalog", () => {
    const catalog = Object.fromEntries(batonPackages.map((packageName) => [`@batonfx/${packageName}`, version]))
    expect(() => catalogBatonVersion({ ...catalog, "@batonfx/test": "0.20.1" })).toThrow("one exact version")
    expect(() => catalogBatonVersion({ ...catalog, "@batonfx/test": "^0.20.2" })).toThrow("one exact version")
    expect(() => catalogBatonVersion(Object.fromEntries(Object.entries(catalog).slice(1)))).toThrow("one exact version")
  })

  test.effect("locates every exact package when harness and repl are only in the isolated store", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const isolatedRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-baton-install-fixture-" })
        const packedRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-baton-packed-fixture-" })
        const packedPackages = new Map<string, PackedBatonPackage>()
        const installedDirectories = new Map<string, string>()

        const writePackage = Effect.fn(function* (directory: string, manifest: string, source: string) {
          yield* fileSystem.makeDirectory(path.join(directory, "dist"), { recursive: true })
          yield* fileSystem.writeFileString(path.join(directory, "package.json"), manifest)
          yield* fileSystem.writeFileString(path.join(directory, "dist", "index.js"), source)
        })

        for (const packageName of batonPackages) {
          const name = `@batonfx/${packageName}`
          const manifest = `${JSON.stringify({ name, version }, undefined, 2)}
`
          const source = `export const packageName = ${JSON.stringify(packageName)}
`
          const packedDirectory = path.join(packedRoot, packageName)
          yield* writePackage(packedDirectory, manifest, source)
          packedPackages.set(name, {
            manifest: manifest.trim(),
            directoryDigest: yield* directoryDigest(packedDirectory),
          })
          const installedDirectory =
            packageName === "harness" || packageName === "repl"
              ? path.join(
                  isolatedRoot,
                  "node_modules",
                  ".bun",
                  `${packageName}-exact`,
                  "node_modules",
                  "@batonfx",
                  packageName,
                )
              : path.join(isolatedRoot, "node_modules", "@batonfx", packageName)
          yield* writePackage(installedDirectory, manifest, source)
          installedDirectories.set(name, installedDirectory)
        }

        const harnessManifest = `${JSON.stringify({ name: "@batonfx/harness", version }, undefined, 2)}
`
        yield* writePackage(
          path.join(isolatedRoot, "node_modules", ".bun", "harness-tampered", "node_modules", "@batonfx", "harness"),
          harnessManifest,
          "tampered",
        )

        expect(yield* fileSystem.exists(path.join(isolatedRoot, "node_modules", "@batonfx", "harness"))).toBe(false)
        expect(yield* fileSystem.exists(path.join(isolatedRoot, "node_modules", "@batonfx", "repl"))).toBe(false)
        const installed = yield* verifyInstalledBatonPackages({ isolatedRoot, version, packedPackages })
        expect(installed.map(({ name }) => name)).toEqual(batonPackages.map((name) => `@batonfx/${name}`))
        for (const item of installed)
          expect(item.directory).toBe(yield* fileSystem.realPath(installedDirectories.get(item.name)!))
      }),
    ),
  )

  test.effect("provisions the exact proven host archive for install-local", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-local-baton-provision-" })
        const sourceRoot = path.join(directory, "source")
        const isolatedRoot = path.join(directory, "isolated")
        const filename = "rika-0.5.3-darwin-arm64.tar.gz"
        const proven = new TextEncoder().encode("proven local Baton archive")
        yield* fileSystem.makeDirectory(path.join(sourceRoot, "artifacts"), { recursive: true })
        yield* fileSystem.makeDirectory(path.join(isolatedRoot, "artifacts"), { recursive: true })
        yield* fileSystem.writeFile(path.join(sourceRoot, "artifacts", filename), new TextEncoder().encode("stale"))
        yield* fileSystem.writeFile(path.join(isolatedRoot, "artifacts", filename), proven)

        const destination = yield* provisionProvenHostArchive({
          sourceRoot,
          isolatedRoot,
          version: "0.5.3",
          target: "darwin-arm64",
        })

        expect(destination).toBe(path.join(sourceRoot, "artifacts", filename))
        expect(Array.from(yield* fileSystem.readFile(destination))).toEqual(Array.from(proven))
      }),
    ),
  )
})
