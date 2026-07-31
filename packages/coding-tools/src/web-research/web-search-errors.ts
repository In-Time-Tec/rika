import { Schema } from "effect"
import { ProviderOutcome } from "./web-search-result-contract"
export class SelectionError extends Schema.TaggedErrorClass<SelectionError>()("WebSearchSelectionError", {
  message: Schema.String,
}) {}
export class ExecutionError extends Schema.TaggedErrorClass<ExecutionError>()("WebSearchExecutionError", {
  message: Schema.String,
  outcomes: Schema.Array(ProviderOutcome),
}) {}
