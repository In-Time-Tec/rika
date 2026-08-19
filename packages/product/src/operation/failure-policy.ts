/**
 * The single error chokepoint. Every user-visible failure is classified here,
 * where it is created, from structured inputs — never from prose. The result is
 * one closed `FailureCategory`, one retry decision, and one what-happened
 * message with no instruction text.
 */
import { Schema } from "effect"

export const ModelFailureCategory = Schema.Literals([
  "authentication",
  "rate-limit",
  "transport",
  "provider-response",
  "stream-decode",
  "truncated-stream",
  "context-overflow",
  "invalid-tool-call",
  "token-budget",
  "timeout",
  "cancellation",
  "unknown",
])
export type ModelFailureCategory = typeof ModelFailureCategory.Type

export const FailureCategory = Schema.Literals([
  ...ModelFailureCategory.literals,
  "tool",
  "operation",
  "execution-unavailable",
  "transport-degraded",
  "defect",
])
export type FailureCategory = typeof FailureCategory.Type

const modelFailureMessages: Readonly<Record<ModelFailureCategory, string>> = {
  authentication: "The provider rejected the configured credentials.",
  "rate-limit": "The provider limited how often requests are accepted.",
  transport: "The connection to the model provider was lost.",
  "provider-response": "The provider responded with an error instead of a completion.",
  "stream-decode": "The provider response could not be decoded.",
  "truncated-stream": "The provider ended the response before it completed.",
  "context-overflow": "This conversation exceeds the model's context window.",
  "invalid-tool-call": "The model asked for a tool in a way Rika could not run.",
  "token-budget": "The turn used more tokens than its budget allows.",
  timeout: "The provider did not answer in time.",
  cancellation: "The model request was cancelled.",
  unknown: "The model request failed.",
}

/**
 * Present a TenetKit model-call failure from its structured category and
 * classification. `transient` means TenetKit retried and the same call could
 * succeed later; `terminal` means an identical attempt fails identically.
 */
export const modelFailurePresentation = (input: {
  readonly category: ModelFailureCategory
  readonly classification: "transient" | "terminal"
}) => ({
  message: modelFailureMessages[input.category],
  category: input.category,
  retryable: input.classification === "transient",
  retry: (input.classification === "transient" ? "automatic" : "none") as "automatic" | "none",
})
