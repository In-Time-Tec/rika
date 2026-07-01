import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const artifactName = `rika-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`
const artifactPath = `dist/release/${artifactName}`

await $`bun run package`

const help = await runArtifact(["--help"])
if (help.exitCode !== 0 || !combined(help).includes("Commands:")) {
  fail("compiled CLI did not render help", help)
}

const doctor = await runArtifact(["doctor"])
if (doctor.exitCode !== 0) fail("compiled CLI doctor command failed", doctor)
const doctorReport = parseDoctorReport(doctor.stdout)
if (doctorReport.telemetry !== "enabled") {
  fail("compiled CLI doctor report did not declare telemetry enabled", doctor)
}

const doctorOff = await runArtifact(["doctor"], { RIKA_TELEMETRY: "off" })
if (parseDoctorReport(doctorOff.stdout).telemetry !== "disabled") {
  fail("compiled CLI doctor report did not honor RIKA_TELEMETRY=off", doctorOff)
}

await smokeDebugCommand()
await smokeServerHealth()

console.log(JSON.stringify({ artifact: artifactPath, checks: ["help", "doctor", "debug", "server-health"] }))

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

async function runArtifact(args: ReadonlyArray<string>, envOverride: Record<string, string> = {}): Promise<RunResult> {
  const child = Bun.spawn([artifactPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      RIKA_API_KEY: Bun.env.RIKA_API_KEY ?? "package-smoke-dummy-key",
      RIKA_DATA_DIR: `${Bun.env.PWD ?? process.cwd()}/.rika-package-smoke`,
      ...envOverride,
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

function combined(result: RunResult) {
  return `${result.stdout}\n${result.stderr}`
}

function parseDoctorReport(text: string) {
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || !("config" in value)) return {}
  const config = value.config
  if (typeof config !== "object" || config === null || !("telemetry" in config)) return {}
  return typeof config.telemetry === "string" ? { telemetry: config.telemetry } : {}
}

function fail(message: string, result: RunResult): never {
  console.error(message)
  console.error(combined(result))
  process.exit(1)
}

async function smokeServerHealth() {
  const workspace = await mkdtemp(join(tmpdir(), "rika-package-smoke-"))
  const token = "package-smoke-token"
  const port = 46_000 + Math.floor(Math.random() * 1_000)
  const child = Bun.spawn(
    [artifactPath, "server", "--host", "127.0.0.1", "--port", String(port), "--token", token, "--workspace", workspace],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...Bun.env,
        OPENAI_API_KEY: Bun.env.OPENAI_API_KEY ?? "package-smoke-dummy-key",
        RIKA_API_KEY: Bun.env.RIKA_API_KEY ?? "package-smoke-dummy-key",
        RIKA_DATA_DIR: join(workspace, ".rika"),
      },
    },
  )

  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/health`, token)
    if (health.workspace_root !== workspace || health.data_dir !== join(workspace, ".rika")) {
      fail("compiled CLI server health returned unexpected workspace metadata", {
        exitCode: 1,
        stdout: JSON.stringify(health),
        stderr: "",
      })
    }
  } finally {
    child.kill()
    await child.exited.catch(() => 0)
    await rm(workspace, { force: true, recursive: true })
  }
}

async function smokeDebugCommand() {
  const workspace = await mkdtemp(join(tmpdir(), "rika-package-debug-"))
  const fakeBun = join(workspace, "fake-bun")
  const output = join(workspace, "debug.json")
  const expectedMotelSuffix = join("dist", "share", "rika", "motel", "motel.js")
  await Bun.write(
    fakeBun,
    `#!/usr/bin/env bun
const output = process.env.RIKA_FAKE_MOTEL_OUTPUT
if (output === undefined) process.exit(2)
await Bun.write(output, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  service: process.env.MOTEL_TUI_SERVICE_NAME,
  theme: process.env.MOTEL_TUI_THEME,
}))
`,
  )
  await $`chmod +x ${fakeBun}`

  try {
    const result = await runArtifact(["--debug", "--all"], {
      RIKA_BUN_EXECUTABLE: fakeBun,
      RIKA_FAKE_MOTEL_OUTPUT: output,
    })
    if (result.exitCode !== 0) fail("compiled CLI debug command failed", result)
    const invocation = JSON.parse(await Bun.file(output).text())
    const motelScript = Array.isArray(invocation.argv) ? invocation.argv[0] : undefined
    const motelWebIndex =
      typeof motelScript === "string" ? join(dirname(dirname(motelScript)), "web", "dist", "index.html") : ""
    if (
      invocation.service !== "rika" ||
      invocation.theme !== "rika" ||
      !Array.isArray(invocation.argv) ||
      invocation.argv.length !== 2 ||
      invocation.argv[1] !== "tui" ||
      typeof motelScript !== "string" ||
      invocation.cwd !== dirname(motelScript) ||
      !motelScript.endsWith(expectedMotelSuffix) ||
      !(await Bun.file(motelScript).exists()) ||
      !(await Bun.file(motelWebIndex).exists())
    ) {
      fail("compiled CLI debug command did not launch motel with Rika filters", {
        exitCode: 1,
        stdout: JSON.stringify(invocation),
        stderr: "",
      })
    }
  } finally {
    await rm(workspace, { force: true, recursive: true })
  }
}

async function waitForHealth(url: string, token: string): Promise<Record<string, string>> {
  let lastError = ""
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      if (response.ok) return readHealth(await response.json())
      lastError = `status ${response.status}`
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause)
    }
    await Bun.sleep(100)
  }
  return fail("compiled CLI server did not become healthy", { exitCode: 1, stdout: "", stderr: lastError })
}

function readHealth(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {}
  const result: Record<string, string> = {}
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") result[key] = entryValue
  }
  return result
}
