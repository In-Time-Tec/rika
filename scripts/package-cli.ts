import { $ } from "bun"

const root = new URL("..", import.meta.url)
const rootDir = root.pathname
const bunNodeModulesDir = new URL("node_modules/.bun/node_modules/", root).pathname
const packageJson = readPackageJson(await Bun.file(new URL("package.json", root)).json())
const artifactName = `rika-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`
const outDir = new URL("dist/release/", root)
const shareRoot = new URL("dist/share/rika/", root)
const drizzleShareDir = new URL("drizzle/", shareRoot)
const inspectShareDir = new URL("inspect/", shareRoot)
const inspectWebShareDir = new URL("web/dist/", shareRoot)
const migrationsDir = new URL("packages/persistence/drizzle/", root)
const inspectWebDistDir = new URL("packages/motel/web/dist/", root)
const artifact = new URL(artifactName, outDir)
const inspectEntry = new URL("packages/motel/src/motel.ts", root).pathname

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
  share: {
    drizzle: "dist/share/rika/drizzle",
    inspect: "dist/share/rika/inspect/inspect.js",
    inspect_web: "dist/share/rika/web/dist",
  },
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
await $`rm -rf ${shareRoot.pathname}`
await $`mkdir -p ${drizzleShareDir.pathname} ${inspectShareDir.pathname} ${inspectWebShareDir.pathname}`
await $`cp -R ${migrationsDir.pathname}. ${drizzleShareDir.pathname}`
await $`cp -R ${inspectWebDistDir.pathname}. ${inspectWebShareDir.pathname}`
await $`bun build ${inspectEntry} --target bun --format esm ${externalFlags} --outdir ${inspectShareDir.pathname}`
await $`mv ${new URL("motel.js", inspectShareDir).pathname} ${new URL("inspect.js", inspectShareDir).pathname}`
await sanitizeSourcemapDirectives(new URL("inspect.js", inspectShareDir))
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

async function sanitizeSourcemapDirectives(file: URL) {
  const text = await Bun.file(file).text()
  await Bun.write(file, text.replaceAll("//# sourceMappingURL=", "// sourceMappingURL="))
}
