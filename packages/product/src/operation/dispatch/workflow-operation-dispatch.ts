import type { Input } from "../contract/operation-input-schema"

export const isWorkflowOperation = (input: Input): boolean => input._tag === "Workflow"
