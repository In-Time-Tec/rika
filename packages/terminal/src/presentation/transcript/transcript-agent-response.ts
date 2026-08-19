import { Function } from "effect"
import type { Model } from "../../state/model/terminal-state"
import type { TranscriptBlock, TranscriptItem } from "../../state/model/terminal-transcript-state"
import type { AgentResponseState } from "./transcript-tool-kinds"

export const isToolOutputDisplayed = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): boolean =>
  block.status === "failed" || block.presentation.outputDisplay !== "hidden"

const agentFailureFallback = "The subagent failed without a reported reason."
const agentEmptyFallback = "The subagent finished without a final message."
const agentCancelledFallback = "The subagent was cancelled."

const stringField = (value: object, key: string): string | undefined => {
  if (!(key in value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" && field.trim().length > 0 ? field : undefined
}

const decodedOutput = (output: string | undefined): object | undefined => {
  if (output === undefined) return undefined
  const value = output.trim()
  if (!(value.startsWith("{") || value.startsWith("["))) return undefined
  try {
    const decoded: unknown = JSON.parse(value)
    return typeof decoded === "object" && decoded !== null ? decoded : undefined
  } catch {
    return undefined
  }
}

const failedDelegationTags = new Set(["NoReport", "Failed"])

export const isFailedDelegationOutput = (output: string | undefined): boolean => {
  const decoded = decodedOutput(output)
  if (decoded === undefined) return false
  const tag = stringField(decoded, "_tag")
  return tag !== undefined && failedDelegationTags.has(tag) && stringField(decoded, "status") === "failed"
}

export const isDeliveredDelegationOutput = (output: string | undefined): boolean => {
  const decoded = decodedOutput(output)
  if (decoded === undefined) return false
  return stringField(decoded, "_tag") === "Report" && stringField(decoded, "status") === "completed"
}

const succeededDelegationTags = new Set(["Report", "NoReport"])

export const isSucceededDelegationOutput = (output: string | undefined): boolean => {
  const decoded = decodedOutput(output)
  if (decoded === undefined) return false
  const tag = stringField(decoded, "_tag")
  return tag !== undefined && succeededDelegationTags.has(tag) && stringField(decoded, "status") === "completed"
}

const noReportText = (decoded: object): string | undefined => {
  if (stringField(decoded, "_tag") !== "NoReport") return undefined
  const reason = stringField(decoded, "reason") ?? agentEmptyFallback
  const recovery = stringField(decoded, "recovery")
  return recovery === undefined ? reason : `${reason}\n\n${recovery}`
}

export const agentOutputText = (output: string | undefined): string | undefined => {
  if (output === undefined) return undefined
  const value = output.trim()
  if (value.length === 0) return undefined
  const decoded = decodedOutput(output)
  if (decoded === undefined) return output
  const noReport = noReportText(decoded)
  if (noReport !== undefined) return noReport
  if ("output" in decoded && Array.isArray((decoded as { readonly output: unknown }).output)) {
    const text = (decoded as { readonly output: ReadonlyArray<unknown> }).output
      .flatMap((part) =>
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof (part as { text: unknown }).text === "string"
          ? [(part as { readonly text: string }).text]
          : [],
      )
      .join("\n")
    const reason = stringField(decoded, "reason")
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
  const item = children.findLast(
    (candidate): candidate is Extract<TranscriptItem, { readonly _tag: "Block" }> =>
      candidate._tag === "Block" && (model.blocks[candidate.index] as TranscriptBlock | undefined)?._tag === "Error",
  )
  if (item === undefined) return undefined
  const block = model.blocks[item.index] as Extract<TranscriptBlock, { _tag: "Error" }>
  const detail = block.detail.trim().length > 0 ? block.detail : block.title
  return detail.trim().length > 0 ? detail : undefined
}

const outcomeReason = (model: Model, block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): string | undefined => {
  const outcomes = model.childExecutionOutcomes as Readonly<Record<string, { readonly reason?: string }>>
  const reason = outcomes[block.id]?.reason
  return reason !== undefined && reason.trim().length > 0 ? reason : undefined
}

const settledText = (
  model: Model,
  block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
  children: ReadonlyArray<TranscriptItem>,
  fallback: string,
): string =>
  (block.status === "complete" && isDeliveredDelegationOutput(block.output)
    ? agentOutputText(block.output)
    : undefined) ??
  childErrorDetail(model, children) ??
  outcomeReason(model, block) ??
  (isToolOutputDisplayed(block) ? agentOutputText(block.output) : undefined) ??
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
