export interface RootExecutionEvent {
  readonly executionId: string
  readonly sequence: number
  readonly terminal: boolean
}

export const isRootExecutionEvent = (event: RootExecutionEvent): boolean => event.executionId.length > 0
