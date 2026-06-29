import { Config } from "@rika/core"
import { Common } from "@rika/schema"
import type { Call } from "@rika/schema/tool"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

export interface Descriptor extends Schema.Schema.Type<typeof Descriptor> {}
export const Descriptor = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
}).annotate({ identifier: "Rika.Agent.ToolRegistry.Descriptor" })

export class ToolRegistryError extends Schema.TaggedErrorClass<ToolRegistryError>()("ToolRegistryError", {
  message: Schema.String,
  name: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  details: Schema.optional(Common.JsonValue),
}) {}

export interface Definition {
  readonly tool: Tool.Any
  readonly execute: (call: Call) => Effect.Effect<Common.JsonValue, ToolRegistryError>
}

export interface Interface {
  readonly tools: Effect.Effect<ReadonlyArray<Tool.Any>>
  readonly describe: Effect.Effect<ReadonlyArray<Descriptor>>
  readonly execute: (call: Call) => Effect.Effect<Common.JsonValue, ToolRegistryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/ToolRegistry") {}

export type FakeHandler = (call: Call) => Effect.Effect<Common.JsonValue, ToolRegistryError>

export const layerFromDefinitions = (definitions: ReadonlyArray<Definition>) => {
  const byName: Record<string, Definition | undefined> = {}
  for (const definition of definitions) {
    byName[definition.tool.name] = definition
  }
  const executeDefinition = (call: Call): Effect.Effect<Common.JsonValue, ToolRegistryError> =>
    Effect.gen(function* () {
      const definition = byName[call.name]
      if (definition === undefined) {
        return yield* new ToolRegistryError({ message: `No tool named ${call.name} is registered`, name: call.name })
      }
      return yield* definition.execute(call)
    })
  return Layer.succeed(
    Service,
    Service.of({
      tools: Effect.succeed(definitions.map((definition) => definition.tool)),
      describe: Effect.succeed(definitions.map((definition) => descriptorFromTool(definition.tool))),
      execute: executeDefinition,
    }),
  )
}

export const emptyLayer = layerFromDefinitions([])

export const fakeLayer = (
  handlers: Readonly<Record<string, FakeHandler>>,
  tools: ReadonlyArray<Tool.Any> = toolsFromHandlers(handlers),
) =>
  layerFromDefinitions(
    tools.map((tool) => ({
      tool,
      execute: Effect.fn(`ToolRegistry.fake.${tool.name}`)(function* (call: Call) {
        const handler = handlers[tool.name]
        if (handler === undefined) {
          return yield* new ToolRegistryError({
            message: `No fake tool named ${call.name} is registered`,
            name: call.name,
          })
        }
        return yield* handler(call)
      }),
    })),
  )

export const shellDefinitions = (workspaceRoot: string): ReadonlyArray<Definition> => [shellDefinition(workspaceRoot)]

export const shellLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    return yield* Service.pipe(Effect.provide(layerFromDefinitions(shellDefinitions(values.workspace_root))))
  }),
)

export const describe = Effect.fn("ToolRegistry.describe.call")(function* () {
  const registry = yield* Service
  return yield* registry.describe
})

export const tools = Effect.fn("ToolRegistry.tools.call")(function* () {
  const registry = yield* Service
  return yield* registry.tools
})

export const execute = Effect.fn("ToolRegistry.execute.call")(function* (call: Call) {
  const registry = yield* Service
  return yield* registry.execute(call)
})

export interface ShellInput extends Schema.Schema.Type<typeof ShellInput> {}
export const ShellInput = Schema.Struct({
  command: Schema.String,
  timeout_ms: Schema.optionalKey(Schema.Int),
  max_output_bytes: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Agent.ToolRegistry.ShellInput" })

const shellDefinition = (workspaceRoot: string): Definition => ({
  tool: Tool.make("shell_command", {
    description: "Run a shell command in the current workspace and return capped stdout/stderr.",
    parameters: ShellInput,
    success: Schema.Json,
    failure: Schema.Json,
    failureMode: "return",
  }),
  execute: Effect.fn("ToolRegistry.shell.execute")(function* (call: Call) {
    const decoded = Schema.decodeUnknownOption(ShellInput)(call.input)
    if (Option.isNone(decoded)) {
      return yield* new ToolRegistryError({
        message: "shell_command input must include a string command",
        name: call.name,
        retryable: false,
      })
    }

    const timeoutMs = clamp(decoded.value.timeout_ms ?? 10_000, 1, 60_000)
    const maxOutputBytes = clamp(decoded.value.max_output_bytes ?? 20_000, 1, 100_000)
    const output = yield* Effect.tryPromise({
      try: () => runShell(decoded.value.command, workspaceRoot, timeoutMs, maxOutputBytes),
      catch: (cause) =>
        new ToolRegistryError({
          message: cause instanceof Error ? cause.message : String(cause),
          name: call.name,
          retryable: false,
        }),
    })

    if (output.timed_out) {
      const details = shellOutputToJson(output)
      return yield* new ToolRegistryError({
        message: `Shell command timed out after ${timeoutMs}ms`,
        name: call.name,
        retryable: true,
        details,
      })
    }

    if (output.exit_code !== 0) {
      const details = shellOutputToJson(output)
      return yield* new ToolRegistryError({
        message: `Shell command exited with code ${output.exit_code}`,
        name: call.name,
        retryable: false,
        details,
      })
    }

    return shellOutputToJson(output)
  }),
})

interface ShellOutput {
  readonly exit_code: number
  readonly stdout: string
  readonly stderr: string
  readonly stdout_truncated: boolean
  readonly stderr_truncated: boolean
  readonly timed_out: boolean
}

const runShell = async (
  command: string,
  workspaceRoot: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<ShellOutput> => {
  let timedOut = false
  const process = Bun.spawn(["/bin/sh", "-lc", command], {
    cwd: workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => {
    timedOut = true
    process.kill("SIGKILL")
  }, timeoutMs)

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    const cappedStdout = capOutput(stdout, maxOutputBytes)
    const cappedStderr = capOutput(stderr, maxOutputBytes)
    return {
      exit_code: exitCode,
      stdout: cappedStdout.text,
      stderr: cappedStderr.text,
      stdout_truncated: cappedStdout.truncated,
      stderr_truncated: cappedStderr.truncated,
      timed_out: timedOut,
    }
  } finally {
    clearTimeout(timeout)
  }
}

const capOutput = (text: string, maxBytes: number) => {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= maxBytes) return { text, truncated: false }
  return { text: new TextDecoder().decode(encoded.slice(0, maxBytes)), truncated: true }
}

const shellOutputToJson = (output: ShellOutput): Common.JsonValue => ({
  exit_code: output.exit_code,
  stdout: output.stdout,
  stderr: output.stderr,
  stdout_truncated: output.stdout_truncated,
  stderr_truncated: output.stderr_truncated,
  timed_out: output.timed_out,
})

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export const descriptorFromTool = (tool: Tool.Any): Descriptor => ({
  name: tool.name,
  description: Tool.getDescription(tool) ?? `Tool ${tool.name}`,
})

const toolsFromHandlers = (handlers: Readonly<Record<string, FakeHandler>>): ReadonlyArray<Tool.Any> =>
  Object.keys(handlers).map((name) =>
    Tool.make(name, {
      description: `Fake tool ${name}`,
      parameters: Schema.Record(Schema.String, Schema.Json),
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
  )
