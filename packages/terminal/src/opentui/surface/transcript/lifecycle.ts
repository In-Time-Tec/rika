import { Function } from "effect"
import type { TranscriptItem } from "../../../state/transcript/model"
import { decodeTranscriptItems } from "../../../state/transcript/model"
import { classifyTranscriptContent } from "../../../presentation/transcript/content-change"

const prependedTranscriptItemsImpl = (
  previousItems: ReadonlyArray<unknown>,
  currentItems: ReadonlyArray<unknown>,
): number => {
  const identities = (items: ReadonlyArray<unknown>) =>
    decodeTranscriptItems(items).flatMap((item: TranscriptItem) =>
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
