import type { TranscriptItem } from "../../state/model/terminal-transcript-state"
import { classifyTranscriptContent } from "../../presentation/transcript/transcript-viewport-window"

export const prependedTranscriptItems = (
  previousItems: ReadonlyArray<unknown>,
  currentItems: ReadonlyArray<unknown>,
): number => {
  const identities = (items: ReadonlyArray<unknown>) =>
    (items as ReadonlyArray<TranscriptItem>).flatMap((item) =>
      item.id === undefined ? [] : [{ id: `${item._tag}:${item.id}` }],
    )
  return classifyTranscriptContent(identities(previousItems), identities(currentItems)).prepended.length
}
