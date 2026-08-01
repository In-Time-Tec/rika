import { Function } from "effect"
import type { Entry } from "../thread/model/transcript-page"

export interface ThreadTranscriptWindow {
  readonly entries: ReadonlyArray<Entry>
  readonly hasOlder: boolean
  readonly hasNewer: boolean
}

const transcriptWindowImpl = (entries: ReadonlyArray<Entry>, hasOlder: boolean, hasNewer: boolean) => ({
  entries,
  hasOlder,
  hasNewer,
})

export const transcriptWindow: {
  (arg1: boolean, arg2: boolean): (arg0: ReadonlyArray<Entry>) => ReturnType<typeof transcriptWindowImpl>
  (arg0: ReadonlyArray<Entry>, arg1: boolean, arg2: boolean): ReturnType<typeof transcriptWindowImpl>
} = Function.dual(3, transcriptWindowImpl)
