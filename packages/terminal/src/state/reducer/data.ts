import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"
import { Function, Option, Schema } from "effect"
import type { Message } from "../message"
import type { Model } from "../model"
import { idle, loading, ready } from "../loadable"
import { runningToolsActivity, streamActivity, type Activity } from "../activity/model"
import { filteredFiles, filteredThreads, selectedThreadMetadata, renameThread } from "../thread/navigation"
import { composerEdit } from "../composer/edit"

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
type ReplayedEvent = Extract<Message, { readonly _tag: "EventReplayed" }>["event"]

const reduceComposerData = (model: Model, message: Message): Model | undefined => {
  const { continueShortcutsAfterEdit, expandPastedTextAttachment, insertImage, insertPaste, removeImage } = composerEdit
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
  }
  return undefined
}

const reduceThreadReplacement = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
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
  }
  return undefined
}

const reduceThreadSelection = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
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
  }
  return undefined
}

const reduceThreadData = (model: Model, message: Message): Model | undefined =>
  reduceThreadReplacement(model, message) ?? reduceThreadSelection(model, message)

const reduceWorkspaceData = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
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
  }
  return undefined
}

const replayedItem = (event: ReplayedEvent, index: number): Model["items"][number] => ({
  _tag: "Block",
  index,
  id: event.id,
  turnId: event.turnId,
})

const appendReplayedBlock = (
  blocks: ReadonlyArray<TranscriptPresentationModel.Block>,
  items: ReadonlyArray<Model["items"][number]>,
  event: ReplayedEvent,
) => ({
  blocks: [...blocks, event.block],
  items: [...items, replayedItem(event, blocks.length)],
})

const replayToolResult = (
  blocks: ReadonlyArray<TranscriptPresentationModel.Block>,
  items: ReadonlyArray<Model["items"][number]>,
  event: ReplayedEvent,
) => {
  if (event.block._tag !== "ToolResult") return undefined
  const incoming = event.block
  const index = blocks.findIndex((candidate) => candidate._tag === "ToolCall" && candidate.id === incoming.id)
  if (index < 0) return appendReplayedBlock(blocks, items, event)
  const requested = blocks[index]
  if (requested?._tag !== "ToolCall") return undefined
  const updated = [...blocks]
  updated[index] = {
    ...requested,
    result: incoming.output,
    status: incoming.failed ? "failed" : "complete",
  }
  return { blocks: updated, items }
}

const replayToolCall = (
  blocks: ReadonlyArray<TranscriptPresentationModel.Block>,
  items: ReadonlyArray<Model["items"][number]>,
  event: ReplayedEvent,
) => {
  if (event.block._tag !== "ToolCall") return undefined
  const incoming = event.block
  const index = blocks.findIndex((candidate) => candidate._tag === "ToolCall" && candidate.id === incoming.id)
  if (index < 0) return appendReplayedBlock(blocks, items, event)
  const updated = [...blocks]
  updated[index] = incoming
  return { blocks: updated, items }
}

const replayTranscriptEvent = (model: Model, event: ReplayedEvent) => {
  const blocks = model.blocks.map((block) => decodeTranscriptBlock(block))
  const items = [...model.items]
  const lastItem = Option.getOrUndefined(decodeTranscriptItem(items.at(-1)))
  const last = lastItem?._tag === "Block" ? blocks[lastItem.index] : undefined
  if (
    event.block._tag === "Reasoning" &&
    last?._tag === "Reasoning" &&
    lastItem?._tag === "Block" &&
    lastItem.turnId === event.turnId
  ) {
    blocks[lastItem.index] = { ...last, text: last.text + event.block.text }
    return { blocks, items }
  }
  if (event.block._tag === "ToolResult") return replayToolResult(blocks, items, event)
  if (event.block._tag === "ToolCall") return replayToolCall(blocks, items, event)
  return appendReplayedBlock(blocks, items, event)
}

const replayedActivity = (
  model: Model,
  blocks: ReadonlyArray<TranscriptPresentationModel.Block>,
  items: ReadonlyArray<Model["items"][number]>,
  incoming: TranscriptPresentationModel.Block,
): Activity => {
  if (incoming._tag === "ToolCall" || incoming._tag === "Cell") return runningToolsActivity({ ...model, blocks, items })
  if (incoming._tag === "ToolResult") return { _tag: "Waiting" }
  if (incoming._tag === "Compaction")
    return incoming.status === "running" ? { _tag: "Compacting" } : { _tag: "Waiting" }
  if (incoming._tag === "Reasoning") return streamActivity(model.activity, "Thinking", incoming.text, undefined)
  return model.activity ?? { _tag: "Waiting" }
}

const reduceReplayedEvent = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "EventReplayed": {
      if (model.seenEventIds.includes(message.event.id)) return model
      const transcript = replayTranscriptEvent(model, message.event)
      if (transcript === undefined) return model
      const replayed = {
        ...model,
        ...transcript,
        seenEventIds: [...model.seenEventIds, message.event.id],
        eventCursor: message.event.cursor,
      }
      return model.busy
        ? { ...replayed, activity: replayedActivity(model, transcript.blocks, transcript.items, message.event.block) }
        : replayed
    }
  }
  return undefined
}

const reduceDataImpl = (
  model: Model,
  message: Message,
  _reduce: (model: Model, message: Message) => Model,
): Model | undefined =>
  reduceComposerData(model, message) ??
  reduceThreadData(model, message) ??
  reduceWorkspaceData(model, message) ??
  reduceReplayedEvent(model, message)

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
