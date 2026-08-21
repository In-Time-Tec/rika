import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import {
  expectedArchiveNames,
  ownedTargetEntries,
  validateArchiveSet,
  archiveName,
  archiveRoot,
} from "../../scripts/packaging/release-archive"
import { isPackageTarget, targets } from "../../scripts/packaging/package-target-contract"

describe("release target construction", () => {
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
  })

  test("accepts only the exact four-archive release set", () => {
    const exact = expectedArchiveNames("1.2.3")
    expect(validateArchiveSet("1.2.3", [...exact, "notes.txt"])).toEqual(exact)
    expect(() => validateArchiveSet("1.2.3", exact.slice(1))).toThrow("Expected exact archive set")
    expect(() => validateArchiveSet("1.2.3", [...exact, "rika-1.2.3-win32-x64.tar.gz"])).toThrow(
      "Expected exact archive set",
    )
  })

  test("builds the public client and private interactive runtime", async () => {
    const packaging = await readFile(
      join(fileURLToPath(new URL("../..", import.meta.url)), "scripts/packaging/package-target.ts"),
      "utf8",
    )
    expect(packaging).toContain('checkedBuild("client-main.ts", path.join(bin, "rika")')
    expect(packaging).toContain('checkedBuild("interactive-main.ts", path.join(bin, ".rika-interactive")')
    for (const forbidden of [
      "performance-main.ts",
      ".rika-kernel-runtime",
      ".rika-kernel-worker.js",
      "text-result.js",
    ])
      expect(packaging).not.toContain(forbidden)
  })
})
