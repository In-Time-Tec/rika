import { createHash, randomUUID } from "node:crypto"
import { chmod, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

const manifestPath = process.env.RIKA_IMAGE_MANIFEST ?? "/opt/rika/tool-manifest.json"
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
const workspace = process.env.RIKA_EXECUTOR_WORKSPACE ?? "/home/rika-workspace/workspace/repo"
const workspaceParent = dirname(workspace)
const temp = join(workspaceParent, `.rika-doctor-${randomUUID()}`)
const executorHome = process.env.HOME ?? "/home/rika-executor"
const checks: Array<{ name: string; ok: boolean; detail: string }> = []
const check = async (name: string, run: () => Promise<string>) => {
  try {
    checks.push({ name, ok: true, detail: await run() })
  } catch (error) {
    checks.push({ name, ok: false, detail: String(error) })
  }
}
const command = async (parts: string[]) => {
  const proc = Bun.spawn(parts, { cwd: executorHome, stdout: "pipe", stderr: "pipe", env: process.env })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit !== 0) throw new Error(`${parts[0]} exited ${exit}: ${stderr.trim()}`)
  return `${stdout}${stderr}`.trim().split("\n")[0] ?? ""
}

for (const tool of manifest.tools)
  await check(`tool:${tool.name}`, async () => {
    const output = await command([tool.command, ...tool.args])
    if (tool.expect && !output.includes(tool.expect)) throw new Error(`expected ${tool.expect}, got ${output}`)
    return output
  })

for (const installed of manifest.aptPackages)
  await check(`package:${installed.name}`, async () => {
    const output = await command(["dpkg-query", "--showformat=${Version}", "--show", installed.name])
    if (output !== installed.version) throw new Error(`expected ${installed.version}, got ${output}`)
    return output
  })

await check("workspace:ready", async () => {
  const output = await command([
    "sudo",
    "-n",
    "-u",
    "rika-workspace",
    "env",
    `PATH=${process.env.PATH ?? ""}`,
    `GH_CONFIG_DIR=${process.env.GH_CONFIG_DIR ?? ""}`,
    "sh",
    "-ceu",
    '[ "$(id -un)" = rika-workspace ]\n[ "$HOME" = /home/rika-workspace ]\ncase "$PATH" in /run/rika/bin:*) ;; *) exit 1 ;; esac\n[ "$GH_CONFIG_DIR" = /run/rika/gh ]\n[ -r "$1" ] && [ -w "$1" ] && [ -x "$1" ]\ninstall -d -m 0770 "$2"\ntouch "$2/write"\nprintf workspace-ready',
    "sh",
    workspaceParent,
    temp,
  ])
  if (output !== "workspace-ready") throw new Error(`unexpected workspace probe: ${output}`)
  return output
})
await check("kernel:persistence", async () =>
  command(["bun", "run", "/opt/rika/kernel-doctor.ts", temp, join(temp, "kernel")]),
)
await check("typescript:execute", async () => command(["bun", "-e", "const value: number = 42; console.log(value)"]))
await check("python:pillow", async () =>
  command(["python", "-c", "from PIL import Image; print(Image.new('RGB',(1,1)).size)"]),
)
await check("media:transcode", async () =>
  command(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=size=2x2", "-frames:v", "1", "-f", "null", "-"]),
)
await check("browser:headless", async () =>
  command([
    "chromium",
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--dump-dom",
    "data:text/html,<title>rika</title>",
  ]),
)
await check("network:outbound", async () =>
  command([
    "curl",
    "--fail",
    "--silent",
    "--show-error",
    "--max-time",
    "10",
    process.env.RIKA_DOCTOR_NETWORK_URL ?? "https://example.com/",
  ]),
)
await check("credentials:absent", async () => {
  const forbidden = Object.keys(process.env).filter(
    (key) => /(^|_)(TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/.test(key) && !key.startsWith("RIKA_DOCTOR_"),
  )
  if (forbidden.length) throw new Error(`credential-like environment keys: ${forbidden.join(",")}`)
  for (const path of [join(process.env.HOME ?? "", ".git-credentials"), join(process.env.HOME ?? "", ".netrc")]) {
    if (await Bun.file(path).exists()) throw new Error(`credential file exists: ${path}`)
  }
  return "no credential environment keys or files"
})
await check("credentials:broker-ready", async () => {
  const socketPath = join("/run/rika", `.rika-doctor-${randomUUID()}.sock`)
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, data) {
        socket.end(new TextDecoder().decode(data).trim() === "readiness" ? "broker-ready" : "")
      },
    },
  })
  try {
    await chmod(socketPath, 0o660)
    const output = await command([
      "sudo",
      "-n",
      "-u",
      "rika-workspace",
      "bun",
      "-e",
      'let response = ""\nawait new Promise((resolve, reject) => {\n  const timeout = setTimeout(() => reject(new Error("credential broker timed out")), 5000)\n  void Bun.connect({\n    unix: process.argv[1],\n    socket: {\n      open(socket) { socket.write("readiness") },\n      data(_socket, data) { response += new TextDecoder().decode(data) },\n      close() { clearTimeout(timeout); resolve() },\n      error() { clearTimeout(timeout); reject(new Error("credential broker connection failed")) },\n    },\n  }).catch(reject)\n})\nif (response !== "broker-ready") process.exit(1)\nconsole.log(response)',
      socketPath,
    ])
    if (output !== "broker-ready") throw new Error(`unexpected credential broker probe: ${output}`)
    return output
  } finally {
    listener.stop(true)
    await rm(socketPath, { force: true })
  }
})
await check("source:git-roundtrip", async () => {
  await command(["sudo", "-n", "-u", "rika-workspace", "git", "-C", temp, "init", "--quiet"])
  await command(["sudo", "-n", "-u", "rika-workspace", "sh", "-c", `printf rika > '${join(temp, "tracked")}'`])
  await command(["sudo", "-n", "-u", "rika-workspace", "git", "-C", temp, "add", "tracked"])
  return "repository initialized and indexed"
})
await check("data:sqlite-roundtrip", async () =>
  command([
    "sudo",
    "-n",
    "-u",
    "rika-workspace",
    "sqlite3",
    join(temp, "doctor.db"),
    "create table probe(value text); insert into probe values('rika'); select value from probe;",
  ]),
)
await check("coding:search", async () =>
  command(["sudo", "-n", "-u", "rika-workspace", "rg", "rika", join(temp, "tracked")]),
)
await check("process:workspace-user", async () => command(["sudo", "-n", "-u", "rika-workspace", "id", "-un"]))
await check("workspace:cleanup", async () => {
  await rm(join(temp, "kernel"), { recursive: true, force: true })
  await command(["sudo", "-n", "-u", "rika-workspace", "rm", "-rf", temp])
  return "workspace probe removed"
})

const digest = createHash("sha256")
  .update(await readFile(manifestPath))
  .digest("hex")
const result = {
  ok: checks.every((item) => item.ok),
  image: manifest.image,
  manifestSchemaVersion: manifest.schemaVersion,
  manifestSha256: digest,
  manifestToolCount: manifest.tools.length,
  manifestPackageCount: manifest.aptPackages.length,
  buildId: process.env.RIKA_EXECUTOR_TEMPLATE_BUILD_ID ?? null,
  checks,
}
console.log(JSON.stringify(result))
if (!result.ok) process.exitCode = 1
