const requiredScripts = [
  "db:generate",
  "db:migrate",
  "install:local",
  "lint",
  "typecheck",
  "test",
  "build",
  "format:check",
  "package",
  "package:smoke",
  "update:local",
  "web:dev",
]
const requiredFiles = [
  "README.md",
  "CONTEXT.md",
  "AGENTS.md",
  "docs/RESEARCH.md",
  "docs/OWNER_MANUAL.md",
  "docs/SECURITY.md",
  "docs/LAUNCH_CHECKLIST.md",
  "docs/effect-module-conventions.md",
  "docs/runtime-and-layers.md",
  "docs/persistence.md",
  "docs/remote-rivet-hosting.md",
  "docs/ide-integration.md",
  "docs/local-web-sync.md",
  ".github/workflows/ci.yml",
  "package.json",
  "turbo.json",
  ".oxlintrc.json",
  "apps/AGENTS.md",
  "apps/web/AGENTS.md",
  "packages/AGENTS.md",
  "packages/server/AGENTS.md",
  "packages/sdk/AGENTS.md",
  "packages/core/AGENTS.md",
  "packages/ide/AGENTS.md",
  "packages/persistence/AGENTS.md",
  "packages/plugin/AGENTS.md",
  "packages/tools/AGENTS.md",
  "packages/schema/AGENTS.md",
  "packages/tui/AGENTS.md",
]

const packageJson = await Bun.file("package.json").json()
const missingScripts = requiredScripts.filter((script) => packageJson.scripts?.[script] === undefined)
const missingFiles = (
  await Promise.all(requiredFiles.map(async (path) => ((await Bun.file(path).exists()) ? undefined : path)))
).filter((path): path is string => path !== undefined)

if (missingScripts.length === 0 && missingFiles.length === 0) {
  console.log("docs check passed")
  process.exit(0)
}

if (missingScripts.length > 0) {
  console.error(`Missing documented package scripts: ${missingScripts.join(", ")}`)
}

if (missingFiles.length > 0) {
  console.error(`Missing guidance files: ${missingFiles.join(", ")}`)
}

process.exit(1)
