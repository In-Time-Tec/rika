import { Schema } from "effect"
import { ThreadId } from "./thread-schema"
import { RouteModeId } from "@rika/config/modes"

export const TurnId = Schema.String.pipe(Schema.brand("RikaTurnId"))
export type TurnId = typeof TurnId.Type

export const TurnAuthor = Schema.Union([
  Schema.TaggedStruct("Human", {}),
  Schema.TaggedStruct("Agent", {
    sourceThreadId: ThreadId,
    sourceRootTurnId: TurnId,
    threadCreationDepth: Schema.Int,
  }),
])
export type TurnAuthor = typeof TurnAuthor.Type

export const TurnLineage = Schema.Union([
  Schema.TaggedStruct("Original", {}),
  Schema.TaggedStruct("ForkCopy", {
    sourceThreadId: ThreadId,
    sourceTurnId: TurnId,
  }),
])
export type TurnLineage = typeof TurnLineage.Type

export const Status = Schema.Literals(["accepted", "queued", "running", "waiting", "completed", "failed", "cancelled"])
export type Status = typeof Status.Type

export const ExecutionExtensionPin = Schema.Struct({
  generation: Schema.String,
  sourceDigest: Schema.String,
  configFingerprint: Schema.String,
  toolSchemaDigest: Schema.String,
  mcpFingerprint: Schema.String,
  resolvedContextDigest: Schema.String,
})
export type ExecutionExtensionPin = typeof ExecutionExtensionPin.Type

export const ExecutionModelRoute = Schema.Struct({
  role: Schema.Literals([
    "main",
    "oracle",
    "title",
    "compaction",
    "librarian",
    "painter",
    "review",
    "readThread",
    "surgeon",
    "task",
  ]),
  alias: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  registrationKey: Schema.String,
  providerProtocol: Schema.String,
  providerBaseUrl: Schema.String,
  providerApiKeyEnv: Schema.optionalKey(Schema.String),
  providerRuntime: Schema.optionalKey(
    Schema.Struct({
      adapter: Schema.String,
      credentialIdentity: Schema.optionalKey(Schema.String),
      connectionIdentity: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
  openAiAccountFingerprint: Schema.optionalKey(Schema.String),
  effort: Schema.String,
  fast: Schema.Boolean,
  requestVariant: Schema.String,
  providerOptions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  compaction: Schema.Struct({
    contextWindow: Schema.Finite,
    reserveTokens: Schema.Finite,
    keepRecentTokens: Schema.Finite,
  }),
})
export type ExecutionModelRoute = typeof ExecutionModelRoute.Type

export const ExecutionRoutePin = Schema.Struct({
  mode: RouteModeId,
  tokenBudget: Schema.optionalKey(Schema.Finite),
  title: Schema.optionalKey(ExecutionModelRoute),
  compactionSummary: Schema.optionalKey(ExecutionModelRoute),
  main: ExecutionModelRoute,
  oracle: ExecutionModelRoute,
  agents: Schema.optionalKey(
    Schema.Struct({
      librarian: ExecutionModelRoute,
      painter: ExecutionModelRoute,
      review: ExecutionModelRoute,
      readThread: ExecutionModelRoute,
      surgeon: ExecutionModelRoute,
      task: ExecutionModelRoute,
    }),
  ),
})
export type ExecutionRoutePin = typeof ExecutionRoutePin.Type

export const testExecutionRoute = (mode: RouteModeId = "test"): ExecutionRoutePin => {
  const route = {
    alias: "test",
    provider: "test",
    model: "test",
    registrationKey: "test",
    providerProtocol: "test" as const,
    providerBaseUrl: "test://model",
    effort: "medium",
    fast: false,
    requestVariant: "test",
    compaction: { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
  }
  return {
    mode,
    title: { ...route, role: "title", effort: "low" },
    compactionSummary: { ...route, role: "compaction" },
    main: { ...route, role: "main" },
    oracle: { ...route, role: "oracle" },
    agents: {
      librarian: { ...route, role: "librarian" },
      painter: { ...route, role: "painter" },
      review: { ...route, role: "review" },
      readThread: { ...route, role: "readThread" },
      surgeon: { ...route, role: "surgeon" },
      task: { ...route, role: "task" },
    },
  }
}

export const PromptPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String, pasted: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({
    type: Schema.Literal("image"),
    mediaType: Schema.String,
    data: Schema.String,
    filename: Schema.optionalKey(Schema.String),
  }),
])
export type PromptPart = typeof PromptPart.Type

export const Turn = Schema.Struct({
  id: TurnId,
  threadId: ThreadId,
  prompt: Schema.String,
  promptParts: Schema.optionalKey(Schema.Array(PromptPart)),
  status: Status,
  lastCursor: Schema.optionalKey(Schema.String),
  extensionPin: Schema.optionalKey(ExecutionExtensionPin),
  executionRoute: ExecutionRoutePin,
  reviewFanOutId: Schema.optionalKey(Schema.String),
  author: TurnAuthor,
  lineage: TurnLineage,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
})
export type Turn = typeof Turn.Type
