import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Crypto, Effect, FileSystem, Layer, PlatformError } from "effect"
import * as McpConfig from "@rika/extensions/mcp-configuration"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import * as PluginLoader from "../../src/plugin/plugin-loader"
import * as PluginRegistry from "@rika/extensions/plugin-registry"
import * as SkillRegistry from "@rika/extensions/skill-registry"
import * as SkillFileSystem from "../../src/skill/skill-file-system"

const document = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nbody`

const platformFailure = (method: string) =>
  PlatformError.systemError({ _tag: "Unknown", module: "test", method, description: `${method} failed` })

const pluginSource = (id: string, load: PluginLoader.Source["load"]): PluginLoader.Source => ({
  id,
  content: id,
  configuration: {},
  load,
})

const skillLayer = (operation: keyof SkillFileSystem.FileSystemInterface) =>
  Layer.succeed(
    SkillFileSystem.SkillFileSystem,
    SkillFileSystem.SkillFileSystem.of({
      exists: () => (operation === "exists" ? Effect.fail(platformFailure("exists")) : Effect.succeed(true)),
      readDirectory: () =>
        operation === "readDirectory"
          ? Effect.fail(platformFailure("readDirectory"))
          : Effect.succeed(["resource.txt"]),
      isFile: () => (operation === "isFile" ? Effect.fail(platformFailure("isFile")) : Effect.succeed(true)),
      readFileString: () =>
        operation === "readFileString" ? Effect.fail(platformFailure("readFileString")) : Effect.succeed("resource"),
      realPath: (path) => (operation === "realPath" ? Effect.fail(platformFailure("realPath")) : Effect.succeed(path)),
    }),
  )

it.layer(BunServices.layer)((test) => {
  test.effect("maps every skill resource filesystem failure", () =>
    Effect.gen(function* () {
      const operations = ["exists", "realPath", "readDirectory", "isFile", "readFileString"] as const
      const results = yield* Effect.forEach(operations, (operation) =>
        Effect.gen(function* () {
          const context = yield* Layer.build(skillLayer(operation))
          const fileSystem = yield* FileSystem.FileSystem
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skill-errors-" })
          const globalRoot = `${root}/global`
          const workspaceRoot = `${root}/workspace`
          yield* fileSystem.makeDirectory(`${globalRoot}/test`, { recursive: true })
          yield* fileSystem.writeFileString(`${globalRoot}/test/SKILL.md`, document("test"))
          const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot }).pipe(Effect.provide(context))
          return yield* Effect.flip(registry.activate("test"))
        }).pipe(Effect.scoped),
      )
      for (const result of results) {
        expect(result.operation).toBe("activate")
        expect(result.message).toContain("failed")
      }
    }),
  )

  test.effect("exercises the skill test filesystem and rejects escaping resources", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skill-test-layer-" })
      const globalRoot = `${root}/global`
      const workspaceRoot = `${root}/workspace`
      yield* fileSystem.makeDirectory(`${globalRoot}/test`, { recursive: true })
      yield* fileSystem.writeFileString(`${globalRoot}/test/SKILL.md`, document("test"))
      const files = {
        [`${globalRoot}/test/SKILL.md`]: document("test"),
        [`${globalRoot}/test/resource.txt`]: "resource",
      }
      const activate = (entries: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const context = yield* Layer.build(
            SkillFileSystem.fileSystemTestLayer(files, {
              [globalRoot]: ["test/SKILL.md"],
              [workspaceRoot]: [],
              [`${globalRoot}/test`]: entries,
            }),
          )
          const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot }).pipe(Effect.provide(context))
          return yield* registry.activate("test")
        })
      const success = yield* activate(["SKILL.md", "directory", "resource.txt"])
      const escaped = yield* Effect.flip(activate(["../outside.txt"]))
      const escapedManifest = yield* Effect.flip(activate(["../SKILL.md"]))
      expect(success.resources).toEqual([{ path: "resource.txt", content: "resource" }])
      expect(escaped.message).toBe("Resource path escapes skill directory")
      expect(escapedManifest.message).toBe("Resource path escapes skill directory")
    }).pipe(Effect.scoped),
  )

  test.effect("exercises missing test filesystem entries", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(SkillFileSystem.fileSystemTestLayer({}, {}))
      yield* Effect.gen(function* () {
        const fileSystem = yield* SkillFileSystem.SkillFileSystem
        expect((yield* Effect.exit(fileSystem.readDirectory("/missing")))._tag).toBe("Failure")
        expect((yield* Effect.exit(fileSystem.readFileString("/missing")))._tag).toBe("Failure")
        expect(yield* fileSystem.exists("/missing")).toBe(false)
        expect(yield* fileSystem.isFile("/missing")).toBe(false)
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped),
  )

  test.effect("maps skill digest and lazy body read failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skill-boundaries-" })
      const globalRoot = `${root}/global`
      const workspaceRoot = `${root}/workspace`
      const manifest = `${globalRoot}/test/SKILL.md`
      yield* fileSystem.makeDirectory(`${globalRoot}/test`, { recursive: true })
      yield* fileSystem.writeFileString(manifest, document("test"))
      const context = yield* Layer.build(SkillFileSystem.fileSystemLayer)
      const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot }).pipe(Effect.provide(context))
      yield* fileSystem.remove(manifest)
      expect((yield* Effect.flip(registry.activate("test"))).operation).toBe("activate")
      const failure = platformFailure("digest")
      const cryptoLayer = Layer.succeed(
        Crypto.Crypto,
        Crypto.make({ randomBytes: (size) => new Uint8Array(size), digest: () => Effect.fail(failure) }),
      )
      const digestContext = yield* Layer.build(Layer.merge(SkillFileSystem.fileSystemTestLayer({}, {}), cryptoLayer))
      const digestError = yield* Effect.flip(
        SkillRegistry.discover({ globalRoot: "/global", workspaceRoot: "/workspace" }).pipe(
          Effect.provide(digestContext),
        ),
      )
      expect(digestError.operation).toBe("digest")
    }).pipe(Effect.scoped),
  )

  test.effect("maps MCP discovery errors and exercises factory methods", () => {
    const server: McpConfig.LocalServer = {
      kind: "local",
      name: "server",
      command: "command",
      args: [],
      environment: {},
      source: "workspace",
      sourceDigest: "digest",
    }
    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          McpRuntime.testLayer(() =>
            Effect.fail(
              McpRuntime.Diagnostic.make({
                server: "server",
                phase: "discover",
                message: "discovery failed",
              }),
            ),
          ),
        )
        yield* Effect.gen(function* () {
          const error = yield* Effect.flip(McpRuntime.discover(server))
          expect(error.phase).toBe("discover")
        }).pipe(Effect.provide(context))
      }),
    )
  })

  test.effect("isolates plugin import, contract, and registration failures", () => {
    const layers = Layer.mergeAll(PluginRegistry.memoryLayer, BunServices.layer)
    return Effect.gen(function* () {
      const context = yield* Layer.build(layers)
      yield* Effect.gen(function* () {
        const generation = yield* PluginLoader.reload([
          pluginSource("import", Effect.fail(PluginLoader.LoadError.make({ message: "read/import failed" }))),
          pluginSource("contract", Effect.succeed({ apiVersion: 1, id: "wrong", register: () => {} })),
          pluginSource(
            "register",
            Effect.succeed({
              apiVersion: 1,
              id: "register",
              register: () => {
                throw new Error("registration failed")
              },
            }),
          ),
        ])
        expect(generation.diagnostics).toHaveLength(3)
        expect(generation.diagnostics.join("\n")).toContain("load failed")
        expect(generation.diagnostics.join("\n")).toContain("invalid plugin contract")
        expect(generation.diagnostics.join("\n")).toContain("registration failed")
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped)
  })
})
