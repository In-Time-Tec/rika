export interface ExecutionExtensionPin {
  readonly generation: string
  readonly sourceDigest: string
  readonly configFingerprint: string
  readonly toolSchemaDigest: string
  readonly mcpFingerprint: string
  readonly resolvedContextDigest: string
}
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
