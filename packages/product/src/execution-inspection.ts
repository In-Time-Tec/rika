import type { Status } from "./execution-status"

export interface Inspection {
  readonly turnId: string
  readonly status: Status
  readonly createdAt?: number
  readonly lastCursor?: string
  readonly waits: ReadonlyArray<{ readonly id: string; readonly mode: string; readonly createdAt: number }>
  readonly pendingTools: ReadonlyArray<{
    readonly callId: string
    readonly name: string
    readonly input: unknown
    readonly requestedAt: number
  }>
  readonly children: ReadonlyArray<{ readonly executionId: string; readonly status: Status }>
}
