import { launcherName, platformPackageName, scope } from "./npm-package-names"
import { targetNames } from "./package-target-contract"

const shared = (version: string) => ({
  version,
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/In-Time-Tec/rika.git" },
  homepage: "https://github.com/In-Time-Tec/rika",
  engines: { node: ">=18" },
})

export const launcherManifest = (version: string) => ({
  name: launcherName,
  description: "Rika — a local durable coding agent for your terminal",
  ...shared(version),
  bin: { rika: "bin/rika.js" },
  files: ["bin/rika.js", "README.md"],
  optionalDependencies: Object.fromEntries(
    targetNames.map((target) => [platformPackageName(target), version] as const),
  ),
})

export const launcherShim = `#!/usr/bin/env node
"use strict"

const { spawnSync } = require("node:child_process")

const target = \`\${process.platform}-\${process.arch}\`
const packageName = "${scope}/cli-" + target

let binary
try {
  binary = require.resolve(packageName + "/bin/rika")
} catch {
  console.error(
    "rika: no binary for " +
      target + ".\\nSupported: ${targetNames.join(", ")}." +
      "\\nIf your platform is supported, reinstall without --no-optional or --ignore-optional.",
  )
  process.exit(1)
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" })
if (result.error !== undefined) {
  console.error("rika: failed to start " + binary + ": " + result.error.message)
  process.exit(1)
}
if (typeof result.signal === "string") process.kill(process.pid, result.signal)
process.exit(result.status === null ? 1 : result.status)
`
