export interface UsageAttempt {
  readonly executionId: string
  readonly attemptId: string
  readonly completed: boolean
}

export const completeAttempt = (attempt: UsageAttempt): UsageAttempt => ({ ...attempt, completed: true })
