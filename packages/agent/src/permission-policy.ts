import { Common, ErrorEnvelope, Tool } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"

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

export const allow: Decision = { action: "allow" }

export const defaultConfig: PermissionConfig = { mode: "allow-all" }

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
  Layer.succeed(
    Service,
    Service.of({
      mode: Effect.succeed(config.mode),
      decide: Effect.fn("PermissionPolicy.decide.configured")(function* (call: Tool.Call) {
        return yield* decideFromConfig(config, call)
      }),
    }),
  )

export const allowLayer = layerFromDecider(() => Effect.succeed(allow), "allow-all")

export const rejectLayer = (message: string, details?: Common.JsonValue) =>
  layerFromDecider(() => Effect.succeed(reject(message, details)), "configured")

export const configFromEnv = (env: Record<string, string | undefined>): PermissionConfig => {
  const guardedTools = csv(env.RIKA_GUARDED_TOOLS ?? env.RIKA_PERMISSION_GUARDED_TOOLS)
  const guardedFiles = csv(env.RIKA_GUARDED_FILES ?? env.RIKA_PERMISSION_GUARDED_FILES)
  const requestedMode = parsePermissionMode(env.RIKA_PERMISSION_MODE)
  const hasGuards = guardedTools.length > 0 || guardedFiles.length > 0
  const mode = requestedMode ?? (hasGuards ? "configured" : "allow-all")

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
): Effect.Effect<Decision, PermissionPolicyError> =>
  Effect.sync(() => {
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

    const fileMatch = firstGuardedFileMatch(config.guarded_files ?? [], call.input)
    if (fileMatch !== undefined) {
      return reject(`File ${fileMatch.path} is guarded by permission policy`, {
        permission_mode: "configured",
        matched: "file",
        path: fileMatch.path,
        pattern: fileMatch.pattern,
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

const parsePermissionMode = (value: string | undefined): PermissionMode | undefined => {
  if (value === "allow-all" || value === "plugin" || value === "configured") return value
  return undefined
}

const csv = (value: string | undefined): ReadonlyArray<string> =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)

const firstMatchingPattern = (patterns: ReadonlyArray<string>, value: string): string | undefined =>
  patterns.find((pattern) => matchesPattern(pattern, value))

const firstMatchingToolPattern = (patterns: ReadonlyArray<string>, value: string): string | undefined =>
  patterns.find((pattern) => matchesPattern(pattern, value) || matchesPattern(pattern, toolNamespaceAlias(value)))

const toolNamespaceAlias = (value: string) => value.replaceAll("_", ".").replaceAll("-", ".")

const firstGuardedFileMatch = (
  patterns: ReadonlyArray<string>,
  input: Common.JsonValue,
): { readonly path: string; readonly pattern: string } | undefined => {
  for (const path of filePathCandidates(input)) {
    const pattern = firstMatchingPattern(patterns, path)
    if (pattern !== undefined) return { path, pattern }
  }
  return undefined
}

const filePathCandidates = (value: Common.JsonValue): ReadonlyArray<string> =>
  collectFilePathCandidates(value, undefined)

const collectFilePathCandidates = (value: unknown, key: string | undefined): ReadonlyArray<string> => {
  if (typeof value === "string") return key !== undefined && isPathKey(key) ? [value] : []
  if (Array.isArray(value)) return value.flatMap((item) => collectFilePathCandidates(item, key))
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([entryKey, entryValue]) => collectFilePathCandidates(entryValue, entryKey))
  }
  return []
}

const isPathKey = (key: string) =>
  key === "path" ||
  key === "file" ||
  key === "filepath" ||
  key === "file_path" ||
  key === "absolute_path" ||
  key === "relative_path" ||
  key === "target_path"

const matchesPattern = (pattern: string, value: string) => {
  if (pattern === value) return true
  if (!pattern.includes("*")) return false
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(value)
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
