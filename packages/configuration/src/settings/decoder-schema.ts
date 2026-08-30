import { Schema } from "effect"

export const UnknownObject = Schema.Record(Schema.String, Schema.Unknown)
export type Decoded = typeof Schema.Unknown.Type
export type UnknownObject = Readonly<Record<string, Decoded>>

export function isObject(input: Decoded): input is UnknownObject {
  return Schema.is(UnknownObject)(input)
}
export function isString(input: Decoded): input is string {
  return Schema.is(Schema.String)(input)
}
export function isNumber(input: Decoded): input is number {
  return Schema.is(Schema.Finite)(input)
}
export function isBoolean(input: Decoded): input is boolean {
  return Schema.is(Schema.Boolean)(input)
}
const StringArray = Schema.Array(Schema.String)
export function isStringArray(input: Decoded): input is ReadonlyArray<string> {
  return Schema.is(StringArray)(input)
}
const ProviderId = Schema.Union([
  Schema.Literal("openai"),
  Schema.Literal("anthropic"),
  Schema.Literal("bedrock"),
  Schema.Literal("openrouter"),
])
const Effort = Schema.Union([
  Schema.Literal("low"),
  Schema.Literal("medium"),
  Schema.Literal("high"),
  Schema.Literal("xhigh"),
  Schema.Literal("max"),
])
export type ProviderId = typeof ProviderId.Type
export function isProviderId(input: Decoded): input is ProviderId {
  return Schema.is(ProviderId)(input)
}

const StringMap = Schema.Record(Schema.String, Schema.String)
const Variant = Schema.Struct({ options: Schema.JsonObject })
const EffortVariants = Schema.Struct({ normal: Variant, fast: Schema.optionalKey(Variant) })
const ModelAlias = Schema.Struct({
  preset: Schema.optionalKey(Schema.String),
  provider: ProviderId,
  candidates: StringArray,
  displayName: Schema.optionalKey(Schema.String),
  supportsMedia: Schema.optionalKey(Schema.Boolean),
  limits: Schema.optionalKey(
    Schema.Struct({
      contextWindow: Schema.optionalKey(Schema.Finite),
      maxInputTokens: Schema.Finite,
      maxOutputTokens: Schema.Finite,
      keepRecentTokens: Schema.Finite,
    }),
  ),
  efforts: Schema.optionalKey(Schema.Record(Schema.String, EffortVariants)),
})
const AliasRoute = Schema.Struct({
  alias: Schema.String,
  effort: Schema.optionalKey(Effort),
  fast: Schema.optionalKey(Schema.Boolean),
})
const DirectRoute = Schema.Struct({
  model: Schema.String,
  provider: ProviderId,
  effort: Schema.optionalKey(Effort),
  fast: Schema.optionalKey(Schema.Boolean),
})
const RoleRoute = Schema.Union([AliasRoute, DirectRoute])
const Agents = Schema.Struct({
  librarian: Schema.optionalKey(RoleRoute),
  painter: Schema.optionalKey(RoleRoute),
  readThread: Schema.optionalKey(RoleRoute),
  review: Schema.optionalKey(RoleRoute),
  surgeon: Schema.optionalKey(RoleRoute),
  task: Schema.optionalKey(RoleRoute),
})
const Mode = Schema.Struct({
  main: Schema.optionalKey(RoleRoute),
  oracle: Schema.optionalKey(RoleRoute),
  agents: Schema.optionalKey(Agents),
})
const McpCommand = Schema.Struct({
  transport: Schema.Literal("command"),
  command: Schema.String,
  args: StringArray,
  cwd: Schema.optionalKey(Schema.String),
  environment: StringMap,
  enabled: Schema.Boolean,
})
const McpRemote = Schema.Struct({
  transport: Schema.Literal("remote"),
  url: Schema.String,
  headers: StringMap,
  enabled: Schema.Boolean,
})
const HttpProviderOverride = Schema.Struct({
  baseUrl: Schema.optionalKey(Schema.String),
  apiKeyEnv: Schema.optionalKey(Schema.String),
  credentialIdentity: Schema.optionalKey(Schema.String),
  streamingOnly: Schema.optionalKey(Schema.Boolean),
  promptCaching: Schema.optionalKey(Schema.Boolean),
  api: Schema.optionalKey(Schema.Union([Schema.Literal("responses"), Schema.Literal("chat-completions")])),
})
const BedrockProviderOverride = Schema.Struct({
  region: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
  endpoint: Schema.optionalKey(Schema.String),
  authMode: Schema.optionalKey(Schema.Union([Schema.Literal("default"), Schema.Literal("bearer")])),
  authRefresh: Schema.optionalKey(Schema.Struct({ command: Schema.String, args: StringArray })),
})
const ConfigurationInput = Schema.Struct({
  providers: Schema.optionalKey(
    Schema.Struct({
      openai: Schema.optionalKey(HttpProviderOverride),
      anthropic: Schema.optionalKey(HttpProviderOverride),
      bedrock: Schema.optionalKey(BedrockProviderOverride),
      openrouter: Schema.optionalKey(HttpProviderOverride),
    }),
  ),
  modelAliases: Schema.optionalKey(Schema.Record(Schema.String, ModelAlias)),
  defaultMode: Schema.optionalKey(Schema.String),
  modes: Schema.optionalKey(Schema.Record(Schema.String, Mode)),
  modelRoutes: Schema.optionalKey(
    Schema.Struct({ title: Schema.optionalKey(RoleRoute), compaction: Schema.optionalKey(RoleRoute) }),
  ),
  subagents: Schema.optionalKey(
    Schema.Struct({ maxDepth: Schema.optionalKey(Schema.Finite), maxSubagents: Schema.optionalKey(Schema.Finite) }),
  ),
  keymap: Schema.optionalKey(StringMap),
  extensionRoots: Schema.optionalKey(StringArray),
  mcp: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([McpCommand, McpRemote]))),
  notifications: Schema.optionalKey(
    Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean), command: Schema.optionalKey(Schema.String) }),
  ),
  logging: Schema.optionalKey(
    Schema.Struct({
      level: Schema.optionalKey(
        Schema.Union([
          Schema.Literal("debug"),
          Schema.Literal("info"),
          Schema.Literal("warning"),
          Schema.Literal("error"),
        ]),
      ),
    }),
  ),
  webSearch: Schema.optionalKey(
    Schema.Struct({ providers: Schema.Record(Schema.String, Schema.Struct({ apiKey: Schema.String })) }),
  ),
})

export const isConfigurationInput = Schema.is(ConfigurationInput)
