import type { Entry, PageCursor } from "./page"

export interface ThreadTranscriptResult {
  readonly entries: ReadonlyArray<Entry>
  readonly cursor?: PageCursor
  readonly hasMore: boolean
}
