import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Layer, Schema } from "effect"
import * as Capability from "@rika/extensions/mcp-capability"
import * as Runtime from "@rika/extensions/mcp-runtime"
import { provideLayer } from "../support/extension-test-layer"

const fixture = new URL("./fixture.ts", import.meta.url).pathname
const layer = Runtime.layer.pipe(Layer.provideMerge(BunServices.layer))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

it.live(
  "discovers and calls an explicitly authorized tool on the real local MCP transport; denies drift and disconnect",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-mcp-" })
      const configPath = `${root}/mcp.json`
      const config = {
        servers: {
          fixture: {
            command: process.execPath,
            args: [fixture],
            cwd: root,
            env: { FIXTURE_SECRET: "fixture-private-credential" },
            specialists: { Librarian: ["echo"] },
          },
        },
      }
      const writeMode = (mode: string) => fs.writeFileString(`${root}/state.json`, encodeJson({ mode }))
      yield* writeMode("healthy")
      yield* fs.writeFileString(configPath, encodeJson(config))
      const catalog = yield* Capability.capture(configPath)
      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.specialist).toBe("Librarian")
      expect(encodeJson(catalog)).not.toContain(config.servers.fixture.env.FIXTURE_SECRET)
      expect(encodeJson(catalog)).not.toContain("FIXTURE_SECRET")
      const pinned = catalog[0]!
      expect(yield* Capability.call(configPath, pinned, { value: "ok" })).toBe("fixture:ok")
      expect((yield* Effect.flip(Capability.call(configPath, pinned, { value: 1 }))).reason).toBe("invalid-input")
      for (const mode of ["changed", "missing", "discovery-failure", "disconnect", "error"] as const) {
        yield* writeMode(mode)
        const error = yield* Effect.flip(Capability.call(configPath, pinned, { value: "no" }))
        expect(error.reason).toBe(
          {
            changed: "changed",
            missing: "changed",
            "discovery-failure": "unavailable",
            disconnect: "unknown",
            error: "unknown",
          }[mode],
        )
        expect(encodeJson(error)).not.toContain(config.servers.fixture.env.FIXTURE_SECRET)
      }
      yield* writeMode("leak")
      expect((yield* Effect.flip(Capability.capture(configPath))).reason).toBe("changed")
      yield* writeMode("leak-result")
      expect((yield* Effect.flip(Capability.call(configPath, pinned, { value: "no" }))).reason).toBe("unknown")
      yield* writeMode("discovery-failure")
      expect((yield* Effect.flip(Capability.capture(configPath))).reason).toBe("unavailable")
      yield* writeMode("hang")
      const hanging = yield* Capability.call(configPath, pinned, { value: "hang" }).pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while ((yield* fs.readFileString(`${root}/events`)).split("\n").filter((event) => event === "call").length < 5)
          yield* Effect.sleep("10 millis")
      }).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(hanging)
      yield* writeMode("healthy")
      yield* fs.writeFileString(configPath, encodeJson({ ...config, disabled: ["fixture"] }))
      expect((yield* Effect.flip(Capability.call(configPath, pinned, {}))).reason).toBe("denied")
      expect(yield* Capability.capture(configPath)).toEqual([])
      yield* fs.writeFileString(
        configPath,
        encodeJson({ servers: { fixture: { ...config.servers.fixture, specialists: {} } } }),
      )
      expect((yield* Effect.flip(Capability.call(configPath, pinned, {}))).reason).toBe("denied")
      expect(yield* Capability.capture(configPath)).toEqual([])
      yield* fs.writeFileString(
        configPath,
        encodeJson({ servers: { fixture: { ...config.servers.fixture, command: `${root}/missing` } } }),
      )
      expect((yield* Effect.flip(Capability.capture(configPath))).reason).toBe("unavailable")
      // The first server succeeds, but a later failure must reject the entire catalog and close the first connection.
      yield* fs.writeFileString(
        configPath,
        encodeJson({
          servers: {
            fixture: config.servers.fixture,
            broken: { ...config.servers.fixture, command: `${root}/missing` },
          },
        }),
      )
      expect((yield* Effect.flip(Capability.capture(configPath))).reason).toBe("unavailable")
      const escaped = { ...config.servers.fixture, env: { FIXTURE_SECRET: 'test-credential-"quoted"\nline' } }
      yield* fs.writeFileString(configPath, encodeJson({ servers: { fixture: escaped } }))
      yield* writeMode("leak")
      expect((yield* Effect.flip(Capability.capture(configPath))).reason).toBe("changed")
      const events = yield* fs.readFileString(`${root}/events`)
      expect(events.split("\n").filter((event) => event === "call")).toHaveLength(5)
      for (const line of events.split("\n").filter((event) => event.startsWith("start:"))) {
        const pid = Number(line.slice(6))
        expect(() => process.kill(pid, 0)).toThrow()
      }
    }).pipe((effect) => provideLayer(effect, layer)),
  { timeout: 20_000 },
)
