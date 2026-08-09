import { createHash } from "node:crypto"
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const port = process.argv[2] ?? "3000"
const app = resolve(import.meta.dir, "..")
const server = resolve(app, "../../../server")
const dataRoot = await mkdtemp(join(tmpdir(), "rika-playwright-"))
await chmod(dataRoot, 0o700)

const build = Bun.spawn(["bun", "run", "build"], { cwd: server, stdout: "inherit", stderr: "inherit" })
if ((await build.exited) !== 0) throw new Error("Could not build the native Rika test server")

const serverProcess = Bun.spawn(["bun", "./dist/server-main.js"], {
  cwd: server,
  env: {
    ...process.env,
    RIKA_INTERNAL_SERVER_DATA_ROOT: dataRoot,
    RIKA_INTERNAL_SERVER_PROFILE: "playwright",
    RIKA_CLIENT: "desktop",
    HOME: dataRoot,
    RIKA_TEST_MODEL_RESPONSE: "RIKA_OK",
    OPENROUTER_API_KEY: "playwright-test-credential",
  },
  stdout: "inherit",
  stderr: "inherit",
})

const deadline = Date.now() + 15_000
let endpoint: { port: number } | undefined
while (Date.now() < deadline) {
  try {
    endpoint = JSON.parse(await readFile(join(dataRoot, "server.json"), "utf8"))
    break
  } catch {
    if ((await Promise.race([serverProcess.exited.then(() => true), Bun.sleep(25).then(() => false)]))) {
      throw new Error("Native Rika test server exited before publishing its endpoint")
    }
  }
}
if (!endpoint) throw new Error("Native Rika test server did not publish its endpoint")
const token = (await readFile(join(dataRoot, "server.token"), "utf8")).trim()
const identity = createHash("sha256")
  .update(`playwright\0${await realpath(dataRoot)}`)
  .digest("hex")
const vite = Bun.spawn(["bun", "run", "dev", "--", "--host", "0.0.0.0", "--port", port], {
  cwd: app,
  env: {
    ...process.env,
    VITE_RIKA_SERVER_URL: `ws://127.0.0.1:${endpoint.port}/server`,
    VITE_RIKA_SERVER_TOKEN: token,
    VITE_RIKA_SERVER_IDENTITY: identity,
  },
  stdout: "inherit",
  stderr: "inherit",
})

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  vite.kill("SIGTERM")
  serverProcess.kill("SIGTERM")
  await Promise.allSettled([vite.exited, serverProcess.exited])
  await rm(dataRoot, { recursive: true, force: true })
}
process.once("SIGINT", () => void stop())
process.once("SIGTERM", () => void stop())
process.once("exit", () => {
  vite.kill("SIGKILL")
  serverProcess.kill("SIGKILL")
})
const exit = await vite.exited
await stop()
process.exit(exit)
