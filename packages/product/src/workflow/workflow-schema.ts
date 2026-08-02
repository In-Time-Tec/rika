import { Schema } from "effect"

export const WorkflowName = Schema.Literals(["delivery", "research-synthesis"])
export type WorkflowName = typeof WorkflowName.Type
export const WorkflowRevision = Schema.Int
