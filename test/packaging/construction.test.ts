import { describe, expect, test } from "bun:test"
import { isManagedPackagingEntry, targets } from "../../scripts/package"

describe("release target construction", () => {
  test("constructs the four supported OpenTUI platform mappings", () => {
    expect(Object.keys(targets)).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
    for (const [name, target] of Object.entries(targets)) {
      expect(target.bun).toBe(`bun-${name}`)
      expect(target.opentui).toBe(`@opentui/core-${name}`)
    }
  })

  test("does not claim Windows archive support", () => {
    expect(Object.keys(targets).some((target) => target.startsWith("win32-"))).toBe(false)
  })

  test("cleans only packager-owned artifact entries", () => {
    expect(isManagedPackagingEntry("rika-linux-x64.tar.gz")).toBe(true)
    expect(isManagedPackagingEntry("rika-darwin-arm64")).toBe(true)
    expect(isManagedPackagingEntry("SHA256SUMS")).toBe(true)
    expect(isManagedPackagingEntry("release-evidence.json")).toBe(true)
    expect(isManagedPackagingEntry(".platform-packages-abc123")).toBe(true)
    expect(isManagedPackagingEntry("autoresearch")).toBe(false)
    expect(isManagedPackagingEntry("notes.txt")).toBe(false)
    expect(isManagedPackagingEntry("rika-custom.tar.gz")).toBe(false)
  })
})
