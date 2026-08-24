import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import {
  tenetkitPackages,
  verifyInstalledTenetKitPackages,
  type PackedTenetKitPackage,
} from "../../scripts/release/local-tenetkit-package-verification"
import {
  tenetkitReleaseInventoryError,
  tenetkitReleasePackages,
  tenetkitTarballName,
  catalogTenetKitVersion,
  localTenetKitLockError,
  manifestWithLocalTenetKitTarballs,
  provisionProvenHostArchive,
  type TenetKitReleaseEvidence,
} from "../../scripts/release/local-tenetkit-smoke"
import { directoryDigest } from "../../scripts/upstream/upstream-content-digest"

const version = "0.20.2"
const evidence: TenetKitReleaseEvidence = {
  schemaVersion: 1,
  packages: tenetkitReleasePackages.map((packageName) => ({
    name: packageName,
    version,
    filename: tenetkitTarballName(packageName, version),
    sha256: packageName.replaceAll("@", "").replaceAll("/", "-").padEnd(64, "0"),
  })),
}
const checksumNames = [...evidence.packages.map(({ filename }) => filename), "release-evidence.json"]
const RootManifest = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
const rootManifest = await Effect.runPromise(
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.readFileString(new URL("../../package.json", import.meta.url).pathname),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RootManifest))), Effect.provide(BunServices.layer)),
)

it.layer(BunServices.layer)("local TenetKit release smoke", (test) => {
  test("exposes one canonical root command", () => {
    expect(rootManifest.scripts["local-tenetkit-smoke"]).toBe("bun run scripts/release/local-tenetkit-smoke.ts")
  })

  test("overrides every consumed package while preserving the catalog", () => {
    expect(tenetkitPackages).toEqual(["tenetkit", "@tenetkit/pg"])
    const catalog = { tenetkit: version }
    const manifest = {
      name: "consumer",
      workspaces: { packages: ["packages/*"], catalog: { ...catalog, effect: "4.0.0" } },
    }

    expect(catalogTenetKitVersion(catalog)).toBe(version)
    const tarballs = Object.fromEntries(
      tenetkitPackages.map((packageName) => [
        packageName,
        `file:/release/${tenetkitTarballName(packageName, version)}`,
      ]),
    )
    expect(manifestWithLocalTenetKitTarballs(manifest, "/release", version)).toEqual({
      ...manifest,
      overrides: tarballs,
    })
  })

  test("rejects nested and top-level registry TenetKit lock resolutions", () => {
    const local = tenetkitPackages.map((name) => tenetkitTarballName(name, version)).join("\n")
    expect(localTenetKitLockError(local, version)).toBeUndefined()
    expect(localTenetKitLockError(`${local}\n    "@tenetkit/pg/tenetkit": ["tenetkit@${version}"]`, version)).toContain(
      "nested @tenetkit/pg/tenetkit registry",
    )
    expect(localTenetKitLockError(`${local}\n    "@tenetkit/pg": ["@tenetkit/pg@${version}"]`, version)).toContain(
      "registry",
    )
  })

  test("accepts only TenetKit's exact four-package evidence and five-entry checksum inventory", () => {
    expect(tenetkitReleasePackages).toEqual(["tenetkit", "@tenetkit/pg", "@tenetkit/mysql", "@tenetkit/cloudflare"])
    expect(checksumNames).toHaveLength(5)
    expect(tenetkitReleaseInventoryError(evidence, version, checksumNames)).toBeUndefined()
    expect(
      tenetkitReleaseInventoryError({ ...evidence, packages: evidence.packages.slice(1) }, version, checksumNames),
    ).toContain("exact current public package release train")
    expect(
      tenetkitReleaseInventoryError(
        { ...evidence, packages: [...evidence.packages, { ...evidence.packages[0]!, name: "@tenetkit/rogue" }] },
        version,
        checksumNames,
      ),
    ).toContain("exact current public package release train")
    expect(tenetkitReleaseInventoryError(evidence, version, checksumNames.slice(1))).toContain(
      "exactly every package tarball",
    )
    expect(tenetkitReleaseInventoryError({ ...evidence, schemaVersion: 2 }, version, checksumNames)).toContain(
      "schema version 1",
    )
  })

  test("rejects a mixed or non-exact consumed TenetKit catalog", () => {
    const catalog = Object.fromEntries(tenetkitPackages.map((packageName) => [packageName, version]))
    expect(() => catalogTenetKitVersion({ tenetkit: "^0.20.2" })).toThrow("not exact semver")
    expect(() => catalogTenetKitVersion({})).toThrow("one exact version")
    expect(() => catalogTenetKitVersion({ ...catalog, "@tenetkit/pg": "0.20.1" })).toThrow("one exact version")
  })

  test.effect("locates every exact package when it is only in the isolated store", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const isolatedRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-tenetkit-install-fixture-" })
        const packedRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-tenetkit-packed-fixture-" })
        const packedPackages = new Map<string, PackedTenetKitPackage>()
        const installedDirectories = new Map<string, string>()

        const writePackage = Effect.fn(function* (directory: string, manifest: string, source: string) {
          yield* fileSystem.makeDirectory(path.join(directory, "dist"), { recursive: true })
          yield* fileSystem.writeFileString(path.join(directory, "package.json"), manifest)
          yield* fileSystem.writeFileString(path.join(directory, "dist", "index.js"), source)
        })

        for (const name of tenetkitPackages) {
          const manifest = `${JSON.stringify({ name, version }, undefined, 2)}
`
          const source = `export const packageName = ${JSON.stringify(name)}
`
          const packedDirectory = path.join(packedRoot, name.replaceAll("/", "-"))
          yield* writePackage(packedDirectory, manifest, source)
          packedPackages.set(name, {
            manifest: manifest.trim(),
            directoryDigest: yield* directoryDigest(packedDirectory),
          })
          // Only in Bun's isolated store, never at the node_modules root: the resolver has to find
          // it through the store the way a real isolated install lays it out.
          const installedDirectory = path.join(
            isolatedRoot,
            "node_modules",
            ".bun",
            `${name.replaceAll("/", "-")}-exact`,
            "node_modules",
            ...name.split("/"),
          )
          yield* writePackage(installedDirectory, manifest, source)
          installedDirectories.set(name, installedDirectory)
        }

        // A second copy carrying the right manifest but the wrong bytes must not be mistaken for
        // the packed package; only the digest separates it from the real one.
        const tamperedName = tenetkitPackages[0]
        const tamperedManifest = `${JSON.stringify({ name: tamperedName, version }, undefined, 2)}
`
        yield* writePackage(
          path.join(
            isolatedRoot,
            "node_modules",
            ".bun",
            `${tamperedName.replaceAll("/", "-")}-tampered`,
            "node_modules",
            ...tamperedName.split("/"),
          ),
          tamperedManifest,
          "tampered",
        )

        for (const name of tenetkitPackages)
          expect(yield* fileSystem.exists(path.join(isolatedRoot, "node_modules", ...name.split("/")))).toBe(false)
        const installed = yield* verifyInstalledTenetKitPackages({ isolatedRoot, version, packedPackages })
        expect(installed.map(({ name }) => name)).toEqual([...tenetkitPackages])
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
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-local-tenetkit-provision-" })
        const sourceRoot = path.join(directory, "source")
        const isolatedRoot = path.join(directory, "isolated")
        const filename = "rika-0.5.3-darwin-arm64.tar.gz"
        const proven = new TextEncoder().encode("proven local TenetKit archive")
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
