import { Function } from "effect"
import type { Message } from "../model/terminal-message"
import type { Model } from "../model/terminal-state"
import type { TranscriptBlock, TranscriptItem } from "../model/terminal-transcript-state"
import { ready, loading } from "../model/terminal-loadable-state"
import { streamActivity } from "../model/terminal-activity-state"
import { dropSubmittedDrafts, takeSubmittedDraftFor, validQueueSelection } from "../model/terminal-queue-state"
import { hasProvisionalUserEntry, settleProvisionalUserEntry } from "../model/terminal-submission-state"
import { expandableRowIds, transcriptUnits, transcriptUnitId } from "../../presentation/transcript/transcript-row"
import { context } from "./terminal-state-reducer"

const dropProvisionalQueueItem = (model: Model, submissionId: string | undefined) => {
  if (submissionId === undefined) return { queue: model.queue, queueSelection: model.queueSelection }
  const queue = model.queue.filter((item) => item.id !== submissionId || item.provisional !== true)
  return { queue, queueSelection: validQueueSelection(model.queueSelection, queue) }
}

const settledActivity = (
  activeTurnId: string | undefined,
  activity: Model["activity"],
  pendingDrafts: number,
): Model["activity"] => {
  if (activeTurnId !== undefined) return activity
  if (pendingDrafts > 0) return { _tag: "Sending" }
  return undefined
}

const reduceOverlayImpl = (
  model: Model,
  message: Message,
  _reduce: (model: Model, message: Message) => Model,
): Model | undefined => {
  const { cancelTranscriptBlocks, sameChangedFiles } = context
  switch (message._tag) {
    case "ConnectionStateChanged":
      return { ...model, connection: message.state }
    case "ReasoningStreamed": {
      const blocks = [...model.blocks] as Array<TranscriptBlock>
      const lastItem = model.items.at(-1) as TranscriptItem | undefined
      const last = lastItem?._tag === "Block" ? blocks[lastItem.index] : undefined
      if (last?._tag === "Reasoning" && lastItem?._tag === "Block")
        blocks[lastItem.index] = { ...last, text: last.text + message.text }
      else {
        blocks.push({ _tag: "Reasoning", text: message.text })
        return {
          ...model,
          blocks,
          items: [...model.items, { _tag: "Block", index: model.blocks.length }],
          ...(model.busy ? { activity: streamActivity(model.activity, "Thinking", message.text, undefined) } : {}),
        }
      }
      return {
        ...model,
        blocks,
        ...(model.busy ? { activity: streamActivity(model.activity, "Thinking", message.text, undefined) } : {}),
      }
    }
    case "ReasoningToggled": {
      const unit = transcriptUnits(model).find(
        (candidate) => candidate.kind === "reasoning" && candidate.block === message.index,
      )
      if (unit === undefined) return model
      const id = transcriptUnitId(model, unit)
      const expanded = new Set(model.expandedRowKeys)
      if (expanded.has(id)) expanded.delete(id)
      else expanded.add(id)
      return { ...model, expandedRowKeys: [...expanded] }
    }
    case "PaletteActionConsumed":
      return { ...model, pendingAction: undefined }
    case "AssistantStreamed": {
      const entries = [...model.entries]
      const lastItem = (model.items as ReadonlyArray<TranscriptItem>).findLast(
        (item) => message.turnId === undefined || item.turnId === message.turnId,
      ) as TranscriptItem | undefined
      const index =
        lastItem?._tag === "Entry" &&
        entries[lastItem.index]?.role === "assistant" &&
        (message.turnId !== undefined || model.activity?._tag === "Streaming")
          ? lastItem.index
          : -1
      if (index >= 0) entries[index] = { ...entries[index]!, text: entries[index]!.text + message.text }
      else
        entries.push({
          role: "assistant",
          text: message.text,
          ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        })
      return {
        ...model,
        entries,
        items:
          index >= 0
            ? model.items
            : [
                ...model.items,
                {
                  _tag: "Entry",
                  index: entries.length - 1,
                  ...(message.id === undefined ? {} : { id: message.id }),
                  ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
                } as const,
              ],
        busy: true,
        activity: streamActivity(model.activity, "Streaming", message.text, undefined),
      }
    }
    case "AssistantCompleted": {
      const entries = [...model.entries]
      const lastItem = (model.items as ReadonlyArray<TranscriptItem>).findLast(
        (item) => message.turnId === undefined || item.turnId === message.turnId,
      ) as TranscriptItem | undefined
      const index =
        lastItem?._tag === "Entry" &&
        entries[lastItem.index]?.role === "assistant" &&
        (message.turnId !== undefined || model.activity?._tag === "Streaming")
          ? lastItem.index
          : -1
      if (index >= 0) entries[index] = { ...entries[index]!, text: message.text }
      else
        entries.push({
          role: "assistant",
          text: message.text,
          ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        })
      return {
        ...model,
        entries,
        items:
          index >= 0
            ? model.items
            : [
                ...model.items,
                {
                  _tag: "Entry",
                  index: entries.length - 1,
                  ...(message.id === undefined ? {} : { id: message.id }),
                  turnId: message.turnId,
                },
              ],
        busy: model.busy,
        activity: model.busy && model.activeTurnId !== undefined ? { _tag: "Waiting" } : undefined,
      }
    }
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
    case "SubmissionRejected": {
      const taken = takeSubmittedDraftFor(
        model.submittedDrafts,
        message.submissionId === undefined ? {} : { submissionId: message.submissionId },
      )
      const reference = {
        ...(taken.draft?.submissionId === undefined ? {} : { submissionId: taken.draft.submissionId }),
        ...(taken.draft?.turnId === undefined ? {} : { turnId: taken.draft.turnId }),
      }
      const restore = taken.draft !== undefined && model.input.length === 0
      const settled = settleProvisionalUserEntry(model, reference, restore)
      const queue = dropProvisionalQueueItem(settled, taken.draft?.submissionId ?? message.submissionId)
      const remainsBusy = model.activeTurnId !== undefined || taken.rest.length > 0
      return {
        ...settled,
        ...queue,
        ...(restore
          ? {
              input: taken.draft!.input,
              cursor: taken.draft!.cursor,
              pastedText: taken.draft!.attachments,
            }
          : {}),
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
    case "ExecutionFailed": {
      const turnId = message.turnId ?? model.activeTurnId
      const taken = takeSubmittedDraftFor(model.submittedDrafts, turnId === undefined ? {} : { turnId })
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId && taken.draft === undefined)
        return model
      const reference = {
        ...(taken.draft?.submissionId === undefined ? {} : { submissionId: taken.draft.submissionId }),
        ...(turnId === undefined ? {} : { turnId }),
      }
      const beforeStart = taken.draft !== undefined && hasProvisionalUserEntry(model, reference)
      const restore = beforeStart && model.input.length === 0
      const settled = beforeStart ? settleProvisionalUserEntry(model, reference, restore) : model
      const queue = dropProvisionalQueueItem(settled, taken.draft?.submissionId)
      const alreadyPresented = (settled.items as ReadonlyArray<TranscriptItem>).some(
        (item) =>
          item._tag === "Block" &&
          (turnId === undefined || item.turnId === turnId) &&
          (settled.blocks[item.index] as TranscriptBlock | undefined)?._tag === "Error",
      )
      const settlesActive = message.turnId === undefined || model.activeTurnId === message.turnId
      const activeTurnId = settlesActive ? undefined : model.activeTurnId
      const remainsBusy = activeTurnId !== undefined || taken.rest.length > 0
      return {
        ...settled,
        ...queue,
        ...(restore
          ? {
              input: taken.draft!.input,
              cursor: taken.draft!.cursor,
              pastedText: taken.draft!.attachments,
            }
          : {}),
        blocks: alreadyPresented ? settled.blocks : [...settled.blocks, errorBlock(message.failure)],
        items: alreadyPresented ? settled.items : [...settled.items, { _tag: "Block", index: settled.blocks.length }],
        submittedDrafts: taken.draft === undefined ? dropSubmittedDrafts(model.submittedDrafts, turnId) : taken.rest,
        cancelPending: settlesActive ? false : model.cancelPending,
        busy: remainsBusy,
        activity: settledActivity(activeTurnId, model.activity, taken.rest.length),
        activeTurnId,
      }
    }
    case "ExecutionCancelled": {
      const turnId = message.turnId ?? model.activeTurnId
      const taken = takeSubmittedDraftFor(model.submittedDrafts, turnId === undefined ? {} : { turnId })
      const reversibleBeforeAdmission =
        message.agentResponseArrived === false || (message.turnId === undefined && model.activeTurnId === undefined)
      if (reversibleBeforeAdmission && taken.draft !== undefined) {
        const draft = taken.draft
        const reference = {
          ...(draft.submissionId === undefined ? {} : { submissionId: draft.submissionId }),
          ...(turnId === undefined ? {} : { turnId }),
        }
        const restore = model.input.length === 0
        const settled = settleProvisionalUserEntry(model, reference, restore)
        const queue = dropProvisionalQueueItem(settled, draft.submissionId)
        const cancelsActive = model.activeTurnId === turnId
        const activeTurnId = cancelsActive ? undefined : model.activeTurnId
        const remainsBusy = activeTurnId !== undefined || taken.rest.length > 0
        return {
          ...settled,
          ...queue,
          ...(restore ? { input: draft.input, cursor: draft.cursor, pastedText: draft.attachments } : {}),
          submittedDrafts: taken.rest,
          blocks: cancelTranscriptBlocks(settled.blocks as ReadonlyArray<TranscriptBlock>),
          cancelPending: cancelsActive ? false : model.cancelPending,
          busy: remainsBusy,
          activity: settledActivity(activeTurnId, model.activity, taken.rest.length),
          activeTurnId,
        }
      }
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId) return model
      if (!model.busy) return model
      return {
        ...model,
        submittedDrafts: dropSubmittedDrafts(model.submittedDrafts, turnId),
        cancelPending: false,
        blocks: cancelTranscriptBlocks(model.blocks as ReadonlyArray<TranscriptBlock>),
        busy: false,
        activity: undefined,
        activeTurnId: undefined,
      }
    }
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
      if (
        model.threadPreview._tag !== "Loading" ||
        model.threadPreview.threadId !== message.threadId ||
        model.threadPreview.requestId !== message.requestId
      )
        return model
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
      if (
        model.threadPreview._tag !== "Loading" ||
        model.threadPreview.threadId !== message.threadId ||
        model.threadPreview.requestId !== message.requestId
      )
        return model
      return {
        ...model,
        threadPreview: {
          _tag: "Failed",
          threadId: message.threadId,
          requestId: message.requestId,
          message: message.message,
        },
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

const errorBlock = (failure: {
  readonly tag: string
  readonly category: string
  readonly message: string
  readonly retryable: boolean
}) => ({
  _tag: "Error" as const,
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
