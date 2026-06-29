import { execFile } from "node:child_process"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { ToolRegistry } from "@rika/agent"
import { Config } from "@rika/core"
import { Common } from "@rika/schema"
import type { Call } from "@rika/schema/tool"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

const execFileAsync = promisify(execFile)
const defaultMaxOutputChars = 30_000
const maxProcessBufferBytes = 16 * 1024 * 1024
const defaultTimeoutMs = 10_000

export const Items = Schema.Literals(["auto", "structure", "exports", "imports", "all"]).annotate({
  identifier: "Rika.Tools.AstGrepOutline.Items",
})
export type Items = typeof Items.Type

export const View = Schema.Literals(["auto", "names", "signatures", "digest", "expanded"]).annotate({
  identifier: "Rika.Tools.AstGrepOutline.View",
})
export type View = typeof View.Type

export const JsonStyle = Schema.Literals(["pretty", "stream", "compact"]).annotate({
  identifier: "Rika.Tools.AstGrepOutline.JsonStyle",
})
export type JsonStyle = typeof JsonStyle.Type

export const NoIgnore = Schema.Literals(["hidden", "dot", "exclude", "global", "parent", "vcs"]).annotate({
  identifier: "Rika.Tools.AstGrepOutline.NoIgnore",
})
export type NoIgnore = typeof NoIgnore.Type

const StringOrStringArray = Schema.Union([Schema.String, Schema.Array(Schema.String)])
const JsonInput = Schema.Union([Schema.Boolean, JsonStyle])
const NoIgnoreInput = Schema.Union([NoIgnore, Schema.Array(NoIgnore)])

export interface OutlineInput extends Schema.Schema.Type<typeof OutlineInput> {}
export const OutlineInput = Schema.Struct({
  paths: Schema.optionalKey(StringOrStringArray),
  items: Schema.optionalKey(Items),
  view: Schema.optionalKey(View),
  match: Schema.optionalKey(Schema.String),
  types: Schema.optionalKey(StringOrStringArray),
  lang: Schema.optionalKey(Schema.String),
  pubMembers: Schema.optionalKey(Schema.Boolean),
  json: Schema.optionalKey(JsonInput),
  globs: Schema.optionalKey(StringOrStringArray),
  config: Schema.optionalKey(Schema.String),
  outlineRules: Schema.optionalKey(Schema.String),
  noDefaultOutlineRules: Schema.optionalKey(Schema.Boolean),
  noIgnore: Schema.optionalKey(NoIgnoreInput),
  follow: Schema.optionalKey(Schema.Boolean),
  maxOutputChars: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "Rika.Tools.AstGrepOutline.OutlineInput" })

export class AstGrepOutlineError extends Schema.TaggedErrorClass<AstGrepOutlineError>()("AstGrepOutlineError", {
  message: Schema.String,
  code: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
  details: Schema.optional(Common.JsonValue),
}) {}

export interface Interface {
  readonly outline: (input: OutlineInput) => Effect.Effect<Common.JsonValue, AstGrepOutlineError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/AstGrepOutline") {}

export interface CommandResult {
  readonly stdout: string
  readonly stderr: string
}

export interface CommandRunner {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ) => Effect.Effect<CommandResult, AstGrepOutlineError>
}

export function layerFromRunner(runner: CommandRunner): Layer.Layer<Service, never, Config.Service> {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const values = yield* config.get
      const workspaceRoot = resolve(values.workspace_root)
      return makeService(workspaceRoot, runner)
    }),
  )
}

export const fakeLayer = (runner: CommandRunner) => layerFromRunner(runner)

export const outline = Effect.fn("AstGrepOutline.outline.call")(function* (input: OutlineInput) {
  const service = yield* Service
  return yield* service.outline(input)
})

export const toolDefinitions = (service: Interface): ReadonlyArray<ToolRegistry.Definition> => [
  {
    tool: Tool.make("ast_grep_outline", {
      description: [
        "Run `ast-grep outline` for a fast, local, AST-backed table of contents before reading full source.",
        "Use after fff/search has identified candidate files or directories and you need shape: exports, imports, classes, functions, structs, interfaces, methods, fields, and source ranges.",
        "Prefer it over opening whole large files when deciding which symbol or line range to read next. It has no index, no type resolution, and no cross-file semantics.",
        "Default behavior mirrors ast-grep: file inputs show local structure with member digest, directory inputs show exported surface with grouped names. Narrow with items, view, match, types, or globs before reading source.",
      ].join(" "),
      parameters: OutlineInput,
      success: Schema.Json,
      failure: Schema.Json,
      failureMode: "return",
    }),
    execute: Effect.fn("AstGrepOutline.tool.outline")(function* (call: Call) {
      const input = yield* decodeOutlineInput(call)
      return yield* service.outline(input).pipe(Effect.mapError(toRegistryError("ast_grep_outline")))
    }),
  },
]

export const registryLayerFromService: Layer.Layer<ToolRegistry.Service, never, Service> = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const service = yield* Service
    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(toolDefinitions(service))))
  }),
)

const makeService = (workspaceRoot: string, runner: CommandRunner): Interface =>
  Service.of({
    outline: Effect.fn("AstGrepOutline.outline")(function* (input: OutlineInput) {
      const binary = yield* findAstGrep(runner, workspaceRoot)
      const args = yield* outlineArgs(workspaceRoot, input)
      const result = yield* runner.run(binary, args, workspaceRoot)
      const rawOutput = result.stdout.trim() || result.stderr.trim() || "No outline entries found."
      const limit = outputLimit(input.maxOutputChars)
      const capped = truncate(rawOutput, limit)
      return yield* jsonValue({
        type: "ast_grep_outline",
        binary,
        args,
        content: capped.output,
        truncated: capped.truncated,
        max_output_chars: limit,
      })
    }),
  })

const findAstGrep = (runner: CommandRunner, workspaceRoot: string) =>
  Effect.gen(function* () {
    for (const candidate of ["ast-grep", "sg"] as const) {
      const available = yield* runner.run(candidate, ["--version"], workspaceRoot).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: () => true,
        }),
      )
      if (available) return candidate
    }
    return yield* new AstGrepOutlineError({
      message: "ast-grep is not installed. Install ast-grep 0.44.0 or newer to use outline.",
      code: "E_AST_GREP_UNAVAILABLE",
      retryable: false,
    })
  })

const outlineArgs = (workspaceRoot: string, input: OutlineInput) =>
  Effect.gen(function* () {
    const args: Array<string> = ["outline", "--color", "never"]

    if (input.items !== undefined) args.push("--items", input.items)
    if (input.view !== undefined) args.push("--view", input.view)
    if (hasText(input.lang)) args.push("--lang", input.lang.trim())
    if (hasText(input.match)) args.push("--match", input.match.trim())

    const selectedTypes = stringArray(input.types)
    if (selectedTypes.length > 0) args.push("--type", selectedTypes.join(","))

    if (input.pubMembers === true) args.push("--pub-members")

    if (input.json === true) {
      args.push("--json")
    } else if (typeof input.json === "string") {
      args.push(`--json=${input.json}`)
    }

    if (hasText(input.config)) {
      yield* assertInsideWorkspace(workspaceRoot, input.config.trim(), "config")
      args.push("--config", input.config.trim())
    }

    if (hasText(input.outlineRules)) {
      yield* assertInsideWorkspace(workspaceRoot, input.outlineRules.trim(), "outlineRules")
      args.push("--outline-rules", input.outlineRules.trim())
    }

    if (input.noDefaultOutlineRules === true) args.push("--no-default-outline-rules")
    if (input.follow === true) args.push("--follow")

    for (const value of noIgnoreArray(input.noIgnore)) args.push("--no-ignore", value)
    for (const glob of stringArray(input.globs)) args.push("--globs", glob)

    const paths = stringArray(input.paths)
    for (const path of paths.length > 0 ? paths : ["."]) {
      yield* assertInsideWorkspace(workspaceRoot, path, "path")
      args.push(path)
    }

    return args
  })

const liveRunner: CommandRunner = {
  run: Effect.fn("AstGrepOutline.liveRunner.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ) {
    const result = yield* Effect.tryPromise({
      try: () =>
        execFileAsync(command, [...args], {
          cwd,
          encoding: "utf8",
          maxBuffer: maxProcessBufferBytes,
          timeout: defaultTimeoutMs,
        }),
      catch: (cause) => commandError(command, args, cause),
    })
    return { stdout: result.stdout, stderr: result.stderr }
  }),
}

export const layer: Layer.Layer<Service, never, Config.Service> = layerFromRunner(liveRunner)

const aliasField = (call: Call, from: string, to: string): Call => {
  const input = call.input
  if (typeof input !== "object" || input === null || Array.isArray(input)) return call
  const entries = Object.entries(input)
  const source = entries.find(([key]) => key === from)
  if (source === undefined || entries.some(([key]) => key === to)) return call
  const decoded = Schema.decodeUnknownOption(Common.JsonValue)(Object.fromEntries([...entries, [to, source[1]]]))
  if (Option.isNone(decoded)) return call
  return { ...call, input: decoded.value }
}

const decodeOutlineInput = (call: Call) => {
  const decoded = Schema.decodeUnknownOption(OutlineInput)(aliasField(call, "path", "paths").input)
  if (Option.isSome(decoded)) return Effect.succeed(decoded.value)
  return new ToolRegistry.ToolRegistryError({
    message: `${call.name} input did not match the tool schema`,
    name: call.name,
    retryable: false,
  })
}

const assertInsideWorkspace = (workspaceRoot: string, path: string, label: string) =>
  Effect.try({
    try: () => {
      if (path.startsWith("-")) throw new Error(`${label} must be a path, not an option: ${path}`)
      const absolute = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path)
      const rel = relative(workspaceRoot, absolute)
      if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return
      throw new Error(`${label} must stay inside the workspace root: ${path}`)
    },
    catch: (cause) =>
      new AstGrepOutlineError({
        message: cause instanceof Error ? cause.message : String(cause),
        code: "E_PATH_OUTSIDE_WORKSPACE",
        retryable: false,
      }),
  })

const commandError = (command: string, args: ReadonlyArray<string>, cause: unknown) =>
  new AstGrepOutlineError({
    message: `${command} ${args.join(" ")} failed: ${errorText(cause)}`,
    code: "E_COMMAND_FAILED",
    retryable: true,
    details: commandDetails(command, args, cause),
  })

const commandDetails = (command: string, args: ReadonlyArray<string>, cause: unknown): Common.JsonValue => {
  const stdout = processText(cause, "stdout")
  const stderr = processText(cause, "stderr")
  return {
    command,
    args: [...args],
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  }
}

const errorText = (cause: unknown) => {
  const stderr = processText(cause, "stderr")
  if (stderr !== undefined) return stderr
  const stdout = processText(cause, "stdout")
  if (stdout !== undefined) return stdout
  return cause instanceof Error ? cause.message : String(cause)
}

const processText = (cause: unknown, key: "stdout" | "stderr") => {
  if (typeof cause !== "object" || cause === null) return undefined
  const value = Reflect.get(cause, key)
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

const stringArray = (value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()]
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 20)
}

const noIgnoreArray = (value: NoIgnore | ReadonlyArray<NoIgnore> | undefined): ReadonlyArray<NoIgnore> => {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return [...new Set(value)].slice(0, 6)
}

const hasText = (value: string | undefined): value is string => typeof value === "string" && value.trim().length > 0

const outputLimit = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value)) return defaultMaxOutputChars
  return clamp(value, 2_000, 80_000)
}

const truncate = (output: string, limit: number) => {
  if (output.length <= limit) return { output, truncated: false }
  return {
    output: `${output.slice(0, limit)}\n\n[ast_grep_outline: output truncated at ${limit} characters. Narrow with paths, match, items, view, types, or globs before reading full source.]`,
    truncated: true,
  }
}

const jsonValue = (value: unknown) =>
  Effect.gen(function* () {
    const normalized = yield* Effect.try({
      try: () => {
        const text = JSON.stringify(value)
        if (text === undefined) throw new Error("JSON.stringify returned undefined")
        return JSON.parse(text)
      },
      catch: (cause) =>
        new AstGrepOutlineError({
          message: cause instanceof Error ? cause.message : "Tool output was not JSON serializable",
          code: "E_JSON_OUTPUT",
          retryable: false,
        }),
    })
    const decoded = Schema.decodeUnknownOption(Common.JsonValue)(normalized)
    if (Option.isSome(decoded)) return decoded.value
    return yield* new AstGrepOutlineError({
      message: "Tool output was not JSON serializable",
      code: "E_JSON_OUTPUT",
      retryable: false,
    })
  })

const toRegistryError = (name: string) => (error: AstGrepOutlineError) =>
  new ToolRegistry.ToolRegistryError({
    message: error.message,
    name,
    retryable: error.retryable ?? false,
    details: {
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  })

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.floor(value), min), max)
