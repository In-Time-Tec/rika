export interface ContextReading {
  readonly inputTokens: number
  readonly sequence: number
  readonly modelCallId: string
  readonly modelAttemptId: string
  readonly attempt: number
}
