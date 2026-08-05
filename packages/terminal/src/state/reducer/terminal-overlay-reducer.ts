import { Function } from "effect"
import type { Message } from "../model/terminal-message"
import type { Model } from "../model/terminal-state"
import type { TranscriptBlock, TranscriptItem } from "../model/terminal-transcript-state"
import { ready, loading } from "../model/terminal-loadable-state"
import { streamActivity } from "../model/terminal-activity-state"
import { dropSubmittedDrafts, settleSteering, takeSubmittedDraft } from "../model/terminal-queue-state"
import { expandableRowIds, transcriptUnits, transcriptUnitId } from "../../presentation/transcript/transcript-row"
import { context } from "./terminal-state-reducer"

const reduceOverlayImpl = (
  model: Model,
  message: Message,
  _reduce: (model: Model, message: Message) => Model,
): Model | undefined => {
  const { cancelTranscriptBlocks, sameChangedFiles } = context
  switch (message._tag) {
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
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId) return model
      const settled = settleSteering(model, message.turnId ?? model.activeTurnId)
      return {
        ...model,
        submittedDrafts: dropSubmittedDrafts(model.submittedDrafts, message.turnId),
        pendingSteering: settled.pendingSteering,
        ...(settled.restoredInput === undefined
          ? {}
          : { input: settled.restoredInput, cursor: settled.restoredInput.length }),
        cancelPending: false,
        busy: false,
        activity: undefined,
        activeTurnId: undefined,
      }
    }
    case "ExecutionFailed": {
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId) return model
      const alreadyPresented = (model.items as ReadonlyArray<TranscriptItem>).some(
        (item) =>
          item._tag === "Block" &&
          (message.turnId === undefined || item.turnId === message.turnId) &&
          (model.blocks[item.index] as TranscriptBlock | undefined)?._tag === "Error",
      )
      return {
        ...model,
        blocks: alreadyPresented
          ? model.blocks
          : [
              ...model.blocks,
              {
                _tag: "Error",
                title: "Message failed",
                detail: message.message,
                recovery: "Press Enter to try again.",
              },
            ],
        items: alreadyPresented ? model.items : [...model.items, { _tag: "Block", index: model.blocks.length }],
        submittedDrafts: dropSubmittedDrafts(model.submittedDrafts, message.turnId),
        pendingSteering: settleSteering(model, message.turnId ?? model.activeTurnId).pendingSteering,
        cancelPending: false,
        busy: false,
        activity: undefined,
        activeTurnId: undefined,
      }
    }
    case "ExecutionCancelled": {
      const turnId = message.turnId ?? model.activeTurnId
      const taken = takeSubmittedDraft(model.submittedDrafts, turnId)
      if (message.agentResponseArrived === false && taken.draft !== undefined) {
        const draft = taken.draft
        return {
          ...model,
          ...(model.input.length === 0
            ? { input: draft.input, cursor: draft.cursor, pastedText: draft.attachments }
            : {}),
          submittedDrafts: taken.rest,
          pendingSteering: settleSteering(model, turnId).pendingSteering,
          blocks: cancelTranscriptBlocks(model.blocks as ReadonlyArray<TranscriptBlock>),
          cancelPending: model.activeTurnId === turnId ? false : model.cancelPending,
          busy: model.activeTurnId === turnId ? false : model.busy,
          activity: model.activeTurnId === turnId ? undefined : model.activity,
          activeTurnId: model.activeTurnId === turnId ? undefined : model.activeTurnId,
        }
      }
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId) return model
      if (!model.busy) return model
      const cancelSettled = settleSteering(model, turnId)
      return {
        ...model,
        submittedDrafts: dropSubmittedDrafts(model.submittedDrafts, turnId),
        pendingSteering: cancelSettled.pendingSteering,
        cancelPending: false,
        ...(cancelSettled.restoredInput === undefined
          ? {}
          : { input: cancelSettled.restoredInput, cursor: cancelSettled.restoredInput.length }),
        blocks: cancelTranscriptBlocks(model.blocks as ReadonlyArray<TranscriptBlock>),
        busy: false,
        activity: undefined,
        activeTurnId: undefined,
      }
    }
    case "UsageReported":
      return message.costUsd === undefined ? model : { ...model, costUsd: (model.costUsd ?? 0) + message.costUsd }
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
    case "ThreadPreviewRequested": {
      let previous: Extract<Model["threadPreview"], { _tag: "Ready" }>["value"] | undefined
      if (model.threadPreview._tag === "Ready") previous = model.threadPreview.value
      else if (model.threadPreview._tag === "Loading") previous = model.threadPreview.previous
      return {
        ...model,
        threadPreview: { _tag: "Loading", ...(previous === undefined ? {} : { previous }) },
        threadSwitcher: { ...model.threadSwitcher, previewScroll: 0 },
      }
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
      return {
        ...model,
        threadPreview: ready({
          threadId: message.threadId,
          turns: message.turns.map((turn) => ({ prompt: turn.prompt, units: [...turn.units] })),
        }),
      }
    case "ThreadPreviewFailed":
      return { ...model, threadPreview: { _tag: "Failed", message: message.message } }
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
