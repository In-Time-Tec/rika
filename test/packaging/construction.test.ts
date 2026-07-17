import { describe, expect, test } from "bun:test"
import { dirname, join, resolve } from "node:path"
import { isManagedPackagingEntry, targets } from "../../scripts/package"

const sourceImports = (source: string) => {
  const imports = new Set<string>()
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /^\s*import\s+["']([^"']+)["']/gm,
  ])
    for (const match of source.matchAll(pattern)) if (match[1] !== undefined) imports.add(match[1])
  return imports
}

const resolveSource = async (path: string) => {
  for (const candidate of [path, `${path}.ts`, join(path, "index.ts")])
    if (await Bun.file(candidate).exists()) return candidate
  return undefined
}

const clientSourceGraph = async () => {
  const root = resolve(import.meta.dir, "../..")
  const packages = new Map<string, { readonly root: string; readonly exports: Record<string, string> }>()
  for await (const manifestPath of new Bun.Glob("packages/*/package.json").scan({ cwd: root, absolute: true })) {
    const manifest = (await Bun.file(manifestPath).json()) as {
      readonly name: string
      readonly exports: Record<string, string>
    }
    packages.set(manifest.name, { root: dirname(manifestPath), exports: manifest.exports })
  }
  const files = new Set<string>()
  const external = new Set<string>()
  const pending = [join(root, "apps/rika/src/client-main.ts")]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (files.has(file)) continue
    files.add(file)
    for (const specifier of sourceImports(await Bun.file(file).text())) {
      if (specifier.startsWith(".")) {
        const resolved = await resolveSource(resolve(dirname(file), specifier))
        if (resolved !== undefined) pending.push(resolved)
        continue
      }
      const parts = specifier.split("/")
      const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
      const workspacePackage = packages.get(packageName)
      if (workspacePackage === undefined) {
        external.add(specifier)
        continue
      }
      const subpath = parts.slice(packageName.startsWith("@") ? 2 : 1).join("/")
      const target = workspacePackage.exports[subpath.length === 0 ? "." : `./${subpath}`]
      if (target === undefined) throw new Error(`Missing package export for ${specifier}`)
      const resolved = await resolveSource(resolve(workspacePackage.root, target))
      if (resolved === undefined) throw new Error(`Missing source for ${specifier}`)
      pending.push(resolved)
    }
  }
  return { files, external }
}

describe("release target construction", () => {
  test("constructs the four supported OpenTUI platform mappings", () => {
    expect(Object.keys(targets)).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
    for (const [name, target] of Object.entries(targets)) {
      expect(target.bun).toBe(`bun-${name}`)
      expect(target.opentui).toBe(`@opentui/core-${name}`)
    }
  })

  test("does not claim Windows archive support", () => {
    expect(Object.keys(targets).some((target) => target.startsWith("win32-"))).toBe(false)
  })

  test("cleans only packager-owned artifact entries", () => {
    expect(isManagedPackagingEntry("rika-linux-x64.tar.gz")).toBe(true)
    expect(isManagedPackagingEntry("rika-darwin-arm64")).toBe(true)
    expect(isManagedPackagingEntry("SHA256SUMS")).toBe(true)
    expect(isManagedPackagingEntry("release-evidence.json")).toBe(true)
    expect(isManagedPackagingEntry(".platform-packages-abc123")).toBe(true)
    expect(isManagedPackagingEntry("autoresearch")).toBe(false)
    expect(isManagedPackagingEntry("notes.txt")).toBe(false)
    expect(isManagedPackagingEntry("rika-custom.tar.gz")).toBe(false)
  })

  test("keeps the full public client graph out of the resident, SQL, model, and TUI runtimes", async () => {
    const graph = await clientSourceGraph()
    const files = [...graph.files].join("\n")
    const external = [...graph.external].join("\n")
    for (const forbidden of [
      "/resident-host-transport.ts",
      "/apps/rika/src/main.ts",
      "/product-database.ts",
      "/thread-repository.ts",
      "/turn-repository.ts",
      "/transcript-repository.ts",
      "/execution-backend.ts",
      "/packages/tools/",
      "/packages/tui/",
    ])
      expect(files).not.toContain(forbidden)
    for (const forbidden of ["@batonfx/providers", "@relayfx/", "@opentui/", "@ff-labs/"])
      expect(external).not.toContain(forbidden)
    expect(files).toContain("/operation-contract.ts")
    expect(files).toContain("/resident-client-transport.ts")
  })
})
