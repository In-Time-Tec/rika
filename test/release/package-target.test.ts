import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { access, readFile, readdir, stat } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import {
  expectedArchiveNames,
  ownedTargetEntries,
  validateArchiveSet,
  archiveName,
  archiveRoot,
} from "../../scripts/packaging/release-archive"
import { isPackageTarget, targets } from "../../scripts/packaging/package-target-contract"

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
    try {
      await access(candidate)
      if ((await stat(candidate)).isFile()) return candidate
    } catch {}
  return undefined
}

const sourceGraph = async (entrypoint: string) => {
  const root = fileURLToPath(new URL("../..", import.meta.url))
  const packages = new Map<string, { readonly root: string; readonly exports: Record<string, string> }>()
  for (const directory of await readdir(join(root, "packages"))) {
    const manifestPath = join(root, "packages", directory, "package.json")
    try {
      await access(manifestPath)
    } catch {
      continue
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      readonly name: string
      readonly exports: Record<string, string>
    }
    packages.set(manifest.name, { root: dirname(manifestPath), exports: manifest.exports })
  }
  const files = new Set<string>()
  const external = new Set<string>()
  const pending = [join(root, "apps/rika/src", entrypoint)]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (files.has(file)) continue
    files.add(file)
    for (const specifier of sourceImports(await readFile(file, "utf8"))) {
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
  test("constructs the supported OpenTUI platform mappings", () => {
    expect(Object.keys(targets)).toEqual(["darwin-arm64", "linux-arm64", "linux-x64"])
    for (const [name, target] of Object.entries(targets)) {
      expect(target.bun).toBe(`bun-${name}`)
      expect(target).toHaveProperty("opentuiLibc")
    }
  })

  test("does not claim Windows archive support", () => {
    expect(Object.keys(targets).some((target) => target.startsWith("win32-"))).toBe(false)
  })

  test("rejects unsupported targets without executing a package command", () => {
    expect(isPackageTarget("linux-x64")).toBe(true)
    expect(isPackageTarget("freebsd-x64")).toBe(false)
    expect(isPackageTarget("toString")).toBe(false)
    expect(isPackageTarget("constructor")).toBe(false)
    expect(isPackageTarget("__proto__")).toBe(false)
  })

  test("uses versioned names and assigns cleanup ownership to one target", () => {
    expect(archiveRoot("1.2.3", "linux-x64")).toBe("rika-1.2.3-linux-x64")
    expect(archiveName("1.2.3", "linux-x64")).toBe("rika-1.2.3-linux-x64.tar.gz")
    expect(ownedTargetEntries("1.2.3", "linux-x64")).toEqual(["rika-1.2.3-linux-x64", "rika-1.2.3-linux-x64.tar.gz"])
  })

  test("accepts only the exact four-archive release set", () => {
    const exact = expectedArchiveNames("1.2.3")
    expect(validateArchiveSet("1.2.3", [...exact, "notes.txt"])).toEqual(exact)
    expect(() => validateArchiveSet("1.2.3", exact.slice(1))).toThrow("Expected exact archive set")
    expect(() => validateArchiveSet("1.2.3", [...exact, "rika-1.2.3-win32-x64.tar.gz"])).toThrow(
      "Expected exact archive set",
    )
  })

  test("keeps the public client executable as the private server role owner without loading the TUI", async () => {
    const graph = await sourceGraph("client-main.ts")
    const source = await readFile(
      join(fileURLToPath(new URL("../..", import.meta.url)), "apps/rika/src/client-main.ts"),
      "utf8",
    )
    const files = [...graph.files].join("\n")
    const external = [...graph.external].join("\n")
    expect(source).toContain("isServerProcessLaunch()")
    expect(source).toContain("startServer()")
    for (const forbidden of ["/packages/terminal/"]) expect(files).not.toContain(forbidden)
    for (const forbidden of ["@opentui/"]) expect(external).not.toContain(forbidden)
    expect(files).toContain("/transport/host/server-host-transport.ts")
    expect(files).toContain("/transport/client/server-client-transport.ts")
  })

  test("keeps executable dependency sets separated", async () => {
    const interactive = await sourceGraph("interactive-main.ts")
    const server = await sourceGraph("server-main.ts")
    const interactiveFiles = [...interactive.files].join("\n")
    const serverFiles = [...server.files].join("\n")
    expect(interactiveFiles).not.toContain("/transport/host/server-host-transport.ts")
    expect(interactiveFiles).not.toContain("/model-provider-runtime.ts")
    expect([...interactive.external].join("\n")).not.toContain("tenetkit/ai")
    expect(serverFiles).not.toContain("/packages/terminal/")
    expect([...server.external].join("\n")).not.toContain("@opentui/")
  }, 30_000)
})
