export interface Event {
  readonly executionId: string
  readonly childExecutionId?: string
  readonly cursor: string
  readonly sequence: number
  readonly type: string
  readonly createdAt: number
  readonly timestampSource?: string
  readonly text?: string
  readonly content?: ReadonlyArray<unknown>
  readonly data?: Readonly<Record<string, unknown>>
}
export interface ExecutionCheckpoint {
  readonly cursor: string
  readonly sequence: number
}
export interface Result {
  readonly turnId: string
  readonly status: string
  readonly events: ReadonlyArray<Event>
  readonly checkpoint?: ExecutionCheckpoint
}
export interface EventPage {
  readonly events: ReadonlyArray<Event>
  readonly hasMore: boolean
  readonly oldestCursor?: string
  readonly newestCursor?: string
}
