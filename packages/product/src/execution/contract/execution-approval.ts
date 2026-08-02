export interface PendingApproval {
  readonly waitId: string
  readonly executionId: string
  readonly callId: string
  readonly toolName: string
  readonly input: unknown
  readonly requestedAt: number
}
