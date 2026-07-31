import type { Input } from "../contract/product-operation"

export const isWorkflowOperation = (input: Input): boolean => input._tag === "Workflow"
