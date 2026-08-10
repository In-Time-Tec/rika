import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import { HostBindingRegistry } from "@batonfx/repl"
import type * as McpDiscovery from "@rika/extensions/mcp-discovery"
import { make as makeModules, moduleNames, type BindingRequirements } from "@rika/kernel/binding-modules"

const servers: ReadonlyArray<McpDiscovery.ConfiguredServer> = []

const modules = makeModules({
  workspace: "/repo",
  workspaceDigest: "digest",
  trustMode: "trusted-local",
  servers,
})

interface Op {
  readonly module: string
  readonly operation: HostBindingRegistry.AnyOperation
}

const every: ReadonlyArray<Op> = modules.flatMap((module) =>
  module.operations.map((operation) => ({
    module: module.name,
    operation: operation as HostBindingRegistry.AnyOperation,
  })),
)

const codec = <S extends Schema.Constraint>(schema: S) =>
  schema as unknown as Schema.Codec<unknown, unknown, never, never>

describe("binding schema round trip", () => {
  it("mounts every module the bindings digest is computed over", () => {
    expect(modules.map((module) => module.name)).toEqual([...moduleNames])
  })

  it("mounts no duplicate module name", () => {
    expect(new Set(moduleNames).size).toBe(moduleNames.length)
  })

  it("mounts no duplicate operation name inside one module", () => {
    for (const module of modules) {
      const names = module.operations.map((operation) => operation.name)
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it("declares every operation with a name, input, output, failure, and handler", () => {
    expect(every.length).toBeGreaterThan(0)
    for (const { module, operation } of every) {
      expect(`${module}.${operation.name}`).toMatch(/^[a-z]+\.[A-Za-z]+$/)
      expect(operation.input).toBeDefined()
      expect(operation.output).toBeDefined()
      expect(operation.failure).toBeDefined()
      expect(typeof operation.handle).toBe("function")
    }
  })

  it.effect("mounts the whole surface without a name conflict", () =>
    Effect.map(
      Effect.provideContext(HostBindingRegistry.make(modules), Context.empty() as Context.Context<BindingRequirements>),
      (mounted) => {
        expect(mounted.descriptors.map((descriptor) => descriptor.module)).toEqual([...moduleNames])
      },
    ),
  )

  it("declares an input schema that decodes for every operation", () => {
    for (const { module, operation } of every) {
      const result = Schema.decodeUnknownExit(codec(operation.input))({})
      expect(`${module}.${operation.name}:${result._tag}`).toMatch(/:(Success|Failure)$/)
    }
  })

  it("declares a failure schema that is a discriminated tagged shape the cell can branch on", () => {
    for (const { module, operation } of every) {
      const ast = JSON.stringify(operation.failure.ast)
      expect(`${module}.${operation.name}:${ast.includes("_tag")}`).toBe(`${module}.${operation.name}:true`)
    }
  })

  it("encodes and decodes every operation's declared output back to an equal value", () => {
    const samples: Record<string, unknown> = {
      "workspace.search": { text: "a.ts:1:t", matches: [{ path: "a.ts", line: 1, text: "t" }], truncated: false },
      "workspace.read": { text: "t", truncated: false },
      "workspace.write": { text: "t", truncated: false, diff: "d" },
      "workspace.replace": { text: "t", truncated: true, diff: "d" },
      "edits.apply": { applied: [{ path: "a", text: "t", diff: "d" }], truncated: false },
      "processes.start": { text: "t", truncated: false, running: true, processId: "1" },
      "processes.status": { text: "t", truncated: false, exitCode: 0, stdout: "o", stderr: "e" },
      "processes.stop": { text: "t", truncated: false },
      "web.search": { text: "t", truncated: false },
      "web.readPage": { text: "t", truncated: false },
      "media.attach": {
        text: "t",
        truncated: false,
        artifact: { path: "a.png", mimeType: "image/png", kind: "image", size: 1 },
      },
      "goal.get": {},
      "artifacts.put": { id: "abc", bytes: 3 },
      "artifacts.get": { value: { any: "json" } },
      "agents.spawn": { childRunId: "c", key: "k", duplicate: false },
      "agents.cancel": {},
      "agents.inbox": [{ entryId: "e", sequence: 1, from: "run:a", prompt: "p", messageId: "m" }],
      "agents.directory": [{ address: "run:a", runId: "a", sessionId: "s", relationship: "parent" }],
      "context.current": { threadId: "t", workspace: "/repo", trustMode: "trusted-local" },
      "context.compactions": [{ id: "c", summary: "s" }],
      "mcp.servers": [{ name: "files", kind: "local", enabled: true }],
      "mcp.call": { content: { ok: true }, isError: false },
    }
    for (const [key, value] of Object.entries(samples)) {
      const found = every.find(({ module, operation }) => `${module}.${operation.name}` === key)
      expect(`${key}:${found !== undefined}`).toBe(`${key}:true`)
      const encoded = Schema.encodeUnknownSync(codec(found!.operation.output))(value)
      expect({ key, value: Schema.decodeUnknownSync(codec(found!.operation.output))(encoded) }).toEqual({ key, value })
    }
  })

  it("rejects an output that does not match the declared schema", () => {
    const write = every.find(({ module, operation }) => module === "workspace" && operation.name === "write")!
    expect(Schema.encodeUnknownExit(codec(write.operation.output))({ text: 7 })._tag).toBe("Failure")
  })
})
