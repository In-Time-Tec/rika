import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import { testing as imageSmoke } from "../../packages/e2b-executor/scripts/image-smoke"

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

    expect(dockerfile.split("\n")[0]).toMatch(/^FROM debian:12\.15-slim@sha256:[a-f0-9]{64}$/)
    expect(dockerfile).toContain(manifest.debianSnapshot)
    for (const item of manifest.downloads) {
      expect(item.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(dockerfile).toContain(item.version)
      expect(dockerfile).toContain(item.sha256)
    }
    const downloads = dockerfile.split("\n").filter((line) => line.includes("&& curl"))
    expect(downloads).toHaveLength(manifest.downloads.length)
    for (const download of downloads)
      expect(download).toContain("curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o")
    for (const item of manifest.aptPackages) expect(dockerfile).toContain(`${item.name}=${item.version}`)
    expect(manifest.tools.every(({ expect }) => typeof expect === "string" && expect.length > 0)).toBe(true)
    const tools = new Set(manifest.tools.map(({ name }) => name))
    expect(tools.size).toBe(manifest.tools.length)
    for (const name of [
      "bash",
      "bun",
      "node",
      "npm",
      "corepack",
      "pnpm",
      "yarn",
      "git",
      "git-lfs",
      "gh",
      "ssh",
      "rg",
      "fd",
      "find",
      "jq",
      "yq",
      "fzf",
      "tree",
      "vim",
      "tmux",
      "ps",
      "killall",
      "lsof",
      "script",
      "curl",
      "wget",
      "nc",
      "dig",
      "ip",
      "websocat",
      "tar",
      "zip",
      "unzip",
      "zstd",
      "xz",
      "make",
      "gcc",
      "g++",
      "pkg-config",
      "cmake",
      "ninja",
      "locale",
      "python",
      "sqlite",
      "postgres",
      "redis",
      "ffmpeg",
      "imagemagick",
      "chromium",
      "agent-browser",
    ])
      expect(tools).toContain(name)
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

  test("executes workspace, kernel, browser, network, and credential-broker readiness in the promoted build", async () => {
    const [doctor, kernelDoctor, smoke] = await Promise.all([
      text("doctor.ts"),
      text("kernel-doctor.ts"),
      text("packages/e2b-executor/scripts/image-smoke.ts", root),
    ])
    for (const name of [
      "workspace:ready",
      "kernel:persistence",
      "browser:headless",
      "network:outbound",
      "credentials:absent",
      "credentials:broker-ready",
    ]) {
      expect(doctor).toContain(`check("${name}"`)
      expect(smoke).toContain(`"${name}"`)
    }
    expect(doctor).toContain("unix: socketPath")
    expect(doctor).toContain('"-u",\n      "rika-workspace"')
    expect(doctor).toContain("manifestToolCount: manifest.tools.length")
    expect(doctor).toContain("manifestPackageCount: manifest.aptPackages.length")
    expect(kernelDoctor).toContain("const workspace = process.argv[2]")
    expect(smoke).toContain("Sandbox.create(`${templateId}:${buildId}`")
    expect(smoke).toContain('PATH: "/run/rika/bin:/opt/rika-python/bin:/usr/local/bin:/usr/bin:/bin"')
    expect(smoke).toContain('GH_CONFIG_DIR: "/run/rika/gh"')
    expect(smoke).toContain('sandbox.commands.run("id -un", { user: "rika-executor", envs: environment })')
    expect(smoke).toContain('user.stdout.trim() !== "rika-executor"')
    expect(smoke).toContain("env ${environmentCommand} rika executor doctor --json ||")
    expect(smoke).toContain('user: "rika-executor",\n            envs: environment')
    expect(doctor).toContain("!output.includes(tool.expect)")
    expect(doctor).toContain("output !== installed.version")
  })

  test("imports the immutable private image with short-lived registry credentials", async () => {
    const create = await text("packages/e2b-executor/scripts/create-image-template.ts", root)

    expect(create).toContain(".fromImage(image, { username, password: Redacted.value(password) })")
    expect(create).toContain("rika-executor ALL=(root) NOPASSWD: ${createRuntimeDirectory}")
    expect(create).toContain('> /etc/sudoers.d/rika-runtime && chmod 0440 /etc/sudoers.d/rika-runtime')
    expect(create).toContain('.setUser("rika-executor")')
    expect(create).toContain("`sudo -n ${createRuntimeDirectory} && exec /opt/rika/start.sh`")
    expect(create).toContain('"curl --fail --silent http://127.0.0.1:7070/health"')
    expect(create).toContain("Template.build(template, alias, {")
    expect(create).toContain("apiKey: Redacted.value(apiKey)")
    expect(create).toContain('onBuildLogs: defaultBuildLogger({ minLevel: "debug" })')
    expect(create).toContain('Config.string("GHCR_USERNAME")')
    expect(create).toContain('Config.redacted("GHCR_PASSWORD")')
    expect(create).not.toContain("console.log")
  })

  test("rejects incomplete, unusable, or mismatched doctor evidence", () => {
    const checks = [
      { name: "tool:bun", ok: true, detail: "ok" },
      { name: "package:bash", ok: true, detail: "ok" },
      { name: "workspace:ready", ok: true, detail: "ok" },
      { name: "kernel:persistence", ok: true, detail: "ok" },
      { name: "browser:headless", ok: true, detail: "ok" },
      { name: "network:outbound", ok: true, detail: "ok" },
      { name: "credentials:absent", ok: true, detail: "ok" },
      { name: "credentials:broker-ready", ok: true, detail: "ok" },
    ]
    const valid = {
      ok: true,
      image: "rika-executor-v1" as const,
      manifestSchemaVersion: 1 as const,
      buildId: "build-1",
      manifestSha256: "a".repeat(64),
      manifestToolCount: 1,
      manifestPackageCount: 1,
      checks,
    }
    const manifest = { tools: [{ name: "bun" }], aptPackages: [{ name: "bash" }] }
    const accepts = (result: typeof valid) =>
      imageSmoke.acceptsDoctorResult(result, valid.buildId, valid.manifestSha256, manifest)

    expect(accepts(valid)).toBe(true)
    expect(accepts({ ...valid, ok: false })).toBe(false)
    expect(accepts({ ...valid, buildId: "mutable-default" })).toBe(false)
    expect(accepts({ ...valid, manifestSha256: "b".repeat(64) })).toBe(false)
    expect(accepts({ ...valid, manifestToolCount: 2 })).toBe(false)
    expect(accepts({ ...valid, manifestPackageCount: 2 })).toBe(false)
    expect(accepts({ ...valid, checks: checks.slice(0, -1) })).toBe(false)
    expect(imageSmoke.acceptsDoctorResult(valid, valid.buildId, valid.manifestSha256, { ...manifest, tools: [] })).toBe(
      false,
    )
    expect(
      imageSmoke.acceptsDoctorResult(valid, valid.buildId, valid.manifestSha256, {
        ...manifest,
        tools: [{ name: "missing" }],
      }),
    ).toBe(false)
    expect(
      accepts({ ...valid, checks: checks.map((check, index) => (index === 0 ? { ...check, ok: false } : check)) }),
    ).toBe(false)
    expect(accepts({ ...valid, checks: [...checks, checks[0]!] })).toBe(false)
  })
})
