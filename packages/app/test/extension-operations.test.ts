import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { TestConsole } from "effect/testing"
import { McpOAuth, SkillRegistry } from "@rika/extensions"
import { ExtensionOperations } from "../src"
import { provideLayer } from "./layer"

const decodeJson = Schema.decodeSync(Schema.UnknownFromJsonString)

describe("ExtensionOperations", () => {
  const oauthLayer = McpOAuth.testLayer({
    login: () => Effect.void,
    logout: () => Effect.void,
    status: () => Effect.succeed("unauthenticated"),
  })
  it.effect("runs skill, MCP, and extension lifecycle operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-app-extensions-" })
        const options = {
          globalRoot: `${root}/global`,
          workspaceRoot: `${root}/skills`,
          configPath: `${root}/config/mcp.json`,
          trustPath: `${root}/trust.json`,
          generationsPath: `${root}/generations.json`,
        }
        yield* fs.makeDirectory(`${options.globalRoot}/global-skill`, { recursive: true })
        yield* fs.makeDirectory(`${root}/source/local-skill`, { recursive: true })
        yield* fs.writeFileString(
          `${options.globalRoot}/global-skill/SKILL.md`,
          "---\nname: global-skill\ndescription: Global\n---\nbody",
        )
        yield* fs.writeFileString(
          `${root}/source/local-skill/SKILL.md`,
          "---\nname: local-skill\ndescription: Local\n---\nlocal",
        )
        const program = Effect.gen(function* () {
          yield* ExtensionOperations.run({ _tag: "Skill", action: "list" })
          yield* ExtensionOperations.run({ _tag: "Skill", action: "inspect", name: "global-skill" })
          yield* ExtensionOperations.run({ _tag: "Skill", action: "add", source: `${root}/source/local-skill` })
          yield* ExtensionOperations.run({ _tag: "Skill", action: "remove", name: "local-skill" })
          yield* ExtensionOperations.run({
            _tag: "Mcp",
            action: "add",
            name: "remote",
            url: "https://example.test/mcp",
          })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "add", name: "local", command: ["runner", "--mcp"] })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "disable", name: "remote" })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "oauth-login", name: "remote" })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "oauth-status", name: "remote" })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "oauth-status" })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "oauth-logout", name: "remote" })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "list" })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "doctor" })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "enable", name: "remote" })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "approve", name: "remote" })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "approve", name: "remote", workspace: "/other" })
          yield* ExtensionOperations.run({ _tag: "Mcp", action: "remove", name: "local" })
          yield* ExtensionOperations.run({ _tag: "Extension", action: "enable", name: "plug" })
          yield* ExtensionOperations.run({ _tag: "Extension", action: "disable", name: "plug" })
          yield* ExtensionOperations.run({ _tag: "Extension", action: "rollback", name: "plug" })
          yield* ExtensionOperations.run({ _tag: "Extension", action: "list" })
          return yield* TestConsole.logLines
        }).pipe(provideLayer(Layer.mergeAll(TestConsole.layer, ExtensionOperations.layer(options), oauthLayer)))
        const logs = yield* program
        expect(logs[0]).toContain("global-skill")
        expect(logs[1]).toContain("body")
        expect(logs[2]).toContain("unauthenticated")
        expect(logs[4]).toContain('"enabled":false')
        expect(logs.at(-1)).toContain('"generation":1')
        expect(yield* fs.readFileString(options.trustPath)).toContain("/other:remote")
      }).pipe(
        provideLayer(
          Layer.merge(BunServices.layer, SkillRegistry.fileSystemLayer.pipe(Layer.provide(BunServices.layer))),
        ),
      ),
    ),
  )

  it.effect("uses the connected client's workspace for workspace-owned state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-app-client-workspace-" })
        const clientWorkspace = `${root}/client`
        const source = `${root}/source/client-skill`
        const options = {
          globalRoot: `${root}/global`,
          workspaceRoot: `${root}/host/.rika/skills`,
          configPath: `${root}/host/.rika/mcp.json`,
          trustPath: `${root}/trust.json`,
          generationsPath: `${root}/host/.rika/extensions.json`,
        }
        yield* fs.makeDirectory(source, { recursive: true })
        yield* fs.writeFileString(`${source}/SKILL.md`, "---\nname: client-skill\ndescription: Client\n---\nbody")
        const run = (input: Parameters<typeof ExtensionOperations.run>[0]) =>
          ExtensionOperations.run(input).pipe(provideLayer(Layer.merge(ExtensionOperations.layer(options), oauthLayer)))
        yield* run({ _tag: "Skill", action: "add", source, clientWorkspace })
        yield* run({
          _tag: "Mcp",
          action: "add",
          name: "client",
          url: "https://example.test/mcp",
          clientWorkspace,
        })
        yield* run({ _tag: "Extension", action: "enable", name: "client", clientWorkspace })
        expect(yield* fs.exists(`${clientWorkspace}/.rika/skills/client-skill/SKILL.md`)).toBe(true)
        expect(yield* fs.readFileString(`${clientWorkspace}/.rika/mcp.json`)).toContain('"client"')
        expect(yield* fs.readFileString(`${clientWorkspace}/.rika/extensions.json`)).toContain('"client"')
        expect(yield* fs.exists(options.configPath)).toBe(false)
      }).pipe(
        provideLayer(
          Layer.merge(BunServices.layer, SkillRegistry.fileSystemLayer.pipe(Layer.provide(BunServices.layer))),
        ),
      ),
    ),
  )

  it.effect("returns typed errors for unsupported actions and invalid documents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-app-errors-" })
        const options = {
          globalRoot: `${root}/global`,
          workspaceRoot: `${root}/skills`,
          configPath: `${root}/bad.json`,
          trustPath: `${root}/trust.json`,
          generationsPath: `${root}/generations.json`,
        }
        yield* fs.writeFileString(options.configPath, "{")
        const run = (input: Parameters<typeof ExtensionOperations.run>[0]) =>
          ExtensionOperations.run(input).pipe(provideLayer(Layer.merge(ExtensionOperations.layer(options), oauthLayer)))
        expect((yield* Effect.flip(run({ _tag: "Mcp", action: "list" })))._tag).toBe(
          "@rika/app/ExtensionOperationError",
        )
        yield* fs.writeFileString(options.configPath, '{"servers":{}}')
        expect((yield* Effect.flip(run({ _tag: "Mcp", action: "oauth-status", name: "missing" }))).message).toContain(
          "not found",
        )
        expect((yield* Effect.flip(run({ _tag: "Extension", action: "create-plugin", name: "x" }))).message).toContain(
          "outside",
        )
        expect((yield* Effect.flip(run({ _tag: "Extension", action: "create-skill", name: "x" }))).message).toContain(
          "outside",
        )
      }).pipe(
        provideLayer(
          Layer.merge(BunServices.layer, SkillRegistry.fileSystemLayer.pipe(Layer.provide(BunServices.layer))),
        ),
      ),
    ),
  )

  it.effect("rejects invalid lifecycle mutations without corrupting MCP state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-app-mcp-validation-" })
        const options = {
          globalRoot: `${root}/global`,
          workspaceRoot: `${root}/skills`,
          configPath: `${root}/mcp.json`,
          trustPath: `${root}/trust.json`,
          generationsPath: `${root}/generations.json`,
        }
        const run = (input: Parameters<typeof ExtensionOperations.run>[0]) => ExtensionOperations.run(input)
        const program = Effect.gen(function* () {
          yield* run({ _tag: "Mcp", action: "add", name: "local", command: ["runner"] })
          expect(
            (yield* Effect.flip(run({ _tag: "Mcp", action: "add", name: "local", url: "https://example.test" })))
              .message,
          ).toContain("Duplicate server")
          for (const action of ["remove", "enable", "disable", "approve"] as const) {
            expect((yield* Effect.flip(run({ _tag: "Mcp", action, name: "missing" }))).message).toContain("not found")
          }
          expect(yield* fs.readFileString(options.configPath)).toContain('"command": "runner"')

          yield* fs.writeFileString(options.configPath, '{"direct":{"command":"runner"},"disabled":{"command":"echo"}}')
          yield* run({ _tag: "Mcp", action: "disable", name: "direct" })
          yield* run({ _tag: "Mcp", action: "enable", name: "direct" })
          yield* run({ _tag: "Mcp", action: "remove", name: "direct" })
          yield* run({ _tag: "Mcp", action: "remove", name: "disabled" })
          yield* run({ _tag: "Mcp", action: "add", name: "__proto__", command: ["runner"] })
          const specialName = decodeJson(yield* fs.readFileString(options.configPath)) as {
            readonly servers: Readonly<Record<string, unknown>>
          }
          expect(Object.hasOwn(specialName.servers, "__proto__")).toBe(true)
          yield* run({ _tag: "Mcp", action: "remove", name: "__proto__" })

          yield* fs.writeFileString(options.configPath, '{"servers":{"local":{"command":"runner"}},"disabled":"local"}')
          expect((yield* Effect.flip(run({ _tag: "Mcp", action: "doctor" }))).message).toContain("disabled")
          expect((yield* Effect.flip(run({ _tag: "Mcp", action: "disable", name: "local" }))).message).toContain(
            "disabled",
          )
          yield* fs.writeFileString(options.configPath, '{"servers":{"local":{"command":"runner"}}}')
          yield* fs.writeFileString(options.trustPath, '{"approved":"secret"}')
          expect((yield* Effect.flip(run({ _tag: "Mcp", action: "approve", name: "local" }))).message).toContain(
            "approved",
          )
        }).pipe(provideLayer(Layer.merge(ExtensionOperations.layer(options), oauthLayer)))
        yield* program
      }).pipe(
        provideLayer(
          Layer.merge(BunServices.layer, SkillRegistry.fileSystemLayer.pipe(Layer.provide(BunServices.layer))),
        ),
      ),
    ),
  )

  it.effect("serializes concurrent MCP definition updates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-app-mcp-concurrency-" })
        const options = {
          globalRoot: `${root}/global`,
          workspaceRoot: `${root}/skills`,
          configPath: `${root}/mcp.json`,
          trustPath: `${root}/trust.json`,
          generationsPath: `${root}/generations.json`,
        }
        const names = Array.from({ length: 24 }, (_, index) => `server-${index}`)
        const extensionLayer = Layer.merge(ExtensionOperations.layer(options), oauthLayer)
        yield* Effect.forEach(
          names,
          (name) =>
            ExtensionOperations.run({ _tag: "Mcp", action: "add", name, command: ["runner", name] }).pipe(
              provideLayer(extensionLayer),
            ),
          { concurrency: "unbounded", discard: true },
        )
        const document = decodeJson(yield* fs.readFileString(options.configPath)) as {
          readonly servers: Readonly<Record<string, unknown>>
        }
        expect(Object.keys(document.servers).toSorted()).toEqual(names.toSorted())
      }).pipe(
        provideLayer(
          Layer.merge(BunServices.layer, SkillRegistry.fileSystemLayer.pipe(Layer.provide(BunServices.layer))),
        ),
      ),
    ),
  )

  it.effect("rejects non-object MCP state and handles existing extension generations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-app-state-" })
        const options = {
          globalRoot: `${root}/global`,
          workspaceRoot: `${root}/skills`,
          configPath: `${root}/config.json`,
          trustPath: `${root}/trust.json`,
          generationsPath: `${root}/generations.json`,
        }
        yield* fs.writeFileString(options.configPath, '{"servers":"invalid","disabled":["remote"]}')
        yield* fs.writeFileString(options.generationsPath, '{"extensions":{"plug":{"enabled":true,"generation":3}}}')
        const run = (input: Parameters<typeof ExtensionOperations.run>[0]) =>
          ExtensionOperations.run(input).pipe(provideLayer(Layer.merge(ExtensionOperations.layer(options), oauthLayer)))
        expect(
          (yield* Effect.flip(run({ _tag: "Mcp", action: "add", name: "remote", url: "https://example.test" })))
            .message,
        ).toContain("Invalid servers")
        yield* run({ _tag: "Extension", action: "rollback", name: "plug" })
        expect(yield* fs.readFileString(options.configPath)).toBe('{"servers":"invalid","disabled":["remote"]}')
        expect(yield* fs.readFileString(options.generationsPath)).toContain('"generation": 2')
      }).pipe(
        provideLayer(
          Layer.merge(BunServices.layer, SkillRegistry.fileSystemLayer.pipe(Layer.provide(BunServices.layer))),
        ),
      ),
    ),
  )
})
