import * as BunServices from "@effect/platform-bun/BunServices"
import { McpToolSource } from "@batonfx/mcp"
import { expect, it } from "@effect/vitest"
import { Crypto, Effect, Layer, PlatformError } from "effect"
import * as Extensions from "../src"
import { provideLayer } from "./layer"

const loadEntrypoint = Effect.fn("ExtensionsTest.loadEntrypoint")(() => Effect.tryPromise(() => import("../src/index")))

it.effect("exports every extension namespace from the package entrypoint", () =>
  Effect.gen(function* () {
    const entrypoint = yield* loadEntrypoint()
    expect(Object.keys(entrypoint).toSorted()).toEqual([
      "ExecutionExtensions",
      "McpConfig",
      "McpOAuth",
      "McpRuntime",
      "McpTrust",
      "PluginApi",
      "PluginDigest",
      "PluginLoader",
      "PluginRegistry",
      "PluginTrust",
      "SkillRegistry",
    ])
  }),
)

it.effect("validates every MCP configuration shape and composition conflict", () => {
  const compose = (workspace: string) => provideLayer(Extensions.McpConfig.compose({ workspace }), BunServices.layer)
  return Effect.gen(function* () {
    const valid = yield* compose(
      '{"servers":{"z":{"url":"https://example.test/mcp","headers":{"Authorization":"x"}},"a":{"command":"cmd","env":{"HOME":"/tmp"}}}}',
    )
    expect(valid.map((server) => server.name)).toEqual(["a", "z"])
    const errors = yield* Effect.all(
      [
        "null",
        "[]",
        '{"servers":[]}',
        '{"servers":{"x":null}}',
        '{"servers":{"x":{"command":"c","args":[1]}}}',
        '{"servers":{"x":{"command":"c","env":{"A":1}}}}',
        '{"servers":{"x":{"command":"c","cwd":1}}}',
        '{"servers":{"x":{"url":"https://example.test","headers":{"A":1}}}}',
        '{"servers":{"x":{"url":"not a url"}}}',
        '{"servers":{"x":{"command":"cmd","url":"https://example.test"}}}',
        '{"servers":{"x":{"command":""}}}',
        '{"servers":{"x":{}}}',
      ].map((document) => Effect.flip(compose(document))),
      { concurrency: "unbounded" },
    )
    for (const error of errors) {
      expect(error._tag).toBe("@rika/extensions/McpConfigError")
    }
    const duplicate = yield* provideLayer(
      Effect.flip(
        Extensions.McpConfig.compose({
          workspace: '{"x":{"command":"a"}}',
          activatedSkills: [
            {
              name: "s",
              digest: "d",
              resources: [
                { path: "ignored", content: "{" },
                { path: "mcp.json", content: '{"x":{"command":"b"}}' },
              ],
            },
          ],
        }),
      ),
      BunServices.layer,
    )
    expect(duplicate.message).toBe("Duplicate server: x")
  })
})

it.effect("maps MCP discovery, call, and connection errors", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server: Extensions.McpConfig.RemoteServer = {
        kind: "remote",
        name: "remote",
        url: "https://example.test",
        headers: {},
        source: "workspace",
        sourceDigest: "d",
      }
      const source = McpToolSource.McpToolSource.of({
        server: "remote",
        tools: Effect.succeed([]),
        callTool: () =>
          Effect.fail(McpToolSource.McpToolCallError.make({ server: "remote", tool: "x", message: "call failed" })),
        aiTools: Effect.succeed([]),
      })
      const call = yield* Effect.flip(
        provideLayer(
          Extensions.McpRuntime.call(server, "x", {}),
          Extensions.McpRuntime.testLayer(() => Effect.succeed(source)),
        ),
      )
      const connect = yield* Effect.flip(
        provideLayer(
          Extensions.McpRuntime.discover(server),
          Extensions.McpRuntime.testLayer(() =>
            Effect.fail(Extensions.McpRuntime.Diagnostic.make({ server: "remote", phase: "connect", message: "no" })),
          ),
        ),
      )
      const discover = yield* Effect.flip(
        provideLayer(
          Extensions.McpRuntime.discover(server),
          Extensions.McpRuntime.testLayer(() =>
            Effect.fail(
              Extensions.McpRuntime.Diagnostic.make({
                server: "remote",
                phase: "discover",
                message: "discovery failed",
              }),
            ),
          ),
        ),
      )
      expect([call.phase, connect.phase, discover.phase]).toEqual(["call", "connect", "discover"])
    }),
  ),
)

it.effect("covers live MCP transport construction failures for local and remote servers", () => {
  const servers: ReadonlyArray<Extensions.McpConfig.Server> = [
    {
      kind: "local",
      name: "bad-local",
      command: "/definitely/missing",
      args: [],
      environment: {},
      source: "workspace",
      sourceDigest: "d",
    },
    { kind: "remote", name: "bad-remote", url: "not-a-url", headers: {}, source: "workspace", sourceDigest: "d" },
  ]
  return Effect.gen(function* () {
    const results = yield* Effect.all(
      servers.map((server) =>
        Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* Extensions.McpRuntime.Service
              yield* runtime.connect(server)
            }),
          ).pipe(
            provideLayer(
              Layer.merge(Extensions.McpRuntime.layer.pipe(Layer.provide(BunServices.layer)), BunServices.layer),
            ),
          ),
        ),
      ),
      { concurrency: "unbounded" },
    )
    for (const result of results) {
      expect(result._tag).toBe("Failure")
    }
  })
})

it.effect("exercises MCP trust defaults and test trust state", () => {
  const record: Extensions.McpTrust.Record = {
    workspaceIdentity: "w",
    server: "s",
    command: "c",
    args: [],
    environmentNameFingerprint: "e",
    effectiveCwd: "/",
    sourceDigest: "d",
    fingerprint: "f",
  }
  return Effect.gen(function* () {
    const result = yield* provideLayer(
      Effect.gen(function* () {
        const trust = yield* Extensions.McpTrust.Service
        const before = yield* trust.isTrusted(record)
        yield* trust.approve(record)
        const after = yield* trust.isTrusted(record)
        const create = yield* Effect.flip(
          trust.create("w", "/", {
            kind: "local",
            name: "s",
            command: "c",
            args: [],
            environment: {},
            source: "workspace",
            sourceDigest: "d",
          }),
        )
        return { before, after, create }
      }),
      Extensions.McpTrust.testLayer(["already"]),
    )
    expect([result.before, result.after, result.create.operation]).toEqual([false, true, "create"])
  })
})

it.effect("covers digest canonical forms and execution extension empty, resume, and fingerprint paths", () =>
  Effect.gen(function* () {
    const array = yield* Extensions.PluginDigest.configuration([null, true, 1, "x", { b: 2, a: 1 }])
    const object = yield* Extensions.PluginDigest.configuration({ a: 1, b: 2 })
    const schemas = yield* Extensions.PluginDigest.toolSchemas([
      { name: "z", description: "z", inputSchema: {}, execute: Effect.succeed },
      { name: "a", description: "a", inputSchema: {}, execute: Effect.succeed },
    ])
    expect(array).toHaveLength(64)
    expect(object).toHaveLength(64)
    expect(schemas).toHaveLength(64)
    const extensions = yield* Extensions.ExecutionExtensions.Service
    const empty = yield* Effect.flip(extensions.future("m", "c"))
    expect(empty._tag).toBe("@rika/extensions/NoExtensionGeneration")
    expect(yield* Extensions.ExecutionExtensions.mcpFingerprint(["b", "a"])).toHaveLength(64)
  }).pipe(
    provideLayer(
      Layer.mergeAll(
        Extensions.ExecutionExtensions.layer.pipe(Layer.provide(Extensions.PluginRegistry.memoryLayer)),
        Extensions.PluginRegistry.memoryLayer,
        BunServices.layer,
      ),
    ),
  ),
)

it.effect("resumes a pinned execution generation", () =>
  Effect.gen(function* () {
    const registry = yield* Extensions.PluginRegistry.Service
    const generation: Extensions.PluginRegistry.Generation = {
      id: "generation",
      sourceDigest: "source",
      configFingerprint: "config",
      toolSchemaDigest: "tools",
      tools: new Map(),
      modes: new Map(),
      agentProfiles: new Map(),
      uiActions: new Map(),
      diagnostics: [],
    }
    yield* registry.publish(generation)
    const service = yield* Extensions.ExecutionExtensions.Service
    const pin: Extensions.ExecutionExtensions.Pin = {
      generation: "generation",
      sourceDigest: "source",
      configFingerprint: "config",
      toolSchemaDigest: "tools",
      mcpFingerprint: "mcp",
      resolvedContextDigest: "context",
    }
    expect(yield* service.resume(pin)).toEqual({ pin, generation })
    expect((yield* Effect.flip(service.resume({ ...pin, generation: "missing" }))).generation).toBe("missing")
  }).pipe(
    provideLayer(
      Layer.merge(
        Extensions.ExecutionExtensions.layer.pipe(Layer.provide(Extensions.PluginRegistry.memoryLayer)),
        Extensions.PluginRegistry.memoryLayer,
      ),
    ),
  ),
)

it.effect("maps cryptographic digest failures", () => {
  const failure = PlatformError.systemError({
    _tag: "Unknown",
    module: "test",
    method: "digest",
    description: "crypto failed",
  })
  const cryptoLayer = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({ randomBytes: (size) => new Uint8Array(size), digest: () => Effect.fail(failure) }),
  )
  return Effect.gen(function* () {
    const digest = yield* Effect.flip(Extensions.PluginDigest.source("source"))
    expect(digest._tag).toBe("@rika/extensions/PluginDigestError")
    const config = yield* Effect.flip(Extensions.McpConfig.compose({ workspace: "{}" }))
    expect(config._tag).toBe("@rika/extensions/McpConfigError")
    const trust = yield* Extensions.McpTrust.Service
    const error = yield* Effect.flip(
      trust.create("workspace", "/workspace", {
        kind: "local",
        name: "server",
        command: "command",
        args: [],
        environment: {},
        source: "workspace",
        sourceDigest: "source",
      }),
    )
    expect(error.operation).toBe("fingerprint")
  }).pipe(
    provideLayer(
      Layer.mergeAll(
        Extensions.McpTrust.layer.pipe(Layer.provide(Layer.merge(BunServices.layer, cryptoLayer))),
        BunServices.layer,
        cryptoLayer,
      ),
    ),
  )
})

it.effect("uses the workspace root for MCP commands without a configured cwd", () =>
  Effect.gen(function* () {
    const trust = yield* Extensions.McpTrust.Service
    const record = yield* trust.create("workspace", "/workspace", {
      kind: "local",
      name: "server",
      command: "command",
      args: [],
      environment: {},
      source: "workspace",
      sourceDigest: "source",
    })
    expect(record.effectiveCwd).toBe("/workspace")
  }).pipe(
    provideLayer(Layer.merge(Extensions.McpTrust.layer.pipe(Layer.provide(BunServices.layer)), BunServices.layer)),
  ),
)
