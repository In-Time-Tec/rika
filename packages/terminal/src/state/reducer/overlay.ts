import { Function, Schema } from "effect"
import { Block } from "@rika/transcript/transcript-presentation-model"
import { UnitOrder } from "@rika/transcript/transcript-unit"
import type { Message } from "../message"
import type { Model } from "../model"
import type { TranscriptBlock, TranscriptItem } from "../transcript/model"
import { ready, loading } from "../loadable"
import { streamActivity } from "../activity/model"
import { dropSubmittedDrafts, takeSubmittedDraftFor, validQueueSelection } from "../queue/model"
import { hasProvisionalUserEntry, settleProvisionalUserEntry } from "../submission"
import { expandableRowIds, transcriptUnits, transcriptUnitId } from "../../presentation/transcript/row"
import { changedFiles } from "../changed-file"
import { cancelTranscriptBlocks } from "../transcript/model"

const TranscriptItemSchema = Schema.Struct({
  _tag: Schema.Literals(["Entry", "Block"]),
  index: Schema.Finite,
  id: Schema.optionalKey(Schema.String),
  turnId: Schema.optionalKey(Schema.String),
  rootTurnId: Schema.optionalKey(Schema.String),
  parentId: Schema.optionalKey(Schema.String),
  order: Schema.optionalKey(UnitOrder),
})
const isTranscriptBlock = Schema.is(Block)
const isTranscriptItem = Schema.is(TranscriptItemSchema)
type SubmissionReference = { submissionId?: string; turnId?: string }
type SubmittedDraft = Model["submittedDrafts"][number]
type ExecutionFailure = Extract<Message, { readonly _tag: "ExecutionFailed" }>["failure"]
type Activity = Model["activity"]

const dropProvisionalQueueItem = (model: Model, submissionId: string | undefined) => {
  if (submissionId === undefined) return { queue: model.queue, queueSelection: model.queueSelection }
  const queue = model.queue.filter((item) => item.id !== submissionId || item.provisional !== true)
  return { queue, queueSelection: validQueueSelection(model.queueSelection, queue) }
}

const submissionReference = (draft: SubmittedDraft | undefined, turnId: string | undefined): SubmissionReference => {
  const reference: SubmissionReference = {}
  if (draft?.submissionId !== undefined) reference.submissionId = draft.submissionId
  if (turnId !== undefined) reference.turnId = turnId
  return reference
}

const restoreSubmittedComposer = (model: Model, draft: SubmittedDraft | undefined, restore: boolean): Model => {
  if (!restore || draft === undefined) return model
  return { ...model, input: draft.input, cursor: draft.cursor, pastedText: draft.attachments }
}

const settledActivity = (activeTurnId: string | undefined, activity: Activity, pendingDrafts: number): Activity => {
  if (activeTurnId !== undefined) return activity
  if (pendingDrafts > 0) return { _tag: "Sending" }
  return undefined
}

const streamReasoning = (model: Model, text: string): Model => {
  const blocks = model.blocks.filter(isTranscriptBlock)
  const candidate = model.items.at(-1)
  const lastItem = isTranscriptItem(candidate) ? candidate : undefined
  const last = lastItem?._tag === "Block" ? blocks[lastItem.index] : undefined
  if (last?._tag === "Reasoning" && lastItem?._tag === "Block")
    blocks[lastItem.index] = { ...last, text: last.text + text }
  else {
    blocks.push({ _tag: "Reasoning", text })
    const streamed = {
      ...model,
      blocks,
      items: [...model.items, { _tag: "Block" as const, index: model.blocks.length }],
    }
    return model.busy
      ? { ...streamed, activity: streamActivity(model.activity, "Thinking", text, undefined) }
      : streamed
  }
  const streamed = { ...model, blocks }
  return model.busy ? { ...streamed, activity: streamActivity(model.activity, "Thinking", text, undefined) } : streamed
}

const toggleReasoning = (model: Model, index: number): Model => {
  const unit = transcriptUnits(model).find((candidate) => candidate.kind === "reasoning" && candidate.block === index)
  if (unit === undefined) return model
  const id = transcriptUnitId(model, unit)
  const expanded = new Set(model.expandedRowKeys)
  if (expanded.has(id)) expanded.delete(id)
  else expanded.add(id)
  return { ...model, expandedRowKeys: [...expanded] }
}

const reduceReasoningOverlay = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "ConnectionStateChanged":
      return { ...model, connection: message.state }
    case "ReasoningStreamed":
      return streamReasoning(model, message.text)
    case "ReasoningToggled":
      return toggleReasoning(model, message.index)
    case "PaletteActionConsumed":
      return { ...model, pendingAction: undefined }
  }
  return undefined
}

const assistantEntryIndex = (model: Model, turnId: string | undefined): number => {
  const item = model.items
    .filter(isTranscriptItem)
    .findLast((candidate) => turnId === undefined || candidate.turnId === turnId)
  return item?._tag === "Entry" &&
    model.entries[item.index]?.role === "assistant" &&
    (turnId !== undefined || model.activity?._tag === "Streaming")
    ? item.index
    : -1
}

const assistantEntries = (model: Model, text: string, turnId: string | undefined, append: boolean) => {
  const entries = [...model.entries]
  const index = assistantEntryIndex(model, turnId)
  const stored = entries[index]
  if (stored !== undefined) entries[index] = { ...stored, text: append ? stored.text + text : text }
  else {
    const entry: Model["entries"][number] = { role: "assistant", text }
    entries.push(turnId === undefined ? entry : { ...entry, turnId })
  }
  return { entries, index }
}

const streamedAssistant = (model: Model, text: string, id: string | undefined, turnId: string | undefined): Model => {
  const { entries, index } = assistantEntries(model, text, turnId, true)
  const item: TranscriptItem = { _tag: "Entry", index: entries.length - 1 }
  const identified = id === undefined ? item : { ...item, id }
  const turned = turnId === undefined ? identified : { ...identified, turnId }
  return {
    ...model,
    entries,
    items: index >= 0 ? model.items : [...model.items, turned],
    busy: true,
    activity: streamActivity(model.activity, "Streaming", text, undefined),
  }
}

const completedAssistant = (model: Model, text: string, id: string | undefined, turnId: string | undefined): Model => {
  const { entries, index } = assistantEntries(model, text, turnId, false)
  const item: TranscriptItem =
    turnId === undefined
      ? { _tag: "Entry", index: entries.length - 1 }
      : { _tag: "Entry", index: entries.length - 1, turnId }
  const identified = id === undefined ? item : { ...item, id }
  return {
    ...model,
    entries,
    items: index >= 0 ? model.items : [...model.items, identified],
    busy: model.busy,
    activity: model.busy && model.activeTurnId !== undefined ? { _tag: "Finishing" } : undefined,
  }
}

const reduceAssistantOverlay = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "AssistantStreamed":
      return streamedAssistant(model, message.text, message.id, message.turnId)
    case "AssistantCompleted":
      return completedAssistant(model, message.text, message.id, message.turnId)
  }
  return undefined
}

const reduceStreamingOverlay = (model: Model, message: Message): Model | undefined =>
  reduceReasoningOverlay(model, message) ?? reduceAssistantOverlay(model, message)

const reduceExecutionCompletion = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "ExecutionCompleted": {
      if (message.turnId !== undefined && model.activeTurnId !== undefined && model.activeTurnId !== message.turnId)
        return model
      return {
        ...model,
        submittedDrafts: dropSubmittedDrafts(model.submittedDrafts, message.turnId),
        cancelPending: false,
        busy: false,
        activity: undefined,
        activeTurnId: undefined,
      }
    }
    case "TurnRetryScheduled": {
      if (model.activeTurnId !== message.turnId && model.activeTurnId !== undefined) return model
      return {
        ...model,
        activity: {
          _tag: "Retrying",
          attempt: message.attempt,
          budget: message.budget,
          message: message.message,
          nextAt: message.nextAt,
        },
        retryCountdown: message.retryCountdown,
      }
    }
  }
  return undefined
}

const reduceSubmissionRejection = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "SubmissionRejected": {
      const matchingDraft = model.submittedDrafts.find(
        (draft) =>
          draft.turnId === undefined &&
          (message.submissionId === undefined || draft.submissionId === message.submissionId),
      )
      if (matchingDraft === undefined) return model
      const taken = takeSubmittedDraftFor(
        model.submittedDrafts,
        message.submissionId === undefined ? {} : { submissionId: message.submissionId },
      )
      const reference = submissionReference(taken.draft, taken.draft?.turnId)
      const restoreComposer = taken.draft !== undefined && model.input.length === 0
      const settled = settleProvisionalUserEntry(model, reference, true)
      const queue = dropProvisionalQueueItem(settled, taken.draft?.submissionId ?? message.submissionId)
      const remainsBusy = model.activeTurnId !== undefined || taken.rest.length > 0
      const rejected = {
        ...settled,
        ...queue,
        submittedDrafts: taken.rest,
        blocks: [
          ...settled.blocks,
          { _tag: "Error", title: "Message failed", detail: message.message, recovery: "Press Enter to try again." },
        ],
        items: [...settled.items, { _tag: "Block", index: settled.blocks.length }],
        cancelPending: model.activeTurnId === undefined ? false : model.cancelPending,
        busy: remainsBusy,
        activity: settledActivity(model.activeTurnId, model.activity, taken.rest.length),
      }
      return restoreSubmittedComposer(rejected, taken.draft, restoreComposer)
    }
  }
  return undefined
}

const reduceExecutionOverlay = (model: Model, message: Message): Model | undefined =>
  reduceExecutionCompletion(model, message) ?? reduceSubmissionRejection(model, message)

const failedTranscript = (model: Model, turnId: string | undefined, failure: ExecutionFailure) => {
  const alreadyPresented = model.items.filter(isTranscriptItem).some((item) => {
    if (item._tag !== "Block" || (turnId !== undefined && item.turnId !== turnId)) return false
    const block = model.blocks[item.index]
    return isTranscriptBlock(block) && block._tag === "Error"
  })
  if (alreadyPresented) return { blocks: model.blocks, items: model.items }
  return {
    blocks: [...model.blocks, errorBlock(failure)],
    items: [...model.items, { _tag: "Block" as const, index: model.blocks.length }],
  }
}

const settleFailedSubmission = (model: Model, draft: SubmittedDraft | undefined, turnId: string | undefined) => {
  const reference = submissionReference(draft, turnId)
  const beforeStart = draft !== undefined && hasProvisionalUserEntry(model, reference)
  const restore = beforeStart && model.input.length === 0
  const settled = beforeStart ? settleProvisionalUserEntry(model, reference, restore) : model
  return { settled, restore, queue: dropProvisionalQueueItem(settled, draft?.submissionId) }
}

const reduceFailedExecutionOverlay = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "ExecutionFailed": {
      const turnId = message.turnId ?? model.activeTurnId
      const taken = takeSubmittedDraftFor(model.submittedDrafts, turnId === undefined ? {} : { turnId })
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId && taken.draft === undefined)
        return model
      const { settled, restore, queue } = settleFailedSubmission(model, taken.draft, turnId)
      const transcript = failedTranscript(settled, turnId, message.failure)
      const settlesActive = message.turnId === undefined || model.activeTurnId === message.turnId
      const activeTurnId = settlesActive ? undefined : model.activeTurnId
      const remainsBusy = activeTurnId !== undefined || taken.rest.length > 0
      const failed = {
        ...settled,
        ...queue,
        ...transcript,
        submittedDrafts: taken.draft === undefined ? dropSubmittedDrafts(model.submittedDrafts, turnId) : taken.rest,
        cancelPending: settlesActive ? false : model.cancelPending,
        busy: remainsBusy,
        activity: settledActivity(activeTurnId, model.activity, taken.rest.length),
        activeTurnId,
      }
      return restoreSubmittedComposer(failed, taken.draft, restore)
    }
  }
  return undefined
}

const cancelBeforeAdmission = (
  model: Model,
  draft: SubmittedDraft,
  remainingDrafts: ReadonlyArray<SubmittedDraft>,
  turnId: string | undefined,
): Model => {
  const reference = submissionReference(draft, turnId)
  const restore = model.input.length === 0
  const settled = settleProvisionalUserEntry(model, reference, restore)
  const queue = dropProvisionalQueueItem(settled, draft.submissionId)
  const cancelsActive = model.activeTurnId === turnId
  const activeTurnId = cancelsActive ? undefined : model.activeTurnId
  const cancelled = {
    ...settled,
    ...queue,
    submittedDrafts: remainingDrafts,
    blocks: cancelTranscriptBlocks(settled.blocks.filter(isTranscriptBlock)),
    cancelPending: cancelsActive ? false : model.cancelPending,
    busy: activeTurnId !== undefined || remainingDrafts.length > 0,
    activity: settledActivity(activeTurnId, model.activity, remainingDrafts.length),
    activeTurnId,
  }
  return restoreSubmittedComposer(cancelled, draft, restore)
}

const reduceCancelledExecutionOverlay = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "ExecutionCancelled": {
      const turnId = message.turnId ?? model.activeTurnId
      const taken = takeSubmittedDraftFor(model.submittedDrafts, turnId === undefined ? {} : { turnId })
      const reversibleBeforeAdmission =
        message.agentResponseArrived === false || (message.turnId === undefined && model.activeTurnId === undefined)
      if (reversibleBeforeAdmission && taken.draft !== undefined)
        return cancelBeforeAdmission(model, taken.draft, taken.rest, turnId)
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId)
        return model.cancelPending ? { ...model, cancelPending: false } : model
      if (!model.busy) return model
      return {
        ...model,
        submittedDrafts: dropSubmittedDrafts(model.submittedDrafts, turnId),
        cancelPending: false,
        blocks: cancelTranscriptBlocks(model.blocks.filter(isTranscriptBlock)),
        busy: false,
        activity: undefined,
        activeTurnId: undefined,
      }
    }
  }
  return undefined
}

const reduceDetailOverlay = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "DetailMoved": {
      const ids = expandableRowIds(model)
      const count = ids.length
      if (count === 0) return model
      const current = ids.indexOf(model.detailSelection ?? "")
      let nextIndex: number
      if (current < 0) nextIndex = message.offset < 0 ? count - 1 : 0
      else nextIndex = (((current + message.offset) % count) + count) % count
      return { ...model, detailSelection: ids[nextIndex]! }
    }
    case "DetailToggled": {
      const id = message.id ?? model.detailSelection
      if (id === undefined) return model
      if (!expandableRowIds(model).includes(id)) return model
      const expanded = new Set(model.expandedRowKeys)
      if (expanded.has(id)) expanded.delete(id)
      else expanded.add(id)
      return {
        ...model,
        detailSelection: message.id === undefined ? id : model.detailSelection,
        expandedRowKeys: [...expanded],
      }
    }
    case "AllDetailsToggled": {
      const roots = expandableRowIds({ ...model, expandedRowKeys: [] })
      if (roots.length === 0) return model
      const all = expandableRowIds({ ...model, expandedRowKeys: roots })
      const expanded = new Set(model.expandedRowKeys)
      return { ...model, expandedRowKeys: all.every((id) => expanded.has(id)) ? [] : [...all] }
    }
  }
  return undefined
}

const reduceLocalOverlay = (model: Model, message: Message): Model | undefined => {
  const sameChangedFiles = changedFiles.same
  switch (message._tag) {
    case "FastModeToggled":
      return { ...model, fastMode: !model.fastMode }
    case "SidebarViewToggled":
      return { ...model, changedFilesOpen: !model.changedFilesOpen, workspaceFilesOpen: false }
    case "ChangedFilesRequested":
      return model.changedFiles._tag === "Ready" ? model : { ...model, changedFiles: loading }
    case "ChangedFilesReplaced": {
      if (model.changedFiles._tag === "Ready" && sameChangedFiles(model.changedFiles.value, message.files)) return model
      return { ...model, changedFiles: ready([...message.files]) }
    }
    case "ComposerReplaced":
      return {
        ...model,
        input: message.text,
        cursor: message.text.length,
        pastedText: [],
        shortcutsOpen: false,
        shortcutsTrigger: undefined,
      }
  }
  return undefined
}

const matchesPendingThreadPreview = (model: Model, threadId: string, requestId: number): boolean =>
  model.threadPreview._tag === "Loading" &&
  model.threadPreview.threadId === threadId &&
  model.threadPreview.requestId === requestId

const reduceThreadOverlay = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "ThreadPreviewRequested":
      return {
        ...model,
        threadPreview: { _tag: "Loading", threadId: message.threadId, requestId: message.requestId },
      }
    case "ThreadOpenRequested":
      return { ...model, threadLoading: true }
    case "ThreadOpenCompleted":
      return { ...model, threadLoading: false }
    case "ThreadRefolding": {
      const others = model.refoldingThreadIds.filter((threadId) => threadId !== message.threadId)
      return { ...model, refoldingThreadIds: message.refolding ? [...others, message.threadId] : others }
    }
    case "ThreadPreviewLoaded":
      if (!matchesPendingThreadPreview(model, message.threadId, message.requestId)) return model
      return {
        ...model,
        threadPreview: {
          _tag: "Ready",
          value: {
            threadId: message.threadId,
            requestId: message.requestId,
            units: [...message.units],
          },
        },
      }
    case "ThreadPreviewFailed":
      if (!matchesPendingThreadPreview(model, message.threadId, message.requestId)) return model
      return {
        ...model,
        threadPreview: {
          _tag: "Failed",
          threadId: message.threadId,
          requestId: message.requestId,
          message: message.message,
        },
      }
  }
  return undefined
}

const reduceOverlayImpl = (
  model: Model,
  message: Message,
  _reduce: (model: Model, message: Message) => Model,
): Model | undefined =>
  reduceStreamingOverlay(model, message) ??
  reduceExecutionOverlay(model, message) ??
  reduceFailedExecutionOverlay(model, message) ??
  reduceCancelledExecutionOverlay(model, message) ??
  reduceDetailOverlay(model, message) ??
  reduceLocalOverlay(model, message) ??
  reduceThreadOverlay(model, message)

const errorTitle = (failure: { readonly tag: string }): string => {
  switch (failure.tag) {
    case "StartTurnFailure":
      return "Could not start the turn"
    case "SteeringFailure":
      return "Steering not delivered"
    case "CancelTurnFailure":
      return "Cancellation not completed"
    case "QueueFull":
      return "Queue is full"
    case "TransportDisconnected":
      return "Connection to the server was lost"
    default:
      return failure.tag
  }
}

const errorBlock = (failure: ExecutionFailure): TranscriptBlock => ({
  _tag: "Error",
  title: errorTitle(failure),
  detail: failure.message,
  category: failure.category,
  retryable: failure.retryable,
})

export const reduceOverlay: {
  (
    arg1: Parameters<typeof reduceOverlayImpl>[1],
    arg2: Parameters<typeof reduceOverlayImpl>[2],
  ): (arg0: Parameters<typeof reduceOverlayImpl>[0]) => ReturnType<typeof reduceOverlayImpl>
  (
    arg0: Parameters<typeof reduceOverlayImpl>[0],
    arg1: Parameters<typeof reduceOverlayImpl>[1],
    arg2: Parameters<typeof reduceOverlayImpl>[2],
  ): ReturnType<typeof reduceOverlayImpl>
} = Function.dual(3, reduceOverlayImpl)
