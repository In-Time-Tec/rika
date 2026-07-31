export interface ExecutionStopRequest {
  readonly executionId: string
  readonly reason: string
}

export const stopRequest = (executionId: string, reason: string): ExecutionStopRequest => ({ executionId, reason })
