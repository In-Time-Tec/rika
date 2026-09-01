import type { Model } from "../../../state/model"

export interface TranscriptModelUpdate {
  readonly threadChanged: boolean
  readonly following: boolean
  readonly layoutChanged: boolean
  readonly preservePosition: boolean
}

const layoutChanged = (previous: Model | undefined, model: Model): boolean =>
  previous !== undefined &&
  (previous.items !== model.items ||
    previous.entries !== model.entries ||
    previous.blocks !== model.blocks ||
    previous.expandedRowKeys !== model.expandedRowKeys ||
    previous.explicitlyCollapsedRowKeys !== model.explicitlyCollapsedRowKeys ||
    previous.width !== model.width ||
    previous.height !== model.height)

export const planTranscriptModelUpdate = (input: {
  readonly previous: Model | undefined
  readonly model: Model
  readonly viewportFollowing: boolean
  readonly preserveAnchor: boolean
  readonly positionPending: boolean
  readonly wheelIdle: boolean
}): TranscriptModelUpdate => {
  const changed = layoutChanged(input.previous, input.model)
  const threadChanged = input.previous?.currentThreadId !== input.model.currentThreadId
  const following = threadChanged || input.viewportFollowing
  const detachedSameThread =
    input.previous !== undefined &&
    !threadChanged &&
    !following &&
    (input.model.entries.length > 0 || input.model.blocks.length > 0) &&
    changed &&
    !input.positionPending &&
    input.wheelIdle
  return {
    threadChanged,
    following,
    layoutChanged: changed,
    preservePosition: input.preserveAnchor || detachedSameThread,
  }
}
