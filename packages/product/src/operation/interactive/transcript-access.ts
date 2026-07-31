import { Effect } from "effect"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import {
  boundTranscriptEntries,
  maximumTranscriptPayloadBytes,
  transcriptCursorFor,
  transcriptPageEncoder,
} from "../../transcript/transcript-bounds"

export const boundedTranscriptPage = (input: {
  readonly entries: ReadonlyArray<TranscriptRepository.Entry>
  readonly hasOlder: boolean
  readonly encoder: (value: unknown) => string
  readonly fail: (message: string) => Effect.Effect<never, unknown>
}) => {
  const bounded = boundTranscriptEntries(input.entries, input.encoder)
  if (bounded.oversizedEntry) return input.fail("Transcript entry exceeds the transcript event limit")
  const entries = bounded.entries
  let hasOlder = input.hasOlder
  let oldestCursor: TranscriptRepository.PageCursor | undefined
  if (bounded.truncated) {
    oldestCursor = bounded.partialCursor ?? transcriptCursorFor(entries[0])
    hasOlder = true
  }
  if (transcriptPageEncoder.encode(input.encoder(entries)).byteLength > maximumTranscriptPayloadBytes)
    return input.fail("Transcript page exceeds the transcript event limit")
  return Effect.succeed({ entries, hasOlder, oldestCursor })
}
