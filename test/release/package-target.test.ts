import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { defaultWorkerModules } from "@rika/kernel/kernel-composition"
import {
  archiveName,
  archiveRoot,
  expectedArchiveNames,
  isPackageTarget,
  ownedTargetEntries,
  packageBinEntries,
  targets,
  validateArchiveSet,
} from "../../scripts/packaging/package-contract"

it.layer(BunServices.layer)("release target construction", (test) => {
  test("constructs the supported OpenTUI platform mappings", () => {
    expect(Object.keys(targets)).toEqual(["darwin-arm64", "linux-arm64", "linux-x64"])
    for (const [name, target] of Object.entries(targets)) {
      expect(target.bun).toBe(`bun-${name}`)
      expect(target).toHaveProperty("opentuiLibc")
    }
  })

  test("does not claim Windows archive support", () => {
    expect(Object.keys(targets).some((target) => target.startsWith("win32-"))).toBe(false)
  })

  test("rejects unsupported targets without executing a package command", () => {
    expect(isPackageTarget("linux-x64")).toBe(true)
    expect(isPackageTarget("freebsd-x64")).toBe(false)
    expect(isPackageTarget("toString")).toBe(false)
    expect(isPackageTarget("constructor")).toBe(false)
    expect(isPackageTarget("__proto__")).toBe(false)
  })

  test("uses versioned names and assigns cleanup ownership to one target", () => {
    expect(archiveRoot("1.2.3", "linux-x64")).toBe("rika-1.2.3-linux-x64")
    expect(archiveName("1.2.3", "linux-x64")).toBe("rika-1.2.3-linux-x64.tar.gz")
    expect(ownedTargetEntries("1.2.3", "linux-x64")).toEqual(["rika-1.2.3-linux-x64", "rika-1.2.3-linux-x64.tar.gz"])
    expect(packageBinEntries).toEqual([
      "rika",
      ".rika-kernel-runtime",
      ".rika-kernel-worker.js",
      "text-result.js",
      "bun-value.js",
    ])
  })

  test.effect("packages every TenetKit worker support module", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      expect(packageBinEntries.slice(3)).toEqual(defaultWorkerModules.support.map((module) => path.basename(module)))
    }),
  )

  test("accepts only the exact supported archive set", () => {
    const exact = expectedArchiveNames("1.2.3")
    expect(validateArchiveSet("1.2.3", [...exact, "notes.txt"])).toEqual(exact)
    expect(() => validateArchiveSet("1.2.3", exact.slice(1))).toThrow("Expected exact archive set")
    expect(() => validateArchiveSet("1.2.3", [...exact, "rika-1.2.3-win32-x64.tar.gz"])).toThrow(
      "Expected exact archive set",
    )
  })

  test.effect("builds one public executable with its private kernel runtime", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const packaging = yield* fileSystem.readFileString(
        new URL("../../scripts/packaging/package-target.ts", import.meta.url).pathname,
      )
      expect(packaging).toContain('checkedBuild("client-main.ts", path.join(bin, "rika")')
      expect(packaging).toContain("bytecode: false")
      expect(packaging).toContain("defaultWorkerModules.worker")
      expect(packaging).toContain("path.join(bin, kernelWorker)")
      expect(packaging).toContain("path.join(bin, kernelRuntime)")
      for (const forbidden of ["interactive-main.ts", ".rika-interactive", "performance-main.ts"])
        expect(packaging).not.toContain(forbidden)
    }),
  )
})
