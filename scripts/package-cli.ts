import { $ } from "bun"

const root = new URL("..", import.meta.url)
const rootDir = root.pathname
const bunNodeModulesDir = new URL("node_modules/.bun/node_modules/", root).pathname
const packageJson = readPackageJson(await Bun.file(new URL("package.json", root)).json())
const artifactName = `rika-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`
const outDir = new URL("dist/release/", root)
const shareDir = new URL("dist/share/rika/drizzle/", root)
const migrationsDir = new URL("packages/persistence/drizzle/", root)
const artifact = new URL(artifactName, outDir)

// OpenTUI ships its native FFI library as a set of per-platform optional
// packages (`@opentui/core-<platform>-<arch>`), each containing a prebuilt
// `libopentui` dylib/so/dll. Only the package matching the build host is
// installed; the rest must be marked external so the bundler does not try to
// resolve the dynamic `import("@opentui/core-…")` branches for other platforms.
// The matching package IS bundled so `bun build --compile` embeds its native
// library into the standalone binary.
const nativeTargets = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
]
const bundledNative = nativeTargets.filter(isResolvable)
const externalNative = nativeTargets.filter((name) => !isResolvable(name))
const externalFlags = externalNative.flatMap((name) => ["--external", name])

const manifest = {
  name: "rika",
  version: packageJson.version ?? "0.0.0",
  bun_version: Bun.version,
  platform: process.platform,
  arch: process.arch,
  entrypoint: "packages/cli/src/main.ts",
  artifact: `dist/release/${artifactName}`,
  native: {
    bundled: bundledNative,
    external: externalNative,
  },
}

if (bundledNative.length === 0) {
  console.warn(
    `[package-cli] no @opentui/core native package resolved for ${process.platform}-${process.arch}; ` +
      "the packaged binary will fail to launch the TUI. Run `bun install` on the target platform.",
  )
}

await $`mkdir -p ${outDir.pathname}`
await $`rm -rf ${shareDir.pathname}`
await $`mkdir -p ${shareDir.pathname}`
await $`cp -R ${migrationsDir.pathname}. ${shareDir.pathname}`
await $`bun build --compile packages/cli/src/main.ts ${externalFlags} --outfile ${artifact.pathname}`
await Bun.write(new URL(`${artifactName}.json`, outDir), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(JSON.stringify(manifest))

function isResolvable(name: string): boolean {
  for (const base of [rootDir, bunNodeModulesDir]) {
    try {
      Bun.resolveSync(name, base)
      return true
    } catch {
      continue
    }
  }
  return false
}

function readPackageJson(value: unknown) {
  if (typeof value !== "object" || value === null || !("version" in value)) return {}
  const version = value.version
  return typeof version === "string" ? { version } : {}
}
