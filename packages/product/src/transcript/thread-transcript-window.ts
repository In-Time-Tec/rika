import type { Entry } from "../thread/model/transcript-page"

export interface ThreadTranscriptWindow {
  readonly entries: ReadonlyArray<Entry>
  readonly hasOlder: boolean
  readonly hasNewer: boolean
}

export const transcriptWindow = (entries: ReadonlyArray<Entry>, hasOlder: boolean, hasNewer: boolean) => ({
  entries,
  hasOlder,
  hasNewer,
})
