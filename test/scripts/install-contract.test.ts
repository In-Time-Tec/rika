import { describe, expect, test } from "vitest"
import {
  binDirEnv,
  commandName,
  defaultBinDir,
  defaultInstallRoot,
  installRootEnv,
  validateInstallerScript,
} from "../../scripts/install-contract"
import { launcherManifest, packedName, platformConstraints, platformPackageName } from "../../scripts/npm-package"
import { targetNames } from "../../scripts/package"

const installer = await Bun.file(new URL("../../install.sh", import.meta.url)).text()

describe("install contract", () => {
  test("install.sh honours the same defaults as local-install.ts", () => {
    expect(() => validateInstallerScript(installer)).not.toThrow()
    expect(installer).toContain(`${installRootEnv}:-${defaultInstallRoot}`)
    expect(installer).toContain(`${binDirEnv}:-${defaultBinDir}`)
    expect(defaultInstallRoot).toBe("$HOME/.local/share/rika/current")
    expect(defaultBinDir).toBe("$HOME/.local/bin")
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
    expect(manifest.bin[commandName]).toBe("bin/rika.js")
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
