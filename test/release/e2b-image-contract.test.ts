import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"

const root = new URL("../..", import.meta.url)
const image = new URL("../../infra/e2b/executor-v1/", import.meta.url)
const text = (path: string, base = image) => readFile(new URL(path, base), "utf8")

describe("E2B image source contract", () => {
  test("uses the repository root frozen workspace and ships executor kernel assets", async () => {
    const dockerfile = await text("e2b.Dockerfile")
    const lock = await text("bun.lock", root)

    expect(dockerfile).toContain("COPY package.json bun.lock ./")
    expect(dockerfile).toContain("COPY packages ./packages")
    expect(dockerfile).toContain("COPY apps ./apps")
    expect(dockerfile).toContain("bun install --production --frozen-lockfile --ignore-scripts")
    expect(dockerfile).toContain("node_modules/tenetkit/package.json")
    expect(dockerfile).toContain("packages/kernel/src/executor-runtime.ts")
    expect(dockerfile).toContain('import { workerModule } from "tenetkit/repl/bun"')
    expect(await text("start.sh")).toContain("packages/remote-execution/src/host.ts")
    expect(lock).toContain('"tenetkit": "0.33.0"')
  })

  test("pins the base, snapshot, downloads, packages, and complete executable manifest", async () => {
    const dockerfile = await text("e2b.Dockerfile")
    const manifest = JSON.parse(await text("tool-manifest.json")) as {
      debianSnapshot: string
      downloads: Array<{ name: string; version: string; sha256: string }>
      aptPackages: Array<{ name: string; version: string }>
      tools: Array<{ name: string; expect?: string }>
    }

    expect(dockerfile.split("\n")[0]).toMatch(/^FROM debian:12\.11-slim@sha256:[a-f0-9]{64}$/)
    expect(dockerfile).toContain(manifest.debianSnapshot)
    for (const item of manifest.downloads) {
      expect(item.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(dockerfile).toContain(item.version)
      expect(dockerfile).toContain(item.sha256)
    }
    for (const item of manifest.aptPackages) expect(dockerfile).toContain(`${item.name}=${item.version}`)
    expect(manifest.tools.every(({ expect }) => typeof expect === "string" && expect.length > 0)).toBe(true)
  })

  test("separates users and excludes credential-bearing build context", async () => {
    const [dockerfile, ignore] = await Promise.all([text("e2b.Dockerfile"), text(".dockerignore", root)])
    for (const entry of [
      ".git",
      ".amp",
      ".agents",
      ".env",
      ".env.*",
      "**/.git-credentials",
      "**/.netrc",
      "**/.npmrc",
      "**/.pypirc",
      "**/.ssh",
      "**/*.key",
      "**/*.pem",
      ".rika",
      "node_modules",
    ])
      expect(ignore.split("\n")).toContain(entry)
    expect(dockerfile).toContain("USER rika-executor")
    expect(dockerfile).toContain("sudo -n -u rika-workspace")
    expect(dockerfile).not.toMatch(/ARG .*?(TOKEN|SECRET|PASSWORD|PRIVATE_KEY)/)
    expect(dockerfile).not.toMatch(/COPY .*?(\.env|\.git|\.ssh|credential)/i)
  })
})
