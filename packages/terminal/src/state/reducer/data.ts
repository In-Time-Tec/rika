import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"
import { Function, Option, Schema } from "effect"
import type { Message } from "../message"
import type { Model } from "../model"
import { idle, loading, ready } from "../loadable"
import { runningToolsActivity, streamActivity, type Activity } from "../activity/model"
import { filteredFiles, filteredThreads, selectedThreadMetadata, renameThread } from "../thread/navigation"
import { context } from "./model"

const decodeTranscriptBlock = Schema.decodeUnknownSync(TranscriptPresentationModel.Block)
const ThreadItemSchema = Schema.Struct({
  archived: Schema.Boolean,
  id: Schema.String,
  lastActivityAt: Schema.Finite,
  pinned: Schema.Boolean,
  status: Schema.Literals(["idle", "error", "queued", "running"]),
  title: Schema.String,
  unread: Schema.Boolean,
  workspace: Schema.String,
  editTotals: Schema.optionalKey(
    Schema.Struct({ added: Schema.Finite, modified: Schema.Finite, removed: Schema.Finite }),
  ),
})
const decodeThreadItem = Schema.decodeUnknownSync(ThreadItemSchema)
const decodeTranscriptItem = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.TaggedStruct("Entry", {
      id: Schema.optionalKey(Schema.String),
      index: Schema.Finite,
      turnId: Schema.optionalKey(Schema.String),
    }),
    Schema.TaggedStruct("Block", {
      id: Schema.optionalKey(Schema.String),
      index: Schema.Finite,
      turnId: Schema.optionalKey(Schema.String),
    }),
  ]),
)

const reduceDataImpl = (
  model: Model,
  message: Message,
  _reduce: (model: Model, message: Message) => Model,
): Model | undefined => {
  const { continueShortcutsAfterEdit, insertPaste, insertImage, removeImage, expandPastedTextAttachment } = context
  switch (message._tag) {
    case "Pasted": {
      const next = insertPaste(model, message.text)
      return model.shortcutsOpen ? continueShortcutsAfterEdit(model, next) : next
    }
    case "ImageInserted":
      return insertImage(model, message.path)
    case "ImageRemoved":
      return removeImage(model, message.path)
    case "PastedTextExpanded":
      return expandPastedTextAttachment(model, message.token)
    case "ThreadsReplaced": {
      const selectedThread = Schema.decodeUnknownOption(ThreadItemSchema)(model.threads[model.threadSidebar.selected])
      const selectedId = Option.getOrUndefined(selectedThread)?.id
      const browserSelectedId = selectedThreadMetadata(model)?.id
      const selected = Math.max(
        0,
        selectedId === undefined ? 0 : message.threads.findIndex((thread) => thread.id === selectedId),
      )
      const boundedSelected = Math.min(selected, Math.max(0, message.threads.length - 1))
      const maximumScrollTop = Math.max(0, message.threads.length - model.height)
      const boundedScrollTop = Math.min(model.threadSidebar.scrollTop, maximumScrollTop)
      const replacedThreads = {
        ...model,
        threads: [...message.threads],
        threadSidebar: {
          ...model.threadSidebar,
          selected: boundedSelected,
          scrollTop: Math.min(boundedScrollTop, boundedSelected),
        },
      }
      const browserThreads = filteredThreads(replacedThreads)
      const browserSelected = Math.max(
        0,
        browserSelectedId === undefined ? 0 : browserThreads.findIndex((thread) => thread.id === browserSelectedId),
      )
      const browserThread = browserThreads[browserSelected]
      let previewThreadId: string | undefined
      if (model.threadPreview._tag === "Ready") previewThreadId = model.threadPreview.value.threadId
      else if (model.threadPreview._tag === "Loading" || model.threadPreview._tag === "Failed")
        previewThreadId = model.threadPreview.threadId
      return {
        ...replacedThreads,
        threadSwitcher: {
          ...replacedThreads.threadSwitcher,
          selected: Math.min(browserSelected, Math.max(0, browserThreads.length - 1)),
        },
        threadPreview:
          model.threadSwitcher.open && browserThread?.id !== previewThreadId ? { _tag: "Idle" } : model.threadPreview,
      }
    }
    case "ThreadActivated":
      return {
        ...model,
        currentThreadId: message.threadId,
        currentThreadTitle: message.title,
      }
    case "ThreadTitleChanged":
      return {
        ...model,
        currentThreadTitle: model.currentThreadId === message.threadId ? message.title : model.currentThreadTitle,
        threads: renameThread(
          model.threads.map((thread) => decodeThreadItem(thread)),
          message.threadId,
          message.title,
        ),
      }
    case "FilesRequested":
      return model.filePicker.items._tag === "Ready"
        ? model
        : { ...model, filePicker: { ...model.filePicker, items: loading, error: undefined } }
    case "FilesFailed":
      return { ...model, filePicker: { ...model.filePicker, items: idle, error: message.message } }
    case "FilesReplaced": {
      const replacedFiles = {
        ...model,
        filePicker: { ...model.filePicker, items: ready([...message.files]), error: undefined },
      }
      return {
        ...replacedFiles,
        filePicker: {
          ...replacedFiles.filePicker,
          selected: Math.min(replacedFiles.filePicker.selected, Math.max(0, filteredFiles(replacedFiles).length - 1)),
        },
      }
    }
    case "BranchDetected":
      return { ...model, branch: message.branch }
    case "GoalChanged":
      return { ...model, goal: message.goal }
    case "WorkspaceFilesToggled":
      return { ...model, workspaceFilesOpen: !model.workspaceFilesOpen, changedFilesOpen: false }
    case "ThreadSidebarSelectionMoved": {
      const selected = Math.max(0, Math.min(model.threads.length - 1, model.threadSidebar.selected + message.offset))
      let scrollTop = model.threadSidebar.scrollTop
      if (selected < model.threadSidebar.scrollTop) scrollTop = selected
      else if (selected >= model.threadSidebar.scrollTop + model.height) scrollTop = selected - model.height + 1
      return { ...model, threadSidebar: { ...model.threadSidebar, selected, scrollTop } }
    }
    case "ThreadSidebarSelectionConfirmed": {
      const index = message.index ?? model.threadSidebar.selected
      const thread = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))(model.threads[index])
      const selectedThread = Option.getOrUndefined(thread)
      return selectedThread === undefined
        ? model
        : {
            ...model,
            threadSidebar: { ...model.threadSidebar, selected: index },
            pendingAction:
              selectedThread.id === model.currentThreadId ? undefined : { _tag: "SelectThread", id: selectedThread.id },
          }
    }
    case "EventReplayed":
      if (model.seenEventIds.includes(message.event.id)) return model
      {
        const incoming = message.event.block
        const blocks = model.blocks.map((block) => decodeTranscriptBlock(block))
        const items = [...model.items]
        const lastItem = Option.getOrUndefined(decodeTranscriptItem(items.at(-1)))
        const last = lastItem?._tag === "Block" ? blocks[lastItem.index] : undefined
        if (
          incoming._tag === "Reasoning" &&
          last?._tag === "Reasoning" &&
          lastItem?._tag === "Block" &&
          lastItem.turnId === message.event.turnId
        )
          blocks[lastItem.index] = { ...last, text: last.text + incoming.text }
        else if (incoming._tag === "ToolResult") {
          const index = blocks.findIndex((candidate) => candidate._tag === "ToolCall" && candidate.id === incoming.id)
          if (index >= 0) {
            const requested = blocks[index]
            if (requested?._tag !== "ToolCall") return model
            blocks[index] = {
              ...requested,
              result: incoming.output,
              status: incoming.failed ? "failed" : "complete",
            }
          } else {
            items.push({
              _tag: "Block",
              index: blocks.length,
              id: message.event.id,
              turnId: message.event.turnId,
            })
            blocks.push(incoming)
          }
        } else if (incoming._tag === "ToolCall") {
          const index = blocks.findIndex((candidate) => candidate._tag === "ToolCall" && candidate.id === incoming.id)
          if (index >= 0) blocks[index] = incoming
          else {
            items.push({
              _tag: "Block",
              index: blocks.length,
              id: message.event.id,
              turnId: message.event.turnId,
            })
            blocks.push(incoming)
          }
        } else {
          items.push({
            _tag: "Block",
            index: blocks.length,
            id: message.event.id,
            turnId: message.event.turnId,
          })
          blocks.push(incoming)
        }
        const activityForIncomingBlock = (): Activity => {
          if (incoming._tag === "ToolCall" || incoming._tag === "Cell")
            return runningToolsActivity({ ...model, blocks, items })
          if (incoming._tag === "ToolResult") return { _tag: "Waiting" }
          if (incoming._tag === "Compaction") {
            return incoming.status === "running" ? { _tag: "Compacting" } : { _tag: "Waiting" }
          }
          if (incoming._tag === "Reasoning") {
            return streamActivity(model.activity, "Thinking", incoming.text, undefined)
          }
          return model.activity ?? { _tag: "Waiting" }
        }
        const replayed = {
          ...model,
          blocks,
          items,
          seenEventIds: [...model.seenEventIds, message.event.id],
          eventCursor: message.event.cursor,
        }
        return model.busy ? { ...replayed, activity: activityForIncomingBlock() } : replayed
      }
  }
  return undefined
}

export const reduceData: {
  (
    arg1: Parameters<typeof reduceDataImpl>[1],
    arg2: Parameters<typeof reduceDataImpl>[2],
  ): (arg0: Parameters<typeof reduceDataImpl>[0]) => ReturnType<typeof reduceDataImpl>
  (
    arg0: Parameters<typeof reduceDataImpl>[0],
    arg1: Parameters<typeof reduceDataImpl>[1],
    arg2: Parameters<typeof reduceDataImpl>[2],
  ): ReturnType<typeof reduceDataImpl>
} = Function.dual(3, reduceDataImpl)
