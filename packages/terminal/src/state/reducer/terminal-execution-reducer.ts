import { Function } from "effect"
import type { Message } from "../model/terminal-message"
import type {
  Model,
  TranscriptBlock,
  TranscriptItem,
  ThreadItem,
  QueueItem,
  ChangedFile,
} from "../model/terminal-state"
import { idle, loading, ready, readyOr } from "../model/terminal-loadable-state"
import { runningToolsActivity, streamActivity, type Activity } from "../model/terminal-activity-state"
import {
  classifyPrompt,
  expandPastedText,
  type ComposerAttachment,
  type PromptPart,
} from "../model/terminal-composer-state"
import {
  filteredFiles,
  filteredThreads,
  selectedThreadMetadata,
  renameThread,
} from "../model/terminal-thread-navigation"
import { composerHeight, clampSidebarWidth, wrappedRowCount, composerHeightLimit } from "../model/terminal-layout-state"
import {
  bindSubmittedDraft,
  dropSubmittedDrafts,
  settleSteering,
  takeSubmittedDraft,
  validQueueSelection,
} from "../model/terminal-queue-state"
import { filter, type PaletteAction } from "../../presentation/terminal/command-palette"
import { isPrintable, type Key } from "../../presentation/terminal/terminal-keymap"
import {
  expandableRowIds,
  rows as transcriptUnits,
  unitId as transcriptUnitId,
} from "../../presentation/transcript/terminal-transcript-presentation"
import {
  isDeliveredDelegationOutput,
  isFailedDelegationOutput,
  isSucceededDelegationOutput,
} from "../../presentation/transcript/transcript-row"
import { context } from "./terminal-state-reducer"

export const reduceExecution = (
  model: Model,
  message: Message,
  reduce: (model: Model, message: Message) => Model,
): Model | undefined => {
  const update = reduce
  const {
    sameChangedFiles,
    cancelTranscriptBlocks,
    insert,
    erase,
    lastCharacterLength,
    fileMention,
    questionKey,
    composerContext,
    continueShortcutsAfterEdit,
    insertWhileShortcutsOpen,
    pastedImagePath,
    pastedMention,
    insertPaste,
    insertImage,
    removeImage,
    expandPastedTextAttachment,
  } = context
  switch (message._tag) {
    case "Resized":
      return {
        ...model,
        width: message.width,
        height: message.height,
        composerHeight: Math.min(model.composerHeight, composerHeightLimit(message.height)),
        sidebarWidth: clampSidebarWidth(model.sidebarWidth, message.width),
      }
    case "ComposerHeightChanged":
      return {
        ...model,
        composerHeight: Math.max(
          Math.min(5, model.height),
          Math.min(message.height, composerHeightLimit(model.height)),
        ),
      }
    case "SidebarWidthChanged":
      return { ...model, sidebarWidth: clampSidebarWidth(message.width, model.width) }
    case "ScrollMoved":
      return { ...model, scrollOffset: Math.max(0, message.offset), scrollFollow: false }
    case "ScrollFollowed":
      return { ...model, scrollOffset: 0, scrollFollow: true }
    case "Submitted": {
      if (model.input.length === 0) return model
      const submission = classifyPrompt(model.input)
      const submittedPrompt = expandPastedText(model.input, model.pastedText)
      if (submission._tag === "Shell" && submission.command.length === 0) return model
      const submittedHistory = {
        history: [...model.history.filter((prompt) => prompt !== submittedPrompt), submittedPrompt],
        historyComposers: [
          ...model.historyComposers.filter(
            (draft) => expandPastedText(draft.input, draft.attachments) !== submittedPrompt,
          ),
          { input: model.input, attachments: model.pastedText },
        ],
        historyDraft: undefined,
        historyIndex: undefined,
        historySearch: "",
      }
      const queuesBehindActiveTurn = model.busy && message.submissionId !== undefined
      return {
        ...model,
        input: "",
        cursor: 0,
        pastedText: [],
        ...submittedHistory,
        ...(queuesBehindActiveTurn
          ? {
              queue: [
                ...model.queue,
                { id: message.submissionId!, prompt: submittedPrompt, provisional: true as const },
              ],
            }
          : {}),
        submittedDrafts: [
          ...model.submittedDrafts,
          {
            input: model.input,
            attachments: model.pastedText,
            cursor: model.cursor,
            ...(message.submissionId === undefined ? {} : { submissionId: message.submissionId }),
          },
        ],
        busy: true,
        activity: model.busy ? model.activity : { _tag: "Sending" },
      }
    }
    case "SubmissionAdmitted": {
      const admitProvisional = (item: QueueItem): ReadonlyArray<QueueItem> => {
        if (item.id !== message.submissionId || item.provisional !== true) return [item]
        if (message.status === "queued") return [{ ...item, id: message.turnId }]
        return []
      }
      const queue = message.submissionId === undefined ? model.queue : model.queue.flatMap(admitProvisional)
      return {
        ...model,
        queue,
        queueSelection: validQueueSelection(model.queueSelection, queue),
        submittedDrafts: bindSubmittedDraft(model.submittedDrafts, message.turnId, message.submissionId),
      }
    }
    case "SteeringAccepted": {
      const index = model.pendingSteering.findIndex(
        (row) => row.turnId === message.turnId && row.sequence === undefined && row.text === message.text,
      )
      if (index < 0) return model
      if (model.activeTurnId !== message.turnId)
        return { ...model, pendingSteering: model.pendingSteering.filter((_, position) => position !== index) }
      const pendingSteering = model.pendingSteering.map((row, position) =>
        position === index ? { ...row, sequence: message.sequence } : row,
      )
      return { ...model, pendingSteering }
    }
    case "SteeringDelivered":
      return {
        ...model,
        pendingSteering: model.pendingSteering.filter(
          (row) =>
            row.turnId !== message.turnId || row.sequence === undefined || !message.sequences.includes(row.sequence),
        ),
      }
    case "SteeringFailed": {
      const index = model.pendingSteering.findIndex(
        (row) => row.turnId === message.turnId && row.sequence === undefined && row.text === message.text,
      )
      if (index < 0) return model
      const pendingSteering = model.pendingSteering.filter((_, position) => position !== index)
      if (model.activeTurnId !== message.turnId) return { ...model, pendingSteering }
      const restoreInput = model.input.length === 0
      return {
        ...model,
        pendingSteering,
        ...(restoreInput ? { input: message.text, cursor: message.text.length } : {}),
        blocks: [...model.blocks, { _tag: "Notification", title: "Steering not delivered", detail: message.message }],
        items: [...model.items, { _tag: "Block", index: model.blocks.length }],
      }
    }
    case "CancelFailed":
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId) return model
      return {
        ...model,
        cancelPending: false,
        blocks: [
          ...model.blocks,
          { _tag: "Notification", title: "Cancellation not completed", detail: message.message },
        ],
        items: [...model.items, { _tag: "Block", index: model.blocks.length }],
      }
    case "TurnStarted": {
      const boundDrafts = bindSubmittedDraft(model.submittedDrafts, message.turnId, message.submissionId)
      if (model.entries.some((entry) => entry.role === "user" && entry.turnId === message.turnId))
        return {
          ...model,
          submittedDrafts: boundDrafts,
          cancelPending: false,
          activeTurnId: message.turnId,
          busy: true,
          activity: { _tag: "Waiting" },
        }
      return {
        ...model,
        submittedDrafts: boundDrafts,
        cancelPending: false,
        entries: [...model.entries, { role: "user", text: message.prompt, turnId: message.turnId }],
        items: [
          ...model.items,
          { _tag: "Entry", index: model.entries.length, id: `turn:${message.turnId}:user`, turnId: message.turnId },
        ],
        activeTurnId: message.turnId,
        busy: true,
        activity: { _tag: "Waiting" },
      }
    }
    case "BlockAdded": {
      const blocks = [...model.blocks, message.block]
      const items = [...model.items, { _tag: "Block" as const, index: model.blocks.length }]
      const activityForAddedBlock = (): Activity => {
        if (message.block._tag === "ToolCall") return runningToolsActivity({ ...model, blocks, items })
        if (message.block._tag === "ToolResult") return { _tag: "Waiting" }
        if (message.block._tag === "Compaction") {
          return message.block.status === "running" ? { _tag: "Compacting" } : { _tag: "Waiting" }
        }
        return model.activity ?? { _tag: "Waiting" }
      }
      return {
        ...model,
        blocks,
        items,
        ...(model.busy ? { activity: activityForAddedBlock() } : {}),
      }
    }
  }
  return undefined
}
