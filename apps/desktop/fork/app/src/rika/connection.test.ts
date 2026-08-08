// M3 Phase A verification: the fork's Rika transport against a REAL Rika Server.
// Spawns the built Rika Server (apps/server/dist/server-main.js — build it with
// `bun run build` in apps/server if missing), waits for server.json + fd-3
// ready, then connects with clientKind "desktop" and pings.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Scope } from "effect"
import { readRikaEndpoint, rikaIdentity } from "./endpoint"
import { connectRika } from "./connection"

const serverMain = new URL("../../../../../../apps/server/dist/server-main.js", import.meta.url).pathname
let dataRoot: string
let home: string
let server: import("bun").Subprocess
let endpoint: ReturnType<typeof readRikaEndpoint>

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "rika-desktop-fork-"))
  home = mkdtempSync(join(tmpdir(), "rika-desktop-home-"))
  server = Bun.spawn(["bun", serverMain], {
    cwd: new URL("../../../../../..", import.meta.url).pathname,
    env: {
      ...process.env,
      HOME: home,
      RIKA_INTERNAL_SERVER_DATA_ROOT: dataRoot,
      RIKA_INTERNAL_SERVER_PROFILE: "default",
      RIKA_INTERNAL_SERVER_STARTUP_FD: "3",
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  })
  // wait for server.json (90s)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      readFileSync(join(dataRoot, "server.json"), "utf8")
      break
    } catch {
      await Bun.sleep(250)
    }
  }
  const serverJson = join(dataRoot, "server.json")
  const { existsSync } = await import("node:fs")
  if (!existsSync(serverJson)) throw new Error("server.json never appeared")
  endpoint = readRikaEndpoint(dataRoot)
}, 120_000)

afterAll(() => {
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
  if (home) rmSync(home, { recursive: true, force: true })
}, 30_000)

describe("rika desktop transport (Phase A)", () => {
  it("resolves the endpoint from server.json", () => {
    expect(endpoint.port).toBeGreaterThan(20_000)
    expect(endpoint.url).toContain("ws://127.0.0.1:")
    expect(endpoint.token.length).toBeGreaterThan(0)
    expect(endpoint.protocolVersion).toBe(8)
  })

  it("connects with clientKind desktop and pings", async () => {
    const identity = rikaIdentity("default", endpoint.dataRoot)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const { connection } = yield* connectRika(endpoint, identity).pipe(
          Effect.provideService(Scope.Scope, scope),
        )
        yield* connection.ping.pipe(Effect.timeout("10 seconds"))
        return "pong"
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.catch((error) => Effect.succeed(`FAILED: ${String(error)}`)),
      ),
    )
    expect(result).toBe("pong")
  }, 30_000)
})
