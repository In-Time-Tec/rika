import { Function } from "effect"
import type { Message } from "../model/terminal-message"
import type { Model } from "../model/terminal-state"
import type { QueueItem } from "../model/terminal-queue-item"
import { classifyPrompt } from "../model/terminal-composer-state"
import { expandPastedText } from "../model/terminal-composer-paste"
import { bindSubmittedDraft, validQueueSelection } from "../model/terminal-queue-state"
import { composerHeightLimit, clampSidebarWidth } from "../model/terminal-layout-state"
import { runningToolsActivity, type Activity } from "../model/terminal-activity-state"
import {
  appendProvisionalUserEntry,
  reconcileUserEntry,
  settleProvisionalUserEntry,
} from "../model/terminal-submission-state"

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
      if (model.submittedDrafts.some((draft) => draft.turnId === undefined)) return model
      const submission = classifyPrompt(model.input)
      if (submission._tag === "Shell" && submission.command.length === 0) return model
      return {
        ...model,
        submittedDrafts: [
          ...model.submittedDrafts,
          {
            input: model.input,
            attachments: model.pastedText,
            cursor: model.cursor,
            ...(message.submissionId === undefined ? {} : { submissionId: message.submissionId }),
          },
        ],
      }
    }
    case "SubmissionAdmitted": {
      const draft = model.submittedDrafts.find(
        (candidate) =>
          (message.submissionId !== undefined && candidate.submissionId === message.submissionId) ||
          candidate.turnId === message.turnId,
      )
      const prompt = draft === undefined ? undefined : expandPastedText(draft.input, draft.attachments)
      const composerUnchanged =
        draft !== undefined && model.input === draft.input && model.pastedText === draft.attachments
      const submittedHistory =
        draft === undefined
          ? {}
          : {
              history: [...model.history.filter((candidate) => candidate !== prompt), prompt!],
              historyComposers: [
                ...model.historyComposers.filter(
                  (candidate) => expandPastedText(candidate.input, candidate.attachments) !== prompt,
                ),
                { input: draft.input, attachments: draft.attachments },
              ],
              historyDraft: undefined,
              historyIndex: undefined,
              historySearch: "",
            }
      const admitProvisional = (item: QueueItem): ReadonlyArray<QueueItem> => {
        if ((item.id !== message.submissionId && item.id !== message.turnId) || item.provisional !== true) return [item]
        if (message.status === "queued") return [{ ...item, id: message.turnId }]
        return []
      }
      let queue = model.queue.flatMap(admitProvisional)
      if (message.status === "queued" && !queue.some((item) => item.id === message.turnId) && prompt !== undefined)
        queue = [...queue, { id: message.turnId, prompt, provisional: true }]
      const laneModel =
        message.status === "queued"
          ? settleProvisionalUserEntry(
              { ...model, queue },
              {
                turnId: message.turnId,
                ...(message.submissionId === undefined ? {} : { submissionId: message.submissionId }),
              },
              true,
            )
          : { ...model, queue, busy: true, activity: model.busy ? model.activity : { _tag: "Sending" as const } }
      const admitted = reconcileUserEntry(
        {
          ...laneModel,
          ...submittedHistory,
          ...(composerUnchanged ? { input: "", cursor: 0, pastedText: [] } : {}),
          queueSelection: validQueueSelection(laneModel.queueSelection, queue),
          submittedDrafts: bindSubmittedDraft(model.submittedDrafts, message.turnId, message.submissionId),
        },
        {
          turnId: message.turnId,
          ...(message.submissionId === undefined ? {} : { submissionId: message.submissionId }),
          started: false,
        },
      )
      if (message.status !== "active" || admitted.found || prompt === undefined) return admitted.model
      return reconcileUserEntry(appendProvisionalUserEntry(admitted.model, prompt, message.submissionId), {
        turnId: message.turnId,
        ...(message.submissionId === undefined ? {} : { submissionId: message.submissionId }),
        started: false,
      }).model
    }
    case "SteeringFailed": {
      const index = model.steeringRequests.findIndex((row) => row.requestId === message.requestId)
      if (index < 0) return model
      const rejected = model.steeringRequests[index]!
      const steeringRequests = model.steeringRequests.filter((_, position) => position !== index)
      if (model.activeTurnId !== rejected.turnId) return { ...model, steeringRequests }
      const restoreInput = rejected.origin === "composer" && model.input.length === 0
      return {
        ...model,
        steeringRequests,
        ...(restoreInput ? { input: rejected.text, cursor: rejected.text.length } : {}),
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
