import type { Input } from "../contract/operation-input-schema"

export const isNoninteractiveOperation = (input: Input): boolean =>
  input._tag === "Run" || input._tag === "Review" || input._tag === "Workflow"
