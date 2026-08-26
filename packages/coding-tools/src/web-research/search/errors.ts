import { Schema } from "effect"
import { ProviderOutcome } from "./result"
export class SelectionError extends Schema.TaggedError<SelectionError>()("WebSearchSelectionError", {
  message: Schema.String,
}) {}
export class ExecutionError extends Schema.TaggedError<ExecutionError>()("WebSearchExecutionError", {
  message: Schema.String,
  outcomes: Schema.Array(ProviderOutcome),
}) {}
