import { Function } from "effect"
import type { Message } from "../model/terminal-message"
import type { Model } from "../model/terminal-state"
import type { QueueItem } from "../model/terminal-queue-item"
import { classifyPrompt } from "../model/terminal-composer-state"
import { expandPastedText } from "../model/terminal-composer-paste"
import { bindSubmittedDraft, validQueueSelection } from "../model/terminal-queue-state"
import { composerHeightLimit, clampSidebarWidth } from "../model/terminal-layout-state"
import { runningToolsActivity, type Activity } from "../model/terminal-activity-state"
import { appendProvisionalUserEntry, reconcileUserEntry } from "../model/terminal-submission-state"

const reduceExecutionImpl = (
  model: Model,
  message: Message,
  _reduce: (model: Model, message: Message) => Model,
): Model | undefined => {
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
      const submitted: Model = {
        ...model,
        input: "",
        cursor: 0,
        pastedText: [],
        ...submittedHistory,
        ...(queuesBehindActiveTurn
          ? {
              queue: [
                ...model.queue,
                {
                  id: message.submissionId!,
                  prompt: submittedPrompt,
                  provisional: true as const,
                  ...(model.currentThreadId === undefined ? {} : { threadId: model.currentThreadId }),
                },
              ],
            }
          : {}),
        submittedDrafts: [
          ...model.submittedDrafts,
          {
            input: model.input,
            attachments: model.pastedText,
            cursor: model.cursor,
            ...(model.currentThreadId === undefined ? {} : { threadId: model.currentThreadId }),
            ...(message.submissionId === undefined ? {} : { submissionId: message.submissionId }),
          },
        ],
        busy: true,
        activity: model.busy ? model.activity : { _tag: "Sending" },
      }
      return submission._tag === "Prompt" && !model.busy
        ? appendProvisionalUserEntry(submitted, submittedPrompt, message.submissionId)
        : submitted
    }
    case "SubmissionAdmitted": {
      const admitProvisional = (item: QueueItem): ReadonlyArray<QueueItem> => {
        if (item.id !== message.submissionId || item.provisional !== true) return [item]
        if (message.status === "queued") return [{ ...item, id: message.turnId }]
        return []
      }
      const queue = message.submissionId === undefined ? model.queue : model.queue.flatMap(admitProvisional)
      const admitted = reconcileUserEntry(
        {
          ...model,
          queue,
          queueSelection: validQueueSelection(model.queueSelection, queue),
          submittedDrafts: bindSubmittedDraft(
            model.submittedDrafts,
            message.turnId,
            message.submissionId,
            message.threadId,
          ),
        },
        {
          turnId: message.turnId,
          ...(message.submissionId === undefined ? {} : { submissionId: message.submissionId }),
          started: false,
        },
      )
      return admitted.model
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
    case "CompactionChanged": {
      const { compactionPending: _, ...contextAnimation } = model.contextAnimation
      const { compactionShimmer: _compactionShimmer, ...modelWithoutShimmer } = model
      const running = message.status === "running"
      const complete = message.status === "complete"
      let compactionShimmer = model.compactionShimmer
      if (running) compactionShimmer = undefined
      else if (complete) compactionShimmer = model.compactionShimmer ?? { tick: 0, remaining: 14 }
      return {
        ...modelWithoutShimmer,
        contextAnimation:
          running || complete ? { ...model.contextAnimation, compactionPending: true } : contextAnimation,
        ...(compactionShimmer === undefined ? {} : { compactionShimmer }),
        ...(model.busy
          ? { activity: running ? ({ _tag: "Compacting" } as const) : ({ _tag: "Waiting" } as const) }
          : {}),
      }
    }
    case "TurnStarted": {
      const boundDrafts = bindSubmittedDraft(model.submittedDrafts, message.turnId, message.submissionId)
      const boundModel = { ...model, submittedDrafts: boundDrafts }
      const reconciled = reconcileUserEntry(boundModel, {
        turnId: message.turnId,
        ...(message.submissionId === undefined ? {} : { submissionId: message.submissionId }),
        prompt: message.prompt,
        started: true,
      })
      const started =
        reconciled.found || model.entries.some((entry) => entry.role === "user" && entry.turnId === message.turnId)
          ? reconciled.model
          : {
              ...boundModel,
              entries: [...model.entries, { role: "user" as const, text: message.prompt, turnId: message.turnId }],
              items: [
                ...model.items,
                {
                  _tag: "Entry" as const,
                  index: model.entries.length,
                  id: `turn:${message.turnId}:user`,
                  turnId: message.turnId,
                },
              ],
            }
      return {
        ...started,
        cancelPending: false,
        activeTurnId: message.turnId,
        busy: true,
        activity: { _tag: "Waiting" },
        contextAnimation: { flashTicks: 0, flashed75: false, flashed90: false },
      }
    }
    case "BlockAdded": {
      const blocks = [...model.blocks, message.block]
      const items = [...model.items, { _tag: "Block" as const, index: model.blocks.length }]
      const activityForAddedBlock = (): Activity => {
        if (message.block._tag === "ToolCall" || message.block._tag === "Cell")
          return runningToolsActivity({ ...model, blocks, items })
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

export const reduceExecution: {
  (
    arg1: Parameters<typeof reduceExecutionImpl>[1],
    arg2: Parameters<typeof reduceExecutionImpl>[2],
  ): (arg0: Parameters<typeof reduceExecutionImpl>[0]) => ReturnType<typeof reduceExecutionImpl>
  (
    arg0: Parameters<typeof reduceExecutionImpl>[0],
    arg1: Parameters<typeof reduceExecutionImpl>[1],
    arg2: Parameters<typeof reduceExecutionImpl>[2],
  ): ReturnType<typeof reduceExecutionImpl>
} = Function.dual(3, reduceExecutionImpl)
