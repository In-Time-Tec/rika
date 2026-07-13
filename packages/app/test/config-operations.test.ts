import { expect, it } from "@effect/vitest"
import { ConfigOperations } from "../src/index"
import { ConfigService } from "@rika/config"
import { Effect, Layer, Redacted, Ref } from "effect"
import { TestConsole } from "effect/testing"

const options: ConfigOperations.Options = {
  globalConfigPath: "/home/config.json",
  workspaceConfigPath: "/work/config.json",
  productDatabasePath: "/home/rika.db",
  relayDatabasePath: "/home/relay.db",
  upstream: [{ name: "relay", present: true }],
}

it.effect("prints effective redacted config and keymap", () =>
  Effect.gen(function* () {
    const layer = Layer.mergeAll(
      TestConsole.layer,
      ConfigService.memoryLayer({
        environment: { gatewayCredentials: {}, parallelApiKey: Redacted.make("never-print-this") },
      }),
      ConfigOperations.testLayer({ edit: () => Effect.void, exists: () => Effect.succeed(false) }),
    )
    const lines = yield* Effect.gen(function* () {
      yield* ConfigOperations.run({ _tag: "Config", action: "list" }, options)
      yield* ConfigOperations.run({ _tag: "Config", action: "keymap" }, options)
      return yield* TestConsole.logLines
    }).pipe(Effect.provide(layer))
    expect(lines[0]).toContain('"parallelApiKey": "present"')
    expect(lines.join("\n")).not.toContain("never-print-this")
    expect(lines[0]).toContain('"gatewayName": "openai"')
    expect(lines[0]).toContain('"apiKey": "missing"')
    expect(lines[1]).toContain('"submit": "enter"')
  }),
)

it.effect("edits the selected path and reports secret-safe doctor status", () =>
  Effect.gen(function* () {
    const edits = yield* Ref.make<ReadonlyArray<string>>([])
    const layer = Layer.mergeAll(
      TestConsole.layer,
      ConfigService.memoryLayer(),
      ConfigOperations.testLayer({
        edit: (path) => Ref.update(edits, (values) => [...values, path]),
        exists: (path) => Effect.succeed(path === options.productDatabasePath),
      }),
    )
    const lines = yield* Effect.gen(function* () {
      yield* ConfigOperations.run({ _tag: "Config", action: "edit", workspace: false }, options)
      yield* ConfigOperations.run({ _tag: "Config", action: "edit", workspace: true }, options)
      yield* ConfigOperations.run({ _tag: "Doctor" }, options)
      return yield* TestConsole.logLines
    }).pipe(Effect.provide(layer))
    expect(yield* Ref.get(edits)).toEqual([options.globalConfigPath, options.workspaceConfigPath])
    expect(lines[0]).toContain('"product": "present"')
    expect(lines[0]).toContain('"parallel": "missing"')
  }),
)

it.effect("lists MCP transports and reports present doctor branches", () =>
  Effect.gen(function* () {
    const presentOptions = { ...options, upstream: [{ name: "relay", present: false }] }
    const layer = Layer.mergeAll(
      TestConsole.layer,
      ConfigService.memoryLayer({
        environment: {
          parallelApiKey: Redacted.make("secret"),
          gatewayCredentials: {
            OPENAI_API_KEY: Redacted.make("model-secret"),
            ANTHROPIC_API_KEY: Redacted.make("oracle-secret"),
          },
        },
        workspace: {
          mcp: { local: { transport: "command", command: "mcp", args: [], environment: {}, enabled: false } },
        },
      }),
      ConfigOperations.testLayer({ edit: () => Effect.void, exists: () => Effect.succeed(true) }),
    )
    const lines = yield* Effect.gen(function* () {
      yield* ConfigOperations.run({ _tag: "Config", action: "list" }, presentOptions)
      yield* ConfigOperations.run({ _tag: "Mcp", action: "list" }, presentOptions)
      yield* ConfigOperations.run({ _tag: "Mcp", action: "doctor" }, presentOptions)
      yield* ConfigOperations.run({ _tag: "Doctor" }, presentOptions)
      return yield* TestConsole.logLines
    }).pipe(Effect.provide(layer))
    expect(lines[0]).toContain('"apiKey": "present"')
    expect(lines[1]).toContain('"transport": "command"')
    expect(lines[3]).toContain('"relay": "missing"')
    expect(lines[3]).toContain('"parallel": "present"')
    expect(lines[3]).toContain('"apiKey": "present"')
    expect(lines.join("\n")).not.toContain("model-secret")
  }),
)

it.effect("reports missing config and mixed doctor paths", () =>
  Effect.gen(function* () {
    const layer = Layer.mergeAll(
      TestConsole.layer,
      ConfigService.memoryLayer(),
      ConfigOperations.testLayer({
        edit: () => Effect.void,
        exists: (path) => Effect.succeed(path === options.relayDatabasePath || path === options.workspaceConfigPath),
      }),
    )
    const lines = yield* Effect.gen(function* () {
      yield* ConfigOperations.run({ _tag: "Config", action: "list" }, options)
      yield* ConfigOperations.run({ _tag: "Doctor" }, options)
      return yield* TestConsole.logLines
    }).pipe(Effect.provide(layer))
    expect(lines[0]).toContain('"parallelApiKey": "missing"')
    expect(lines[1]).toContain('"product": "missing"')
    expect(lines[1]).toContain('"relay": "present"')
    expect(lines[1]).toContain('"global": "missing"')
    expect(lines[1]).toContain('"workspace": "present"')
  }),
)
