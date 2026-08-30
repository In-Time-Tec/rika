/**
 * Reading classification back out of failure messages and settled projections.
 * The provider phrase table is the single pattern fallback for paths where no
 * structured error crosses the boundary; everything else stays unclassified
 * and is never retried.
 */
import { compareUnitOrder } from "@rika/transcript/transcript-unit-order"
import type { ModelFailureCategory } from "./failure-policy"

const internalPrefixes = [
  "effect/ai/AiError/AiError: ",
  "effect/ai/AiError/AiError:",
  "tenetkit/runtime/AgentExecutionFailure: ",
  "tenetkit/runtime/AgentExecutionFailure:",
  "OpenAiLanguageModel.streamText: ",
  "OpenAiClient.createResponseStream: ",
  "AnthropicLanguageModel.streamText: ",
  "AnthropicClient.createResponseStream: ",
  "Error: ",
]

const providerPhrases: ReadonlyArray<{
  readonly match: RegExp
  readonly category: ModelFailureCategory
  readonly friendly: string
}> = [
  {
    match: /insufficient.*quota|billing|429.*quota/i,
    category: "token-budget",
    friendly: "The provider account has no remaining quota for this model.",
  },
  {
    match: /rate[- ]limit|429/i,
    category: "rate-limit",
    friendly: "The provider rate-limited the request.",
  },
  {
    match: /overloaded|unavailable|try again later|503|529/i,
    category: "provider-response",
    friendly: "The provider is temporarily overloaded.",
  },
  {
    match: /authentication|unauthorized|invalid api key|401|403/i,
    category: "authentication",
    friendly: "The provider rejected the configured credentials.",
  },
  {
    match: /context.*(length|window|overflow)|maximum context|token.*(exceed|limit)/i,
    category: "context-overflow",
    friendly: "This conversation exceeds the model's context window.",
  },
  { match: /timeout|timed out/i, category: "timeout", friendly: "The provider did not answer in time." },
  {
    match: /connection|network|ECONN|socket|fetch failed/i,
    category: "transport",
    friendly: "The connection to the model provider was lost.",
  },
]

const stripInternalPrefixes = (message: string): string => {
  let cleaned = message
  for (const prefix of internalPrefixes) if (cleaned.startsWith(prefix)) cleaned = cleaned.slice(prefix.length)
  return cleaned
}

/** The friendly what-happened sentence for a provider failure message, or undefined. */
export const providerFailureMessage = (message: string): string | undefined => {
  const cleaned = stripInternalPrefixes(message)
  for (const phrase of providerPhrases) if (phrase.match.test(cleaned)) return phrase.friendly
  return undefined
}

/**
 * Classify a raw failure message for paths where no structured error crosses the
 * boundary. Matches provider phrases only; anything else is an unclassified
 * execution failure and is never retried.
 */
export const classifyFailureMessage = (
  message: string,
):
  | { readonly category: ModelFailureCategory; readonly retryable: boolean; readonly retry: "automatic" | "none" }
  | undefined => {
  const cleaned = stripInternalPrefixes(message)
  for (const phrase of providerPhrases) {
    if (!phrase.match.test(cleaned)) continue
    const retryable = ["rate-limit", "transport", "timeout", "provider-response"].includes(phrase.category)
    return { category: phrase.category, retryable, retry: retryable ? "automatic" : "none" }
  }
  return undefined
}

/** Turn a raw failure message into a readable detail line. */
export const executionFailureDetail = (message: string): string => {
  const friendly = providerFailureMessage(message)
  if (friendly !== undefined) return friendly
  const stripped = stripInternalPrefixes(message).trim()
  return stripped.length === 0 ? "Execution failed" : stripped
}

/**
 * Read the settled failure off a turn\'s projected units: the last Error block
 * carries the classification assigned by the projector. Falls back to the
 * execution outcome reason when no Error block exists.
 */
export const turnFailure = (
  units: ReadonlyArray<import("@rika/transcript/transcript-unit").Unit>,
): { readonly message: string; readonly category: string; readonly retryable: boolean } | undefined => {
  const ordered = units.toSorted((left, right) => compareUnitOrder(left.order, right.order))
  for (const unit of [...ordered].toReversed()) {
    if (unit.content._tag !== "Block" || unit.content.block._tag !== "Error") continue
    const block = unit.content.block
    const message = block.detail.length > 0 ? block.detail : block.title
    return { message, category: block.category ?? "operation", retryable: block.retryable ?? false }
  }
  const reason = ordered.findLast((unit) => unit.executionOutcome?.status === "failed")?.executionOutcome?.reason
  return reason === undefined ? undefined : { message: reason, category: "operation", retryable: false }
}
