import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const root = new URL("../..", import.meta.url)
const imageRoot = new URL("../../infra/e2b/executor-v1/", import.meta.url)
const containerReady = async (command: string[]) =>
  (await Bun.spawn([...command, "version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0
const containerCommand = Bun.which("docker")
  ? (await containerReady(["docker"]))
    ? ["docker"]
    : undefined
  : Bun.which("podman")
    ? (await containerReady(["sudo", "-n", "podman"]))
      ? ["sudo", "podman", "--cgroup-manager=cgroupfs"]
      : (await containerReady(["podman"]))
        ? ["podman"]
        : undefined
    : undefined
const run = async (parts: string[]) => {
  const process = Bun.spawn(parts, { cwd: root.pathname, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exit !== 0) throw new Error(`${parts.join(" ")} exited ${exit}\n${stdout}\n${stderr}`)
  return stdout.trim()
}

describe.skipIf(containerCommand === undefined)("E2B executor image", () => {
  it("builds the pinned image and executes its complete doctor contract", async () => {
    const tag = `rika-executor-contract:${process.pid}`
    try {
      await run([
        ...containerCommand!,
        "build",
        "--pull",
        "--file",
        "infra/e2b/executor-v1/e2b.Dockerfile",
        "--tag",
        tag,
        ".",
      ])
      const output = await run([
        ...containerCommand!,
        "run",
        "--rm",
        "--entrypoint",
        "rika",
        "--env",
        "RIKA_DOCTOR_NETWORK_URL=https://example.com/",
        tag,
        "executor",
        "doctor",
        "--json",
      ])
      const result = JSON.parse(output) as {
        ok: boolean
        image: string
        buildId: string
        manifestSha256: string
        manifestToolCount: number
        manifestPackageCount: number
        checks: Array<{ name: string; ok: boolean }>
      }
      const manifestBytes = await readFile(new URL("tool-manifest.json", imageRoot))
      const manifest = JSON.parse(manifestBytes.toString()) as {
        tools: ReadonlyArray<unknown>
        aptPackages: ReadonlyArray<unknown>
      }
      expect(result.ok).toBe(true)
      expect(result.image).toBe("rika-executor-v1")
      expect(result.buildId).toBe("template-readiness")
      expect(result.manifestSha256).toBe(createHash("sha256").update(manifestBytes).digest("hex"))
      expect(result.manifestToolCount).toBe(manifest.tools.length)
      expect(result.manifestPackageCount).toBe(manifest.aptPackages.length)
      expect(result.checks.length).toBeGreaterThan(30)
      expect(result.checks.every(({ ok }) => ok)).toBe(true)
      const names = new Set(result.checks.map(({ name }) => name))
      expect(names.size).toBe(result.checks.length)
      for (const name of [
        "workspace:ready",
        "kernel:persistence",
        "browser:headless",
        "network:outbound",
        "credentials:absent",
        "credentials:broker-ready",
      ])
        expect(names).toContain(name)

      const container = await run([...containerCommand!, "run", "--detach", "--rm", tag])
      try {
        let ready = false
        for (let attempt = 0; attempt < 40 && !ready; attempt++) {
          ready =
            (await run([
              ...containerCommand!,
              "exec",
              container,
              "curl",
              "--fail",
              "--silent",
              "http://127.0.0.1:7070/health",
            ]).catch(() => "")) === "ready"
          if (!ready) await Bun.sleep(250)
        }
        expect(ready).toBe(true)
        expect(await run([...containerCommand!, "inspect", "--format", "{{.Config.User}}", container])).toBe(
          "rika-executor",
        )
      } finally {
        await run([...containerCommand!, "rm", "--force", container]).catch(() => undefined)
      }
    } finally {
      await run([...containerCommand!, "image", "rm", "--force", tag]).catch(() => undefined)
    }
  }, 900_000)
})
