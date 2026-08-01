import { Schema } from "effect"

export const ExecutionExtensionPin = Schema.Struct({
  generation: Schema.String,
  sourceDigest: Schema.String,
  configFingerprint: Schema.String,
  toolSchemaDigest: Schema.String,
  mcpFingerprint: Schema.String,
  resolvedContextDigest: Schema.String,
})
export type ExecutionExtensionPin = typeof ExecutionExtensionPin.Type

export interface WorkflowInspection {
  readonly runId: string
  readonly ownerTurnId?: string
  readonly workflow: string
  readonly revision: number
  readonly digest: string
  readonly status: "running" | "completed" | "failed" | "cancelled"
  readonly createdAt: number
  readonly updatedAt: number
}
