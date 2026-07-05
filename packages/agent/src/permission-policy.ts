import { Config, EnvConfig } from "@rika/core"
import { Common, ErrorEnvelope, Tool } from "@rika/schema"
import { Config as EffectConfig, Context, Effect, Layer, Option, Schema } from "effect"
import { realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export const PermissionMode = Schema.Literals(["allow-all", "plugin", "configured"]).annotate({
  identifier: "Rika.Agent.PermissionPolicy.PermissionMode",
})
export type PermissionMode = typeof PermissionMode.Type

export interface PermissionConfig extends Schema.Schema.Type<typeof PermissionConfig> {}
export const PermissionConfig = Schema.Struct({
  mode: PermissionMode,
  guarded_tools: Schema.optional(Schema.Array(Schema.String)),
  guarded_files: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Rika.Agent.PermissionPolicy.PermissionConfig" })

export interface PermissionSummary extends Schema.Schema.Type<typeof PermissionSummary> {}
export const PermissionSummary = Schema.Struct({
  mode: PermissionMode,
  guarded_tools_configured: Schema.Boolean,
  guarded_files_configured: Schema.Boolean,
}).annotate({ identifier: "Rika.Agent.PermissionPolicy.PermissionSummary" })

export interface AllowDecision extends Schema.Schema.Type<typeof AllowDecision> {}
export const AllowDecision = Schema.Struct({
  action: Schema.Literal("allow"),
}).annotate({ identifier: "Rika.Agent.PermissionPolicy.AllowDecision" })

export interface RejectAndContinueDecision extends Schema.Schema.Type<typeof RejectAndContinueDecision> {}
export const RejectAndContinueDecision = Schema.Struct({
  action: Schema.Literal("reject-and-continue"),
  message: Schema.String,
  details: Schema.optional(Common.JsonValue),
}).annotate({ identifier: "Rika.Agent.PermissionPolicy.RejectAndContinueDecision" })

export interface ModifyDecision extends Schema.Schema.Type<typeof ModifyDecision> {}
export const ModifyDecision = Schema.Struct({
  action: Schema.Literal("modify"),
  input: Common.JsonValue,
}).annotate({ identifier: "Rika.Agent.PermissionPolicy.ModifyDecision" })

export interface SynthesizeDecision extends Schema.Schema.Type<typeof SynthesizeDecision> {}
export const SynthesizeDecision = Schema.Struct({
  action: Schema.Literal("synthesize"),
  result: Tool.Result,
}).annotate({ identifier: "Rika.Agent.PermissionPolicy.SynthesizeDecision" })

export type Decision = AllowDecision | RejectAndContinueDecision | ModifyDecision | SynthesizeDecision
export const Decision = Schema.Union([
  AllowDecision,
  RejectAndContinueDecision,
  ModifyDecision,
  SynthesizeDecision,
]).pipe(Schema.toTaggedUnion("action"), Schema.annotate({ identifier: "Rika.Agent.PermissionPolicy.Decision" }))

export class PermissionPolicyError extends Schema.TaggedErrorClass<PermissionPolicyError>()("PermissionPolicyError", {
  message: Schema.String,
  details: Schema.optional(Common.JsonValue),
}) {}

export interface Interface {
  readonly mode: Effect.Effect<PermissionMode>
  readonly decide: (call: Tool.Call) => Effect.Effect<Decision, PermissionPolicyError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/PermissionPolicy") {}

export type Decider = (call: Tool.Call) => Effect.Effect<Decision, PermissionPolicyError>

export interface DecideOptions {
  readonly workspace_root?: string
}

export const allow: Decision = { action: "allow" }

export const defaultGuardedFiles = [".rika/plugins/**", "*/.rika/plugins/**"] as const

export const defaultConfig: PermissionConfig = { mode: "allow-all", guarded_files: [...defaultGuardedFiles] }

export const reject = (message: string, details?: Common.JsonValue): Decision => ({
  action: "reject-and-continue",
  message,
  ...(details === undefined ? {} : { details }),
})

export const modify = (input: Common.JsonValue): Decision => ({ action: "modify", input })

export const synthesize = (result: Tool.Result): Decision => ({ action: "synthesize", result })

export const layerFromDecider = (decider: Decider, mode: PermissionMode = "configured") =>
  Layer.succeed(
    Service,
    Service.of({
      mode: Effect.succeed(mode),
      decide: Effect.fn("PermissionPolicy.decide")(function* (call: Tool.Call) {
        return yield* decider(call)
      }),
    }),
  )

export const layerFromConfig = (config: PermissionConfig = defaultConfig) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const configService = yield* Effect.serviceOption(Config.Service)
      const values = Option.isSome(configService) ? yield* configService.value.get : undefined
      const options = values === undefined ? {} : { workspace_root: values.workspace_root }
      return Service.of({
        mode: Effect.succeed(config.mode),
        decide: Effect.fn("PermissionPolicy.decide.configured")(function* (call: Tool.Call) {
          return yield* decideFromConfig(config, call, options)
        }),
      })
    }),
  )

export const allowLayer = layerFromDecider(() => Effect.succeed(allow), "allow-all")

export const rejectLayer = (message: string, details?: Common.JsonValue) =>
  layerFromDecider(() => Effect.succeed(reject(message, details)), "configured")

export const configFromEnv = (env: Record<string, string | undefined>): PermissionConfig => {
  const guardedTools = csv(env.RIKA_GUARDED_TOOLS ?? env.RIKA_PERMISSION_GUARDED_TOOLS)
  const configuredGuardedFiles = csv(env.RIKA_GUARDED_FILES ?? env.RIKA_PERMISSION_GUARDED_FILES)
  const guardedFiles = unique([...defaultGuardedFiles, ...configuredGuardedFiles])
  const requestedMode = EnvConfig.optionalSync(
    EnvConfig.providerFromEnv(env),
    EffectConfig.literals(["allow-all", "plugin", "configured"], "RIKA_PERMISSION_MODE"),
  )
  const hasConfiguredGuards = guardedTools.length > 0 || configuredGuardedFiles.length > 0
  const mode = requestedMode ?? (hasConfiguredGuards ? "configured" : "allow-all")

  return compactConfig({
    mode,
    guarded_tools: guardedTools,
    guarded_files: guardedFiles,
  })
}

export const summary = (config: PermissionConfig): PermissionSummary => ({
  mode: config.mode,
  guarded_tools_configured: (config.guarded_tools?.length ?? 0) > 0,
  guarded_files_configured: (config.guarded_files?.length ?? 0) > 0,
})

export const decideFromConfig = (
  config: PermissionConfig,
  call: Tool.Call,
  options: DecideOptions = {},
): Effect.Effect<Decision, PermissionPolicyError> =>
  Effect.gen(function* () {
    const fileMatch = yield* firstGuardedFileMatch(config.guarded_files ?? [], call.input, options)
    if (fileMatch !== undefined) {
      return reject(`File ${fileMatch.path} is guarded by permission policy`, {
        permission_mode: config.mode,
        matched: "file",
        path: fileMatch.path,
        pattern: fileMatch.pattern,
      })
    }

    if (config.mode !== "configured") return allow

    const toolPattern = firstMatchingToolPattern(config.guarded_tools ?? [], call.name)
    if (toolPattern !== undefined) {
      return reject(`Tool ${call.name} is guarded by permission policy`, {
        permission_mode: "configured",
        matched: "tool",
        tool: call.name,
        pattern: toolPattern,
      })
    }

    return allow
  })

export const decide = Effect.fn("PermissionPolicy.decide.call")(function* (call: Tool.Call) {
  const policy = yield* Service
  return yield* policy.decide(call)
})

export const mode = Effect.fn("PermissionPolicy.mode.call")(function* () {
  const policy = yield* Service
  return yield* policy.mode
})

export const errorEnvelope = (error: PermissionPolicyError): ErrorEnvelope.Envelope => ({
  kind: "permission",
  message: error.message,
  ...(error.details === undefined ? {} : { details: error.details }),
})

const compactConfig = (input: {
  readonly mode: PermissionMode
  readonly guarded_tools: ReadonlyArray<string>
  readonly guarded_files: ReadonlyArray<string>
}): PermissionConfig => ({
  mode: input.mode,
  ...(input.guarded_tools.length === 0 ? {} : { guarded_tools: input.guarded_tools }),
  ...(input.guarded_files.length === 0 ? {} : { guarded_files: input.guarded_files }),
})

const csv = (value: string | undefined): ReadonlyArray<string> =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)]

const firstMatchingPattern = (patterns: ReadonlyArray<string>, value: string): string | undefined =>
  patterns.find((pattern) => matchesPattern(pattern, value))

const firstMatchingToolPattern = (patterns: ReadonlyArray<string>, value: string): string | undefined =>
  patterns.find((pattern) => matchesPattern(pattern, value) || matchesPattern(pattern, toolNamespaceAlias(value)))

const toolNamespaceAlias = (value: string) => value.replaceAll("_", ".").replaceAll("-", ".")

const firstGuardedFileMatch = (
  patterns: ReadonlyArray<string>,
  input: Common.JsonValue,
  options: DecideOptions,
): Effect.Effect<{ readonly path: string; readonly pattern: string } | undefined> =>
  Effect.promise(async () => {
    for (const candidate of filePathCandidates(input)) {
      const paths = await guardedPathForms(candidate, options.workspace_root)
      for (const path of paths) {
        const pattern = firstMatchingPattern(patterns, path)
        if (pattern !== undefined) return { path, pattern }
      }
    }
    return undefined
  })

const filePathCandidates = (value: Common.JsonValue): ReadonlyArray<string> =>
  collectFilePathCandidates(value, undefined)

const collectFilePathCandidates = (value: unknown, key: string | undefined): ReadonlyArray<string> => {
  if (typeof value === "string") return isPathCandidate(value) || (key !== undefined && isPathKey(key)) ? [value] : []
  if (Array.isArray(value)) return value.flatMap((item) => collectFilePathCandidates(item, key))
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([entryKey, entryValue]) => collectFilePathCandidates(entryValue, entryKey))
  }
  return []
}

const isPathKey = (key: string) => {
  const normalized = key.replaceAll("-", "_").toLowerCase()
  const compact = normalized.replaceAll("_", "")
  return (
    normalized === "path" ||
    normalized === "file" ||
    normalized === "destination" ||
    normalized === "dest" ||
    normalized === "target" ||
    normalized === "to" ||
    normalized === "output" ||
    normalized === "out" ||
    compact === "filepath" ||
    compact === "absolutepath" ||
    compact === "relativepath" ||
    compact === "targetpath" ||
    compact === "destinationpath" ||
    compact === "outputpath"
  )
}

const isPathCandidate = (value: string) => {
  const trimmed = value.trim()
  return trimmed.length > 0 && (trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith("."))
}

const guardedPathForms = async (
  candidate: string,
  workspaceRoot: string | undefined,
): Promise<ReadonlyArray<string>> => {
  const forms = [normalizePath(candidate)]
  if (workspaceRoot === undefined) return unique(forms)
  const root = resolve(workspaceRoot)
  const rootReal = await realpathExistingPrefix(root)
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate)
  forms.push(normalizePath(absolute), ...relativeForms(root, absolute))
  const resolved = await realpathExistingPrefix(absolute)
  forms.push(...relativeForms(root, resolved), ...relativeForms(rootReal, resolved), normalizePath(resolved))
  return unique(forms)
}

const realpathExistingPrefix = async (path: string): Promise<string> => {
  let current = path
  const suffix: Array<string> = []
  while (true) {
    try {
      const resolved = await realpath(current)
      return suffix.reduce((accumulator, part) => join(accumulator, part), resolved)
    } catch {}
    const parent = dirname(current)
    if (parent === current) return path
    suffix.unshift(basename(current))
    current = parent
  }
}

const relativeForms = (root: string, path: string): ReadonlyArray<string> => {
  const form = relativeInside(root, path)
  if (form === undefined) return []
  return [form]
}

const relativeInside = (root: string, path: string): string | undefined => {
  const next = relative(root, path)
  if (next.length === 0) return "."
  if (next.startsWith("..") || isAbsolute(next)) return undefined
  return normalizePath(next)
}

const normalizePath = (value: string) => value.split(sep).join("/").replaceAll("\\", "/")

const matchesPattern = (pattern: string, value: string) => {
  if (pattern === value) return true
  if (!pattern.includes("*")) return false
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(value)
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
