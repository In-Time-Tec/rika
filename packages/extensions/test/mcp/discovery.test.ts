import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Crypto, Effect, FileSystem, Schema } from "effect"
import * as McpDiscovery from "@rika/extensions/mcp-discovery"
import { provideLayer } from "../support/extension-test-layer"

const withConfig = <A, E>(build: (configPath: string) => Effect.Effect<A, E, FileSystem.FileSystem | Crypto.Crypto>) =>
  Effect.runPromise(
    Effect.scoped(
      provideLayer(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-mcp-discovery-" })
          return yield* build(`${root}/mcp.json`)
        }),
        BunServices.layer,
      ),
    ),
  )

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const write = (configPath: string, value: Schema.Json) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.writeFileString(configPath, encode(value)))

it("returns an empty set when the Workspace has no MCP configuration", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      const discovered = yield* McpDiscovery.discover({ configPath })
      expect(discovered.servers).toEqual([])
      expect(discovered.digest).toHaveLength(64)
    }),
  ))

it("discovers local and remote Workspace servers in canonical order", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      yield* write(configPath, {
        servers: {
          search: { url: "https://example.test/mcp" },
          files: { command: "server", args: ["--stdio"] },
        },
      })
      const discovered = yield* McpDiscovery.discover({ configPath })
      expect(discovered.servers.map((entry) => entry.server.name)).toEqual(["files", "search"])
      expect(discovered.servers.map((entry) => entry.server.kind)).toEqual(["local", "remote"])
      expect(discovered.servers.every((entry) => entry.enabled)).toBe(true)
    }),
  ))

it("accepts a bare servers document without the wrapper", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      yield* write(configPath, { files: { command: "server" } })
      const discovered = yield* McpDiscovery.discover({ configPath })
      expect(discovered.servers.map((entry) => entry.server.name)).toEqual(["files"])
    }),
  ))

it("marks a disabled server unreachable while still listing it", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      yield* write(configPath, {
        servers: { files: { command: "server" }, legacy: { command: "old" } },
        disabled: ["legacy"],
      })
      const discovered = yield* McpDiscovery.discover({ configPath })
      expect(discovered.servers.map((entry) => [entry.server.name, entry.enabled])).toEqual([
        ["files", true],
        ["legacy", false],
      ])
    }),
  ))

it("honours a disabled server in a configuration that names no servers key", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      // A configuration may be the bare server map, and a server disabled there stayed reachable
      // because the list was only read from the wrapped form.
      yield* write(configPath, { files: { command: "server" }, legacy: { command: "old" } })
      const both = yield* McpDiscovery.discover({ configPath })
      expect(both.servers.map((entry) => entry.enabled)).toEqual([true, true])
      yield* write(configPath, { files: { command: "server" }, legacy: { command: "old" }, disabled: ["legacy"] })
      const discovered = yield* McpDiscovery.discover({ configPath })
      expect(discovered.servers.map((entry) => [entry.server.name, entry.enabled])).toEqual([
        ["files", true],
        ["legacy", false],
      ])
    }),
  ))

it("fails typed when a disabled name matches no configured server", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      yield* write(configPath, { servers: { files: { command: "server" } }, disabled: ["ghost"] })
      const error = yield* Effect.flip(McpDiscovery.discover({ configPath }))
      expect(error.message).toBe("Disabled MCP server not found: ghost")
    }),
  ))

it("fails typed when disabled is not an array of strings", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      yield* write(configPath, { servers: { files: { command: "server" } }, disabled: "legacy" })
      const error = yield* Effect.flip(McpDiscovery.discover({ configPath }))
      expect(error.message).toBe("Invalid disabled: expected an array of strings")
    }),
  ))

it("fails typed when the configuration is not JSON", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.writeFileString(configPath, "{")
      const error = yield* Effect.flip(McpDiscovery.discover({ configPath }))
      expect(error.source).toBe(configPath)
    }),
  ))

it("fails typed when a server declares both a command and a url", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      yield* write(configPath, { servers: { broken: { command: "server", url: "https://example.test" } } })
      const error = yield* Effect.flip(McpDiscovery.discover({ configPath }))
      expect(error.message).toContain("exactly one of command or url")
    }),
  ))

it("composes servers contributed by an activated skill", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      yield* write(configPath, { servers: { files: { command: "server" } } })
      const discovered = yield* McpDiscovery.discover({
        configPath,
        activatedSkills: [
          {
            name: "research",
            digest: "skill-digest",
            resources: [{ path: "mcp.json", content: encode({ crawler: { command: "crawl" } }) }],
          },
        ],
      })
      expect(discovered.servers.map((entry) => entry.server.name)).toEqual(["crawler", "files"])
      expect(discovered.servers[0]?.server.source).toBe("skill:research")
    }),
  ))

it("ignores skill resources that are not mcp.json", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      const discovered = yield* McpDiscovery.discover({
        configPath,
        activatedSkills: [
          { name: "research", digest: "d", resources: [{ path: "notes.md", content: "not configuration" }] },
        ],
      })
      expect(discovered.servers).toEqual([])
    }),
  ))

it("changes the digest when the server set or its enablement changes", () =>
  withConfig((configPath) =>
    Effect.gen(function* () {
      yield* write(configPath, { servers: { files: { command: "server" }, legacy: { command: "old" } } })
      const first = yield* McpDiscovery.discover({ configPath })
      yield* write(configPath, {
        servers: { files: { command: "server" }, legacy: { command: "old" } },
        disabled: ["legacy"],
      })
      const disabled = yield* McpDiscovery.discover({ configPath })
      yield* write(configPath, { servers: { files: { command: "server" } } })
      const removed = yield* McpDiscovery.discover({ configPath })
      expect(disabled.digest).not.toBe(first.digest)
      expect(removed.digest).not.toBe(first.digest)
      expect(removed.digest).not.toBe(disabled.digest)
    }),
  ))
