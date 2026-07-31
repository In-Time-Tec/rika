export interface UsageEvent {
  readonly executionId: string
  readonly type: string
  readonly timestamp: number
}

export const isUsageEvent = (event: UsageEvent): boolean => event.type.startsWith("model.")
