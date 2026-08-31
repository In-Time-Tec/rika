import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { HostBindings } from "generalist/repl"
import type * as McpDiscovery from "@rika/extensions/mcp-discovery"
import { make as makeModules, moduleNames } from "@rika/kernel/binding-modules"
import { operation as bindingOperation } from "@rika/kernel/nested-operation-envelope"

const servers: ReadonlyArray<McpDiscovery.ConfiguredServer> = []

const modules = makeModules({
  workspace: "/repo",
  workspaceDigest: "digest",
  trustMode: "trusted-local",
  servers,
})

const every = modules.flatMap((module) =>
  module.operations.map((operation) => ({
    module: module.name,
    operation,
  })),
)

const NoFailure = Schema.TaggedStruct("NoFailure", {})
const mountModules = modules.map((module) => ({
  name: module.name,
  operations: module.operations.map((entry) =>
    bindingOperation({
      name: entry.name,
      input: Schema.Unknown,
      output: Schema.Void,
      failure: NoFailure,
      handle: () => Effect.void,
    }),
  ),
}))

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
      expect(operation.handle).toBeDefined()
    }
  })

  it.effect("mounts the whole surface without a name conflict", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(HostBindings.layer(mountModules))
      const mounted = Context.get(context, HostBindings.HostBindings)
      expect(mounted.descriptors.map((descriptor) => descriptor.module)).toEqual([...moduleNames])
    }).pipe(Effect.scoped),
  )

  it.effect("declares an input schema that decodes for every operation", () =>
    Effect.gen(function* () {
      for (const { module, operation: entry } of every) {
        const mounted = yield* HostBindings.make([
          {
            name: module,
            operations: [
              bindingOperation({
                name: entry.name,
                input: entry.input,
                output: Schema.Void,
                failure: NoFailure,
                handle: () => Effect.void,
              }),
            ],
          },
        ])
        const result = yield* Effect.exit(mounted.invoke({ module, operation: entry.name, input: {} }))
        expect(`${module}.${entry.name}:${result._tag}`).toMatch(/:(Success|Failure)$/)
      }
    }),
  )

  it("declares a failure schema that is a discriminated tagged shape the cell can branch on", () => {
    for (const { module, operation } of every) {
      const ast = JSON.stringify(operation.failure.ast)
      expect(`${module}.${operation.name}:${ast.includes("_tag")}`).toBe(`${module}.${operation.name}:true`)
    }
  })

  it.effect("encodes and decodes every operation's declared output back to an equal value", () => {
    const samples = {
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
      "context.current": { threadId: "t", workspace: "/repo", trustMode: "trusted-local" },
      "context.compactions": [{ id: "c", summary: "s" }],
      "mcp.servers": [{ name: "files", kind: "local", enabled: true }],
      "mcp.call": { content: { ok: true }, isError: false },
    }
    return Effect.gen(function* () {
      for (const [key, value] of Object.entries(samples)) {
        const found = every.find(({ module, operation }) => `${module}.${operation.name}` === key)
        expect(`${key}:${found !== undefined}`).toBe(`${key}:true`)
        if (found === undefined) throw new Error(`Missing operation ${key}`)
        const mounted = yield* HostBindings.make([
          {
            name: found.module,
            operations: [
              bindingOperation({
                name: found.operation.name,
                input: Schema.Unknown,
                output: found.operation.output,
                failure: NoFailure,
                handle: () => Effect.succeed(value),
              }),
            ],
          },
        ])
        const response = yield* mounted.invoke({ module: found.module, operation: found.operation.name, input: {} })
        expect({ key, value: response._tag === "Success" ? response.output : response.failure }).toEqual({ key, value })
      }
    })
  })

  it.effect("rejects an output that does not match the declared schema", () =>
    Effect.gen(function* () {
      const write = every.find(({ module, operation }) => module === "workspace" && operation.name === "write")
      if (write === undefined) throw new Error("Missing workspace.write")
      const mounted = yield* HostBindings.make([
        {
          name: write.module,
          operations: [
            bindingOperation({
              name: write.operation.name,
              input: Schema.Unknown,
              output: write.operation.output,
              failure: NoFailure,
              handle: () => Effect.succeed({ text: 7 }),
            }),
          ],
        },
      ])
      const result = yield* Effect.exit(
        mounted.invoke({ module: write.module, operation: write.operation.name, input: {} }),
      )
      expect(result._tag).toBe("Failure")
    }),
  )
})
