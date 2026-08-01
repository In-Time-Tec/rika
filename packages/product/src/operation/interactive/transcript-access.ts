import * as TranscriptPage from "@rika/product/transcript-page"
import { OperationError } from "../operation-error"
import { Effect } from "effect"
import {
  boundTranscriptEntries,
  maximumTranscriptPayloadBytes,
  transcriptCursorFor,
  transcriptPageEncoder,
} from "../../transcript/transcript-bounds"

export const boundedTranscriptPage = (input: {
  readonly entries: ReadonlyArray<TranscriptPage.Entry>
  readonly hasOlder: boolean
  readonly encoder: (value: unknown) => string
  readonly fail: (message: string) => Effect.Effect<never, OperationError, never>
}) => {
  const bounded = boundTranscriptEntries(input.entries, input.encoder)
  if (bounded.oversizedEntry) return input.fail("Transcript entry exceeds the transcript event limit")
  const entries = bounded.entries
  let hasOlder = input.hasOlder
  let oldestCursor: TranscriptPage.PageCursor | undefined
  if (bounded.truncated) {
    oldestCursor = bounded.partialCursor ?? transcriptCursorFor(entries[0])
    hasOlder = true
  }
  if (transcriptPageEncoder.encode(input.encoder(entries)).byteLength > maximumTranscriptPayloadBytes)
    return input.fail("Transcript page exceeds the transcript event limit")
  return Effect.succeed({ entries, hasOlder, oldestCursor })
}
