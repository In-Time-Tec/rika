import { Schema } from "effect"
import { ThreadId } from "./thread-schema"
import { RouteModeId } from "@rika/configuration/behavior-mode"
import { ExecutionRouteModelSnapshot, ExecutionRouteSnapshot } from "./execution-route-snapshot"

export const TurnId = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]+$/)).pipe(Schema.brand("RikaTurnId"))
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

export const StopIntent = Schema.Literals(["none", "requested"])
export type StopIntent = typeof StopIntent.Type

export const ExecutionExtensionPin = Schema.Struct({
  generation: Schema.String,
  sourceDigest: Schema.String,
  configFingerprint: Schema.String,
  toolSchemaDigest: Schema.String,
  mcpFingerprint: Schema.String,
  resolvedContextDigest: Schema.String,
})
export type ExecutionExtensionPin = typeof ExecutionExtensionPin.Type

export const ExecutionModelRoute = ExecutionRouteModelSnapshot
export type ExecutionModelRoute = typeof ExecutionModelRoute.Type

export const ExecutionRoutePin = ExecutionRouteSnapshot
export type ExecutionRoutePin = typeof ExecutionRoutePin.Type

export const testExecutionRoute = (mode: RouteModeId = "test"): ExecutionRoutePin => {
  const route = {
    alias: "test",
    model: "test",
    providerConnection: { provider: "test", protocol: "test", baseUrl: "test://model" },
    registrationIdentity: "test" as ExecutionModelRoute["registrationIdentity"],
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

export const RecordedShellResult = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  exitCode: Schema.optionalKey(Schema.Int),
})
export type RecordedShellResult = typeof RecordedShellResult.Type

export const AgentExecutionTurn = Schema.TaggedStruct("AgentExecution", {
  id: TurnId,
  threadId: ThreadId,
  prompt: Schema.String,
  promptParts: Schema.optionalKey(Schema.Array(PromptPart)),
  status: Status,
  stopIntent: StopIntent,
  lastCursor: Schema.optionalKey(Schema.String),
  extensionPin: Schema.optionalKey(ExecutionExtensionPin),
  executionRoute: ExecutionRoutePin,
  reviewFanOutId: Schema.optionalKey(Schema.String),
  author: TurnAuthor,
  lineage: TurnLineage,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
})
export type AgentExecutionTurn = typeof AgentExecutionTurn.Type

const RecordedShellFields = {
  id: TurnId,
  threadId: ThreadId,
  prompt: Schema.String,
  command: Schema.NonEmptyString,
  stopIntent: Schema.Literal("none"),
  author: Schema.TaggedStruct("Human", {}),
  lineage: Schema.TaggedStruct("Original", {}),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
} as const

export const RecordedShellTurn = Schema.Union([
  Schema.TaggedStruct("RecordedShell", {
    ...RecordedShellFields,
    status: Schema.Literal("running"),
  }),
  Schema.TaggedStruct("RecordedShell", {
    ...RecordedShellFields,
    status: Schema.Literals(["completed", "failed", "cancelled"]),
    result: RecordedShellResult,
  }),
])
export type RecordedShellTurn = typeof RecordedShellTurn.Type

export const Turn = Schema.Union([AgentExecutionTurn, RecordedShellTurn])
export type Turn = typeof Turn.Type

export type RunningRecordedShellTurn = Extract<RecordedShellTurn, { readonly status: "running" }>
export type TerminalRecordedShellTurn = Exclude<RecordedShellTurn, RunningRecordedShellTurn>

export const isAgentExecution = (turn: Turn): turn is AgentExecutionTurn => turn._tag === "AgentExecution"
export const isRecordedShell = (turn: Turn): turn is RecordedShellTurn => turn._tag === "RecordedShell"
export const isRunningRecordedShell = (turn: Turn): turn is RunningRecordedShellTurn =>
  turn._tag === "RecordedShell" && turn.status === "running"
export const isTerminalRecordedShell = (turn: Turn): turn is TerminalRecordedShellTurn =>
  turn._tag === "RecordedShell" && turn.status !== "running"
export const lastCursor = (turn: Turn): string | undefined => (isAgentExecution(turn) ? turn.lastCursor : undefined)
