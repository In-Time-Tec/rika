export interface RestoredExecutionCursor {
  readonly executionKey: string
  readonly cursor: string
  readonly sequence: number
}

export const restoreExecutionCursor = (value: {
  readonly executionKey: string
  readonly cursor: string
  readonly sequence: number
}): RestoredExecutionCursor => ({ ...value })
