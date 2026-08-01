import { Function } from "effect"
import type { TranscriptItem } from "../../state/model/terminal-transcript-state"
import { classifyTranscriptContent } from "../../presentation/transcript/transcript-viewport-window"

const prependedTranscriptItemsImpl = (
  previousItems: ReadonlyArray<unknown>,
  currentItems: ReadonlyArray<unknown>,
): number => {
  const identities = (items: ReadonlyArray<unknown>) =>
    (items as ReadonlyArray<TranscriptItem>).flatMap((item) =>
      item.id === undefined ? [] : [{ id: `${item._tag}:${item.id}` }],
    )
  return classifyTranscriptContent(identities(previousItems), identities(currentItems)).prepended.length
}

export const prependedTranscriptItems: {
  (
    arg1: Parameters<typeof prependedTranscriptItemsImpl>[1],
  ): (arg0: Parameters<typeof prependedTranscriptItemsImpl>[0]) => ReturnType<typeof prependedTranscriptItemsImpl>
  (
    arg0: Parameters<typeof prependedTranscriptItemsImpl>[0],
    arg1: Parameters<typeof prependedTranscriptItemsImpl>[1],
  ): ReturnType<typeof prependedTranscriptItemsImpl>
} = Function.dual(2, prependedTranscriptItemsImpl)
