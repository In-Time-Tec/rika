import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { live, readText } from "../support/platform"
import {
  launcherManifest,
  packedName,
  platformConstraints,
  platformManifest,
  platformPackageName,
} from "../../scripts/packaging/npm-package"
import { archiveName, archiveRoot, targetNames } from "../../scripts/packaging/package-contract"
import * as ReleaseDownload from "../../apps/rika/src/release/download"
import * as ReleaseInstall from "../../apps/rika/src/release/install"
import * as ReleaseUpdate from "../../apps/rika/src/release/update"

const installer = await Effect.runPromise(live(readText(new URL("../../install.sh", import.meta.url))))

describe("install contract", () => {
  test("installs the released command to the documented defaults", () => {
    expect(installer).toContain('install_root="${RIKA_INSTALL_ROOT:-$HOME/.local/share/rika/current}"')
    expect(installer).toContain('bin_dir="${RIKA_BIN_DIR:-$HOME/.local/bin}"')
  })

  test("install.sh validates the strict one-executable archive inventory", () => {
    expect(installer).toContain("verify_archive_inventory")
    expect(installer).toContain('"${archive_root}/INSTALL"')
    expect(installer).toContain('"${archive_root}/bin/rika"')
    for (const forbidden of [
      ".rika-interactive",
      ".rika-performance",
      ".rika-kernel-runtime",
      ".rika-kernel-worker.js",
      "text-result.js",
    ])
      expect(installer).not.toContain(forbidden)
  })

  test("install.sh verifies a checksum before publishing the install", () => {
    const verifyAt = installer.indexOf("verify_checksum ")
    const publishAt = installer.indexOf(`mv "${"${staging}"}/${"${archive_root}"}"`)
    expect(verifyAt).toBeGreaterThan(0)
    expect(publishAt).toBeGreaterThan(verifyAt)
  })

  test("install.sh stages beside the install root so publishing is one same-filesystem rename", () => {
    expect(installer).toContain('mktemp -d "${install_parent}/.rika-install-XXXXXX"')
    expect(installer).toContain('install_parent="$(dirname "$install_root")"')
    expect(installer).toContain('previous="${install_parent}/.rika-previous-$$"')
    const stagingAt = installer.indexOf('rm -rf "$staging"')
    const restoreAt = installer.indexOf('mv "$previous" "$install_root"')
    expect(restoreAt).toBeGreaterThan(0)
    expect(restoreAt).toBeLessThan(stagingAt)
  })

  test("install.sh replaces only the command it installed", () => {
    expect(installer).toContain("was not installed by this script")
    expect(installer).toContain('"${RIKA_FORCE_LINK:-}" != 1')
    const guardAt = installer.indexOf("was not installed by this script")
    const downloadAt = installer.indexOf('curl -fsSL "${base_url}')
    expect(guardAt).toBeGreaterThan(0)
    expect(guardAt).toBeLessThan(downloadAt)
  })

  test("rika update and install.sh read the same release overrides", () => {
    expect(installer).toContain(`${ReleaseDownload.releaseApiUrlEnv}:-`)
    expect(installer).toContain(`${ReleaseDownload.releaseBaseUrlEnv}:-`)
    expect(ReleaseInstall.installRootEnv).toBe("RIKA_INSTALL_ROOT")
  })

  test("rika update names the same artifacts the packaging step publishes", () => {
    for (const target of targetNames) {
      expect(ReleaseUpdate.archiveFileName("1.2.3", target)).toBe(archiveName("1.2.3", target))
      expect(ReleaseUpdate.archiveRootName("1.2.3", target)).toBe(archiveRoot("1.2.3", target))
      expect(installer).toContain(`${ReleaseInstall.releaseRepository}`)
    }
  })

  test("install.sh covers every packaged target", () => {
    for (const target of targetNames) {
      const [, architecture] = target.split("-")
      expect(installer).toContain(`${architecture}"`)
    }
  })

  test("the npm launcher declares one optional dependency per target", () => {
    const manifest = launcherManifest("1.2.3")
    expect(Object.keys(manifest.optionalDependencies).toSorted()).toEqual(
      targetNames.map(platformPackageName).toSorted(),
    )
    for (const version of Object.values(manifest.optionalDependencies)) expect(version).toBe("1.2.3")
    expect(manifest.bin.rika).toBe("bin/rika.js")
  })

  test("platform npm packages expose exactly bin/rika", () => {
    expect(platformManifest("linux-x64", "1.2.3").files).toEqual(["bin/rika"])
  })

  test("platform packages constrain os and cpu", () => {
    expect(platformConstraints("darwin-arm64")).toEqual({ os: "darwin", cpu: "arm64" })
    expect(platformConstraints("linux-x64")).toEqual({ os: "linux", cpu: "x64" })
  })

  test("packed names match what the publish workflow uploads", () => {
    expect(packedName("@rikafx/cli", "1.2.3")).toBe("rikafx-cli-1.2.3.tgz")
    expect(packedName("@rikafx/cli-linux-x64", "1.2.3")).toBe("rikafx-cli-linux-x64-1.2.3.tgz")
  })
})
