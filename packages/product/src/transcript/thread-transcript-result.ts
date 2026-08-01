import type { Entry, PageCursor } from "../thread/model/transcript-page"

export interface ThreadTranscriptResult {
  readonly entries: ReadonlyArray<Entry>
  readonly cursor?: PageCursor
  readonly hasMore: boolean
}
