import { describe, expect, test } from "bun:test"
import { PermissionPolicy, ToolExecutor, ToolRegistry } from "@rika/agent"
import { Diagnostics, SecretRedactor } from "@rika/core"
import { Common, Ids, Tool } from "@rika/schema"
import { Effect, Layer } from "effect"
import { PluginHost, PluginUi } from "../src/index"

const memoryUi = (): PluginUi.MemoryUi => ({
  notifications: [],
  confirmations: [],
  inputs: [],
  selects: [],
  confirmResponses: [],
  inputResponses: [],
  selectResponses: [],
})

const source = (name: string, entrypoint: PluginHost.PluginSource["entrypoint"]): PluginHost.PluginSource => ({
  name,
  path: `.rika/plugins/${name}.ts`,
  entrypoint,
})

const call = (name: string, input: Common.JsonValue): Tool.Call => ({
  id: Ids.ToolCallId.make(`tool_call_${name.replaceAll(".", "_")}`),
  name,
  input,
})

const hostLayer = (
  sources: ReadonlyArray<PluginHost.PluginSource>,
  ui = memoryUi(),
  diagnostics?: Array<Diagnostics.Entry>,
) => {
  const layer = PluginHost.layerFromSources(sources).pipe(Layer.provide(PluginUi.memoryLayer(ui)))
  return diagnostics === undefined ? layer : layer.pipe(Layer.provideMerge(diagnosticsLayer(diagnostics)))
}

const diagnosticsLayer = (entries: Array<Diagnostics.Entry> = []) => {
  const redactorLayer = SecretRedactor.layer
  return Diagnostics.memoryLayer(entries).pipe(Layer.provideMerge(redactorLayer))
}

describe("PluginHost", () => {
  test("loads plugins and reports load errors without hiding valid plugins", async () => {
    const layer = hostLayer([
      source("valid", (rika) => rika.registerMode({ name: "rush", description: "Fast plugin mode" })),
      source("broken", () => {
        throw new Error("boom")
      }),
    ])

    const loaded = await Effect.runPromise(
      Effect.gen(function* () {
        const report = yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.report))
        const modes = yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.modes))
        return { report, modes }
      }).pipe(Effect.provide(layer)),
    )

    expect(loaded.report.loaded.map((plugin) => plugin.name)).toEqual(["valid"])
    expect(loaded.report.errors).toEqual([{ name: "broken", path: ".rika/plugins/broken.ts", message: "boom" }])
    expect(loaded.report.trust).toMatchObject({ model: "trusted-local", sandboxed: false })
    expect(loaded.modes).toEqual([{ name: "rush", description: "Fast plugin mode" }])
  })

  test("registers tools and commands without modifying core registries", async () => {
    const ui = memoryUi()
    const layer = hostLayer(
      [
        source("capabilities", (rika) => {
          rika.registerTool(
            "plugin_echo",
            { description: "Echo from a plugin", inputSchema: { type: "object" } },
            (toolCall) => ({
              echoed: toolCall.input,
            }),
          )
          rika.registerCommand("plugin.notify", { title: "Notify", category: "plugins" }, async (ctx) => {
            await ctx.ui.notify("plugin command ran")
          })
          rika.registerSubagent({
            name: "plugin-reader",
            description: "Read with a plugin prompt",
            prompt: "Read only.",
          })
        }),
      ],
      ui,
    )

    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const definitions = yield* PluginHost.toolDefinitions()
        const registryLayer = ToolRegistry.layerFromDefinitions(definitions)
        const toolOutput = yield* ToolRegistry.execute(call("plugin_echo", { text: "hello" })).pipe(
          Effect.provide(registryLayer),
        )
        const commands = yield* PluginHost.commands()
        yield* PluginHost.runCommand("plugin.notify")
        const subagents = yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.subagents))
        return { toolOutput, commands, subagents }
      }).pipe(Effect.provide(layer)),
    )

    expect(output.toolOutput).toEqual({ echoed: { text: "hello" } })
    expect(output.commands).toEqual([
      {
        name: "plugin.notify",
        descriptor: { title: "Notify", category: "plugins", availability: { type: "enabled" } },
      },
    ])
    expect(output.subagents).toEqual([
      { name: "plugin-reader", description: "Read with a plugin prompt", prompt: "Read only." },
    ])
    expect(ui.notifications).toEqual(["plugin command ran"])
  })

  test("rejects plugin tool input that violates the declared input schema", async () => {
    let executions = 0
    const layer = hostLayer([
      source("typed-tool", (rika) => {
        rika.registerTool(
          "plugin_typed",
          {
            description: "Typed plugin tool",
            inputSchema: {
              type: "object",
              required: ["text"],
              properties: { text: { type: "string" } },
              additionalProperties: false,
            },
          },
          () => {
            executions += 1
            return { ok: true }
          },
        )
      }),
    ])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const definitions = yield* PluginHost.toolDefinitions()
        const registryLayer = ToolRegistry.layerFromDefinitions(definitions)
        const invalid = yield* Effect.result(
          ToolRegistry.execute(call("plugin_typed", { text: 123 })).pipe(Effect.provide(registryLayer)),
        )
        const valid = yield* ToolRegistry.execute(call("plugin_typed", { text: "ok" })).pipe(
          Effect.provide(registryLayer),
        )
        return { invalid, valid }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.invalid._tag).toBe("Failure")
    if (result.invalid._tag === "Failure") {
      expect(result.invalid.failure.message).toContain("input does not match declared schema")
    }
    expect(result.valid).toEqual({ ok: true })
    expect(executions).toBe(1)
  })

  test("emits runtime hook logs through host state and Diagnostics", async () => {
    const diagnostics: Array<Diagnostics.Entry> = []
    const layer = hostLayer(
      [
        source("logger", (rika) => {
          rika.on("agent.start", (_event, ctx) => {
            ctx.logger.log("agent started")
          })
        }),
      ],
      memoryUi(),
      diagnostics,
    )

    const logs = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* PluginHost.Service
        yield* host.emitAgentStart({ thread_id: "thread_1", turn_id: "turn_1", message: "work" })
        return yield* host.logs
      }).pipe(Effect.provide(layer)),
    )

    expect(logs).toEqual(["[logger] agent started"])
    expect(diagnostics).toEqual([
      {
        level: "info",
        message: "plugin.log",
        data: {
          op: "plugin.log",
          plugin_name: "logger",
          plugin_path: ".rika/plugins/logger.ts",
          plugin_message: "agent started",
        },
      },
    ])
  })

  test("runs tool.call hooks through the PermissionPolicy path in registration order", async () => {
    const order: Array<string> = []
    const layer = hostLayer([
      source("observer", (rika) => {
        rika.on("tool.call", () => {
          order.push("observer")
        })
      }),
      source("guard", (rika) => {
        rika.on("tool.call", (event) => {
          order.push("guard")
          if (event.tool === "shell_command") return PermissionPolicy.reject("blocked by plugin")
          return undefined
        })
      }),
    ])

    const decision = await Effect.runPromise(
      PermissionPolicy.decide(call("shell_command", { command: "rm -rf /" })).pipe(
        Effect.provide(PluginHost.permissionPolicyLayer),
        Effect.provide(layer),
      ),
    )

    expect(order).toEqual(["observer", "guard"])
    expect(decision).toEqual({ action: "reject-and-continue", message: "blocked by plugin" })
  })

  test("defaults plugin policy to allow-all when no tool.call hook is registered", async () => {
    const layer = hostLayer([])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const mode = yield* PermissionPolicy.mode()
        const decision = yield* PermissionPolicy.decide(call("shell_command", { command: "printf ok" }))
        return { mode, decision }
      }).pipe(Effect.provide(PluginHost.permissionPolicyLayer), Effect.provide(layer)),
    )

    expect(result).toEqual({ mode: "allow-all", decision: PermissionPolicy.allow })
  })

  test("plugin tool.call hooks can modify and synthesize through ToolExecutor", async () => {
    const layer = hostLayer([
      source("rewrite", (rika) => {
        rika.on("tool.call", (event) => {
          if (event.tool === "fake_rewrite") return PermissionPolicy.modify({ text: "from plugin" })
          return undefined
        })
      }),
      source("synth", (rika) => {
        rika.on("tool.call", (event) => {
          if (event.tool !== "fake_synth") return undefined
          return PermissionPolicy.synthesize({
            id: event.call.id,
            name: event.call.name,
            status: "success",
            output: { synthesized: true },
          })
        })
      }),
    ])
    const executorLayer = ToolExecutor.layer.pipe(
      Layer.provideMerge(
        ToolRegistry.fakeLayer({
          fake_rewrite: (toolCall) => Effect.succeed({ input: toolCall.input }),
          fake_synth: () => Effect.succeed({ should_not: "run" }),
        }),
      ),
      Layer.provideMerge(PluginHost.permissionPolicyLayerFromConfig()),
      Layer.provideMerge(diagnosticsLayer()),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const modified = yield* ToolExecutor.execute(call("fake_rewrite", { text: "original" }))
        const synthesized = yield* ToolExecutor.execute(call("fake_synth", {}))
        return { modified, synthesized }
      }).pipe(Effect.provide(executorLayer), Effect.provide(layer)),
    )

    expect(result.modified).toMatchObject({
      status: "success",
      output: { input: { text: "from plugin" } },
      metadata: { permission_mode: "plugin", permission_action: "modify" },
    })
    expect(result.synthesized).toMatchObject({
      status: "success",
      output: { synthesized: true },
      metadata: { permission_mode: "plugin", permission_action: "synthesize" },
    })
  })

  test("observes tool results through the ToolExecutor boundary", async () => {
    const layer = hostLayer([
      source("annotator", (rika) => {
        rika.on("tool.result", (event) => ({
          ...event.result,
          output: { observed: true, original: event.result.output ?? null },
        }))
      }),
    ])
    const baseExecutorLayer = ToolExecutor.fakeLayer({ fake_tool: () => Effect.succeed({ original: true }) }).pipe(
      Layer.provideMerge(diagnosticsLayer()),
    )
    const executorLayer = PluginHost.toolResultExecutorLayer.pipe(
      Layer.provideMerge(baseExecutorLayer),
      Layer.provideMerge(layer),
    )

    const observed = await Effect.runPromise(
      ToolExecutor.execute(call("fake_tool", {})).pipe(Effect.provide(executorLayer)),
    )

    expect(observed).toMatchObject({
      name: "fake_tool",
      status: "success",
      output: { observed: true, original: { original: true } },
    })
  })

  test("emits lifecycle hooks and collects guarded agent continuations", async () => {
    const events: Array<string> = []
    const layer = hostLayer([
      source("events", (rika) => {
        rika.on("session.start", (event) => {
          events.push(`session:${event.thread.id}`)
        })
        rika.on("agent.start", (event) => {
          events.push(`start:${event.turn_id}`)
        })
        rika.on("agent.end", (event) => {
          events.push(`end:${event.turn_id}`)
          if (!event.message.includes("[plugin:verified]")) {
            return { action: "continue", userMessage: "[plugin:verified] Run verification." }
          }
          return undefined
        })
      }),
    ])

    const continues = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* PluginHost.Service
        yield* host.emitSessionStart({ thread: { id: "thread_1" } })
        yield* host.emitAgentStart({ thread_id: "thread_1", turn_id: "turn_1", message: "work" })
        return yield* host.emitAgentEnd({ thread_id: "thread_1", turn_id: "turn_1", message: "done" })
      }).pipe(Effect.provide(layer)),
    )

    expect(events).toEqual(["session:thread_1", "start:turn_1", "end:turn_1"])
    expect(continues).toEqual([{ action: "continue", userMessage: "[plugin:verified] Run verification." }])
  })
})
