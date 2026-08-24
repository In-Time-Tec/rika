import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { testing as imageSmoke } from "../../packages/e2b-executor/scripts/image-smoke"

const root = new URL("../..", import.meta.url)
const image = new URL("../../infra/e2b/executor-v1/", import.meta.url)
const text = Effect.fn(function* (path: string, base = image) {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.readFileString(new URL(path, base).pathname)
})
const RootManifest = Schema.Struct({
  workspaces: Schema.Struct({ catalog: Schema.Struct({ tenetkit: Schema.String }) }),
})
const ToolManifest = Schema.Struct({
  debianSnapshot: Schema.String,
  downloads: Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.String, sha256: Schema.String })),
  aptPackages: Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.String })),
  tools: Schema.Array(Schema.Struct({ name: Schema.String, expect: Schema.optional(Schema.String) })),
})

it.layer(BunServices.layer)("E2B image source contract", (test) => {
  test.effect("uses the repository root frozen workspace and ships executor kernel assets", () =>
    Effect.gen(function* () {
      const dockerfile = yield* text("e2b.Dockerfile")
      const lock = yield* text("bun.lock", root)
      const manifest = yield* text("package.json", root).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RootManifest))),
      )

      expect(dockerfile).toContain("COPY package.json bun.lock ./")
      expect(dockerfile).toContain("COPY packages ./packages")
      expect(dockerfile).toContain("COPY apps ./apps")
      expect(dockerfile).toContain("bun install --production --frozen-lockfile --ignore-scripts")
      expect(dockerfile).toContain("node_modules/tenetkit/package.json")
      expect(dockerfile).toContain("packages/kernel/src/executor-runtime.ts")
      expect(dockerfile).toContain('import { workerModule } from "tenetkit/repl/bun"')
      expect(yield* text("start.sh")).toContain("packages/remote-execution/src/host/service.ts")
      expect(lock).toContain(`"tenetkit": "${manifest.workspaces.catalog.tenetkit}"`)
    }),
  )

  test.effect("pins the base, snapshot, downloads, packages, and complete executable manifest", () =>
    Effect.gen(function* () {
      const dockerfile = yield* text("e2b.Dockerfile")
      const manifest = yield* text("tool-manifest.json").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ToolManifest))),
      )

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
      expect(
        manifest.tools.every(
          ({ expect: expectedOutput }) => typeof expectedOutput === "string" && expectedOutput.length > 0,
        ),
      ).toBe(true)
      expect(dockerfile).toContain("ARG NPM_TAR_VERSION=7.5.21")
      expect(dockerfile).toContain("/usr/local/lib/node_modules/npm/node_modules/tar")
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
    }),
  )

  test.effect("separates users and excludes credential-bearing build context", () =>
    Effect.gen(function* () {
      const [dockerfile, ignore] = yield* Effect.all([text("e2b.Dockerfile"), text(".dockerignore", root)], {
        concurrency: "unbounded",
      })
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
    }),
  )

  test.effect(
    "executes workspace, kernel, browser, network, and credential-broker readiness in the promoted build",
    () =>
      Effect.gen(function* () {
        const [doctor, kernelDoctor, smoke] = yield* Effect.all(
          [text("doctor.ts"), text("kernel-doctor.ts"), text("packages/e2b-executor/scripts/image-smoke.ts", root)],
          { concurrency: "unbounded" },
        )
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
      }),
  )

  test.effect("imports the immutable private image with short-lived registry credentials", () =>
    Effect.gen(function* () {
      const create = yield* text("packages/e2b-executor/scripts/create-image-template.ts", root)

      expect(create).toContain(".fromImage(image, { username, password: Redacted.value(password) })")
      expect(create).toContain("rika-executor ALL=(root) NOPASSWD: ${createRuntimeDirectory}")
      expect(create).toContain("> /etc/sudoers.d/rika-runtime && chmod 0440 /etc/sudoers.d/rika-runtime")
      expect(create).toContain('.setUser("rika-executor")')
      expect(create).toContain("`sudo -n ${createRuntimeDirectory} && exec /opt/rika/start.sh`")
      expect(create).toContain('"curl --fail --silent http://127.0.0.1:7070/health"')
      expect(create).toContain("Template.build(template, alias, {")
      expect(create).toContain("apiKey: Redacted.value(apiKey)")
      expect(create).toContain('onBuildLogs: defaultBuildLogger({ minLevel: "debug" })')
      expect(create).toContain('Config.string("GHCR_USERNAME")')
      expect(create).toContain('Config.redacted("GHCR_PASSWORD")')
      expect(create).not.toContain("console.log")
    }),
  )

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
