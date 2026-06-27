const requiredScripts = ["db:generate", "db:migrate", "lint", "typecheck", "test", "build", "format:check"]
const requiredFiles = [
  "README.md",
  "CONTEXT.md",
  "AGENTS.md",
  "docs/RESEARCH.md",
  "docs/effect-module-conventions.md",
  "docs/runtime-and-layers.md",
  "docs/persistence.md",
  "package.json",
  "turbo.json",
  ".oxlintrc.json",
  "packages/AGENTS.md",
  "packages/core/AGENTS.md",
  "packages/persistence/AGENTS.md",
  "packages/schema/AGENTS.md",
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
