import { Exit, Function, Schema } from "effect"
import type { Unit } from "@rika/transcript/transcript-unit"
import { Block } from "@rika/transcript/transcript-presentation-model"
import type { Model } from "../../state/model"
import type { TranscriptBlock, TranscriptItem } from "../../state/transcript/model"
import type { AgentResponseState } from "./tool/kinds"

export const isToolOutputDisplayed = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): boolean =>
  block.status === "failed" || block.presentation.outputDisplay !== "hidden"

const agentFailureFallback = "The subagent failed without a reported reason."
const agentEmptyFallback = "The subagent finished without a final message."
const agentCancelledFallback = "The subagent was cancelled."

const TextPart = Schema.Struct({ text: Schema.String })
const DelegationOutput = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  recovery: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(Schema.Array(TextPart)),
})

type DelegationOutput = typeof DelegationOutput.Type

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value : undefined

const decodedOutput = (output: Schema.Json | undefined): DelegationOutput | undefined => {
  if (output === undefined) return undefined
  const decoded = Schema.decodeUnknownExit(DelegationOutput)(output)
  if (Exit.isFailure(decoded)) return undefined
  return decoded.value
}

const failedDelegationTags = new Set(["NoReport", "Failed"])

export const isFailedDelegationOutput = (output: Schema.Json | undefined): boolean => {
  const decoded = decodedOutput(output)
  if (decoded === undefined) return false
  const tag = nonEmpty(decoded._tag)
  return tag !== undefined && failedDelegationTags.has(tag) && nonEmpty(decoded.status) === "failed"
}

export const isDeliveredDelegationOutput = (output: Schema.Json | undefined): boolean => {
  const decoded = decodedOutput(output)
  if (decoded === undefined) return false
  return nonEmpty(decoded._tag) === "Report" && nonEmpty(decoded.status) === "completed"
}

const succeededDelegationTags = new Set(["Report", "NoReport"])

export const isSucceededDelegationOutput = (output: Schema.Json | undefined): boolean => {
  const decoded = decodedOutput(output)
  if (decoded === undefined) return false
  const tag = nonEmpty(decoded._tag)
  return tag !== undefined && succeededDelegationTags.has(tag) && nonEmpty(decoded.status) === "completed"
}

const noReportText = (decoded: DelegationOutput): string | undefined => {
  if (nonEmpty(decoded._tag) !== "NoReport") return undefined
  const reason = nonEmpty(decoded.reason) ?? agentEmptyFallback
  const recovery = nonEmpty(decoded.recovery)
  return recovery === undefined ? reason : `${reason}\n\n${recovery}`
}

export const agentOutputText = (output: Schema.Json | undefined): string | undefined => {
  if (output === undefined) return undefined
  if (Schema.is(Schema.String)(output) && output.trim().length === 0) return undefined
  const decoded = decodedOutput(output)
  if (decoded === undefined) return Schema.is(Schema.String)(output) ? output : JSON.stringify(output, null, 2)
  const noReport = noReportText(decoded)
  if (noReport !== undefined) return noReport
  if (decoded.output !== undefined) {
    const text = decoded.output.map((part) => part.text).join("\n")
    const reason = nonEmpty(decoded.reason)
    if (text.trim().length > 0) return reason === undefined ? text : `${text}\n\n${reason}`
    if (reason !== undefined) return reason
  }
  return undefined
}

const lastAnswerEntry = (model: Model, children: ReadonlyArray<TranscriptItem>): number | undefined =>
  children.findLast(
    (item): item is Extract<TranscriptItem, { readonly _tag: "Entry" }> =>
      item._tag === "Entry" &&
      model.entries[item.index]?.role === "assistant" &&
      (model.entries[item.index]?.text.trim().length ?? 0) > 0,
  )?.index

const childErrorDetail = (model: Model, children: ReadonlyArray<TranscriptItem>): string | undefined => {
  const errorAt = (index: number) => {
    const decoded = Schema.decodeUnknownExit(Block)(model.blocks[index])
    return Exit.isSuccess(decoded) && decoded.value._tag === "Error" ? decoded.value : undefined
  }
  const item = children.findLast(
    (candidate): candidate is Extract<TranscriptItem, { readonly _tag: "Block" }> =>
      candidate._tag === "Block" && errorAt(candidate.index) !== undefined,
  )
  if (item === undefined) return undefined
  const block = errorAt(item.index)
  if (block === undefined) return undefined
  const detail = block.detail.trim().length > 0 ? block.detail : block.title
  return detail.trim().length > 0 ? detail : undefined
}

const outcomeReason = (model: Model, block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): string | undefined => {
  const decoded = Schema.decodeUnknownExit(Schema.Struct({ reason: Schema.optionalKey(Schema.String) }))(
    model.childExecutionOutcomes[block.id],
  )
  if (Exit.isFailure(decoded)) return undefined
  const reason: NonNullable<Unit["executionOutcome"]>["reason"] = decoded.value.reason
  return reason !== undefined && reason.trim().length > 0 ? reason : undefined
}

const settledText = (
  model: Model,
  block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
  children: ReadonlyArray<TranscriptItem>,
  fallback: string,
): string =>
  (block.status === "complete" && isDeliveredDelegationOutput(block.result)
    ? agentOutputText(block.result)
    : undefined) ??
  childErrorDetail(model, children) ??
  outcomeReason(model, block) ??
  (isToolOutputDisplayed(block) ? agentOutputText(block.result) : undefined) ??
  fallback

export const agentResponseState: {
  (
    model: Model,
    block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
    children: ReadonlyArray<TranscriptItem>,
  ): AgentResponseState | undefined
  (
    block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
    children: ReadonlyArray<TranscriptItem>,
  ): (model: Model) => AgentResponseState | undefined
} = Function.dual(
  3,
  (
    model: Model,
    block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
    children: ReadonlyArray<TranscriptItem>,
  ): AgentResponseState | undefined => {
    const answer = lastAnswerEntry(model, children)
    if (block.status === "running") return answer === undefined ? undefined : { _tag: "Streaming", answer }
    if (block.status === "failed") {
      return {
        _tag: "Settled",
        outcome: { kind: "error", tone: "failed", text: settledText(model, block, children, agentFailureFallback) },
      }
    }
    if (answer !== undefined) return { _tag: "Settled", outcome: { kind: "answer", entry: answer } }
    if (block.status === "complete") {
      return {
        _tag: "Settled",
        outcome: { kind: "error", tone: "info", text: settledText(model, block, children, agentEmptyFallback) },
      }
    }
    return {
      _tag: "Settled",
      outcome: {
        kind: "error",
        tone: "cancelled",
        text: settledText(model, block, children, agentCancelledFallback),
      },
    }
  },
)
