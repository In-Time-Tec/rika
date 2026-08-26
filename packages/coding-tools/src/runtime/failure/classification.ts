import { Schema } from "effect"

export const FailureCategory = Schema.Literals([
  "invalid_input",
  "not_found",
  "conflict",
  "access_denied",
  "dependency_unavailable",
  "rate_limited",
  "timeout",
  "operation",
])
export type FailureCategory = typeof FailureCategory.Type

export const Recovery = Schema.Literals(["never", "after_change", "later"])
export type Recovery = typeof Recovery.Type
