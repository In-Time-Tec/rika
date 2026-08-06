import { describe, expect, test } from "vitest"
import {
  batonPackages,
  batonTarballName,
  catalogBatonVersion,
  manifestWithLocalBatonTarballs,
} from "../../scripts/release/local-baton-smoke"

describe("local Baton release smoke", () => {
  test("requires one exact Baton version and rewrites only its consumer catalog entries", () => {
    const catalog = Object.fromEntries(batonPackages.map((packageName) => [`@batonfx/${packageName}`, "0.16.0"]))
    const manifest = {
      name: "consumer",
      workspaces: { packages: ["packages/*"], catalog: { ...catalog, effect: "4.0.0" } },
    }

    expect(catalogBatonVersion(catalog)).toBe("0.16.0")
    const tarballs = Object.fromEntries(
      batonPackages.map((packageName) => [
        `@batonfx/${packageName}`,
        `file:/release/${batonTarballName(packageName, "0.16.0")}`,
      ]),
    )
    expect(manifestWithLocalBatonTarballs(manifest, "/release", "0.16.0")).toEqual({
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

  test("rejects a mixed or non-exact Baton catalog", () => {
    const catalog = Object.fromEntries(batonPackages.map((packageName) => [`@batonfx/${packageName}`, "0.16.0"]))
    expect(() => catalogBatonVersion({ ...catalog, "@batonfx/test": "0.15.0" })).toThrow("one exact version")
    expect(() => catalogBatonVersion({ ...catalog, "@batonfx/test": "^0.16.0" })).toThrow("one exact version")
    expect(() => catalogBatonVersion(Object.fromEntries(Object.entries(catalog).slice(1)))).toThrow("one exact version")
  })
})
