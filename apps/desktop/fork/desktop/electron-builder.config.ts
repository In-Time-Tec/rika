import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.rika.desktop.dev",
  beta: "ai.rika.desktop.beta",
  prod: "ai.rika.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  artifactName: "rika-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: "resources/icons/icon.icns",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "Rika",
    schemes: ["rika", "opencode"],
  },
  win: {
    icon: "resources/icons/icon.ico",
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: "resources/icons/icon.ico",
    installerHeaderIcon: "resources/icons/icon.ico",
  },
  linux: {
    icon: "resources/icons",
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)
  const publish = { provider: "github" as const, owner: "In-Time-Tec", repo: "rika", channel: "latest" }

  switch (channel) {
    case "dev":
      return {
        ...base,
        appId,
        productName: "Rika Dev",
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "rika-dev", fpm: [metainfoFpm(appId)] },
      }
    case "beta":
      return {
        ...base,
        appId,
        productName: "Rika Beta",
        protocols: { name: "Rika Beta", schemes: ["rika", "opencode"] },
        publish,
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "rika-beta", fpm: [metainfoFpm(appId)] },
      }
    case "prod":
      return {
        ...base,
        appId,
        productName: "Rika",
        protocols: { name: "Rika", schemes: ["rika", "opencode"] },
        publish,
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "rika", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
  }
}

export default getConfig()
