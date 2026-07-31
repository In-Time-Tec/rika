import type { Input } from "../contract/product-operation"

export const isNoninteractiveOperation = (input: Input): boolean =>
  input._tag === "Run" || input._tag === "Review" || input._tag === "Workflow"
