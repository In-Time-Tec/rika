import { describe, expect, test } from "vitest"
import {
  archiveCommandName,
  binDirEnv,
  defaultBinDir,
  defaultInstallRoot,
  devCommandName,
  devRootSegments,
  installRootEnv,
  releaseCommandName,
  releaseRootSegments,
  validateInstallerScript,
} from "../../scripts/installation/install-contract"
import {
  launcherManifest,
  packedName,
  platformConstraints,
  platformPackageName,
} from "../../scripts/packaging/npm-package"
import { archiveName, archiveRoot, targetNames } from "../../scripts/packaging/package-target"
import * as ReleaseDownload from "../../apps/rika/src/release/release-download"
import * as ReleaseInstall from "../../apps/rika/src/release/release-install"
import * as ReleaseUpdate from "../../apps/rika/src/release/release-update"

const installer = await Bun.file(new URL("../../install.sh", import.meta.url)).text()

describe("install contract", () => {
  test("install.sh honours the same defaults as local-install.ts", () => {
    expect(() => validateInstallerScript(installer)).not.toThrow()
    expect(installer).toContain(`${installRootEnv}:-${defaultInstallRoot}`)
    expect(installer).toContain(`${binDirEnv}:-${defaultBinDir}`)
    expect(defaultInstallRoot).toBe("$HOME/.local/share/rika/current")
    expect(defaultBinDir).toBe("$HOME/.local/bin")
  })

  test("keeps a source build from colliding with a released install", () => {
    expect(devCommandName).toBe("rika-dev")
    expect(releaseCommandName).toBe("rika")
    expect(devCommandName).not.toBe(releaseCommandName)
    expect(devRootSegments).not.toEqual(releaseRootSegments)
    expect(archiveCommandName).toBe("rika")
  })

  test("install.sh installs the released command only", () => {
    expect(installer).not.toContain(devCommandName)
    expect(() => validateInstallerScript(`${installer}\n# ${devCommandName}`)).toThrow(devCommandName)
  })

  test("install.sh rejects a drifted default", () => {
    expect(() => validateInstallerScript(installer.replaceAll(defaultBinDir, "$HOME/bin"))).toThrow(binDirEnv)
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
    expect(ReleaseInstall.installRootEnv).toBe(installRootEnv)
    expect(devRootSegments).toContain(ReleaseInstall.developmentRootSegment)
  })

  test("rika update names the same artifacts the packaging step publishes", () => {
    expect(ReleaseInstall.releaseTargets.toSorted()).toEqual(targetNames.toSorted())
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
    expect(manifest.bin[releaseCommandName]).toBe("bin/rika.js")
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
