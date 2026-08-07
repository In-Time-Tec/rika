/**
 * User-facing presentation of model and execution failures.
 *
 * Baton reports model failures with a structured category and classification;
 * the projector used to render them verbatim ("rate-limit: terminal") and copied
 * raw provider error strings ("effect/ai/AiError/AiError: ...") into the
 * transcript. Users should read what happened and what to do, not internal
 * identifiers. The raw message stays in the diagnostics log.
 */

export type ModelFailureCategory =
  | "authentication"
  | "rate-limit"
  | "transport"
  | "provider-response"
  | "stream-decode"
  | "truncated-stream"
  | "context-overflow"
  | "invalid-tool-call"
  | "token-budget"
  | "timeout"
  | "cancellation"
  | "unknown"

const modelFailureTitles: Readonly<Record<ModelFailureCategory, string>> = {
  authentication: "Provider authentication failed",
  "rate-limit": "Model rate limit reached",
  transport: "Model connection failed",
  "provider-response": "The model provider returned an error",
  "stream-decode": "The model response could not be read",
  "truncated-stream": "The model response ended unexpectedly",
  "context-overflow": "Context window exceeded",
  "invalid-tool-call": "The model made an invalid tool call",
  "token-budget": "Token budget exhausted",
  timeout: "The model request timed out",
  cancellation: "Model request cancelled",
  unknown: "Model request failed",
}

const modelFailureDetails: Readonly<Record<ModelFailureCategory, string>> = {
  authentication:
    "The provider rejected the configured credentials. Check the API key in your Rika settings and restart.",
  "rate-limit": "The provider limited how often requests are accepted. Wait a moment, then try again.",
  transport: "The connection to the model provider was lost. Check your network, then try again.",
  "provider-response":
    "The provider responded with an error instead of a completion. Try again; if it persists, check the provider status.",
  "stream-decode": "The provider response could not be decoded. This is usually a provider-side issue; try again.",
  "truncated-stream": "The provider ended the response before it completed. Try again with the same request.",
  "context-overflow":
    "This conversation exceeds the model's context window. Start a new thread or ask a shorter question.",
  "invalid-tool-call": "The model asked for a tool in a way Rika could not run. Resend the message to try again.",
  "token-budget": "The turn used more tokens than its budget allows. Continue in a new thread.",
  timeout: "The provider did not answer in time. Try again.",
  cancellation: "The model request was cancelled.",
  unknown: "The model request failed. Try again.",
}

export const modelFailurePresentation = (input: {
  readonly category: ModelFailureCategory
  readonly classification: "transient" | "terminal"
}) => ({
  title: modelFailureTitles[input.category],
  detail: modelFailureDetails[input.category],
  recovery:
    input.classification === "transient"
      ? "This was a temporary provider failure; try again."
      : "This attempt cannot succeed as-is; fix the cause above and resend.",
})

const internalPrefixes = [
  "effect/ai/AiError/AiError: ",
  "effect/ai/AiError/AiError:",
  "@batonfx/runtime/AgentExecutionFailure: ",
  "@batonfx/runtime/AgentExecutionFailure:",
  "OpenAiLanguageModel.streamText: ",
  "OpenAiClient.createResponseStream: ",
  "AnthropicLanguageModel.streamText: ",
  "AnthropicClient.createResponseStream: ",
  "Error: ",
]

const providerPhrases: ReadonlyArray<{ readonly match: RegExp; readonly friendly: string }> = [
  { match: /rate[- ]limit/i, friendly: "The model provider rate-limited the request. Wait a moment, then try again." },
  {
    match: /overloaded|unavailable|try again later|503|529/i,
    friendly: "The model provider is temporarily overloaded. Wait a moment, then try again.",
  },
  {
    match: /authentication|unauthorized|invalid api key|401|403/i,
    friendly: "The provider rejected the configured credentials. Check the API key in your Rika settings and restart.",
  },
  {
    match: /insufficient.*quota|billing|429.*quota/i,
    friendly: "The provider account has no remaining quota for this model.",
  },
  {
    match: /context.*(length|window|overflow)|maximum context|token.*(exceed|limit)/i,
    friendly: "This conversation exceeds the model's context window. Start a new thread or ask a shorter question.",
  },
  { match: /timeout|timed out/i, friendly: "The provider did not answer in time. Try again." },
  {
    match: /connection|network|ECONN|socket|fetch failed/i,
    friendly: "The connection to the model provider was lost. Check your network, then try again.",
  },
]

/**
 * Turn a raw execution failure message into a readable detail line. Unknown
 * messages keep their text (minus internal prefixes) rather than being replaced
 * by a generic sentence.
 */
export const executionFailureDetail = (message: string): string => {
  let cleaned = message
  for (const prefix of internalPrefixes) if (cleaned.startsWith(prefix)) cleaned = cleaned.slice(prefix.length)
  for (const phrase of providerPhrases) if (phrase.match.test(cleaned)) return phrase.friendly
  const stripped = cleaned.trim()
  return stripped.length === 0 ? "Execution failed" : stripped
}
