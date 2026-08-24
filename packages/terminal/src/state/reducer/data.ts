import { Function } from "effect"
import type { Message } from "../message"
import type { Model } from "../model"
import type { TranscriptBlock, TranscriptItem } from "../transcript/model"
import type { ThreadItem } from "../thread/model"
import { idle, loading, ready } from "../loadable"
import { runningToolsActivity, streamActivity, type Activity } from "../activity/model"
import {
  filteredFiles,
  filteredThreads,
  selectedThreadMetadata,
  renameThread,
} from "../thread/navigation"
import { context } from "./model"

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
      const selectedId = (model.threads as ReadonlyArray<ThreadItem>)[model.threadSidebar.selected]?.id
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
        ...(model.threadSwitcher.open && browserThread?.id !== previewThreadId
          ? { threadPreview: { _tag: "Idle" as const } }
          : {}),
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
        threads: renameThread(model.threads as ReadonlyArray<ThreadItem>, message.threadId, message.title),
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
      const thread = (model.threads as ReadonlyArray<ThreadItem>)[index]
      return thread === undefined
        ? model
        : {
            ...model,
            threadSidebar: { ...model.threadSidebar, selected: index },
            pendingAction: thread.id === model.currentThreadId ? undefined : { _tag: "SelectThread", id: thread.id },
          }
    }
    case "EventReplayed":
      if (model.seenEventIds.includes(message.event.id)) return model
      {
        const incoming = message.event.block
        const blocks = [...model.blocks] as Array<TranscriptBlock>
        let items = [...model.items] as Array<TranscriptItem>
        const lastItem = items.at(-1)
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
            const requested = blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
            blocks[index] = {
              ...requested,
              output: incoming.output,
              status: incoming.failed ? "failed" : "complete",
            }
          } else {
            items.push({
              _tag: "Block",
              index: blocks.length,
              id: message.event.id,
              ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
            })
            blocks.push(incoming)
          }
        } else if (incoming._tag === "ToolCall") {
          const index = blocks.findIndex((candidate) => candidate._tag === "ToolCall" && candidate.id === incoming.id)
          if (index >= 0) blocks[index] = { ...(blocks[index] as typeof incoming), ...incoming }
          else {
            items.push({
              _tag: "Block",
              index: blocks.length,
              id: message.event.id,
              ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
            })
            blocks.push(incoming)
          }
        } else {
          items.push({
            _tag: "Block",
            index: blocks.length,
            id: message.event.id,
            ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
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
        return {
          ...model,
          blocks,
          items,
          seenEventIds: [...model.seenEventIds, message.event.id],
          eventCursor: message.event.cursor,
          ...(model.busy ? { activity: activityForIncomingBlock() } : {}),
        }
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
