import { Function } from "effect"
import type { Message } from "../message"
import type { Model } from "../model"
import type { QueueItem } from "../queue/item"
import type { TranscriptItem } from "../transcript/model"
import { classifyPrompt } from "../composer/model"
import { expandPastedText } from "../composer/paste"
import { bindSubmittedDraft, validQueueSelection } from "../queue/model"
import { composerHeightLimit, clampSidebarWidth } from "../layout/model"
import { runningToolsActivity, type Activity } from "../activity/model"
import { appendProvisionalUserEntry, reconcileUserEntry, settleProvisionalUserEntry } from "../submission"

const reduceLayoutExecution = (model: Model, message: Message): Model | undefined => {
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
  }
  return undefined
}

const reduceSubmitted = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "Submitted": {
      if (model.input.length === 0) return model
      if (model.submittedDrafts.some((draft) => draft.turnId === undefined)) return model
      const submission = classifyPrompt(model.input)
      if (submission._tag === "Shell" && submission.command.length === 0) return model
      const prompt = expandPastedText(model.input, model.pastedText)
      const submittedDraft = {
        input: model.input,
        attachments: model.pastedText,
        cursor: model.cursor,
      }
      const submitted = {
        ...model,
        input: "",
        cursor: 0,
        pastedText: [],
        submittedDrafts: [
          ...model.submittedDrafts,
          message.submissionId === undefined
            ? submittedDraft
            : { ...submittedDraft, submissionId: message.submissionId },
        ],
      }
      if (submission._tag !== "Prompt") return submitted
      if (model.busy)
        return message.submissionId === undefined
          ? submitted
          : {
              ...submitted,
              queue: [...model.queue, { id: message.submissionId, prompt, provisional: true }],
            }
      return {
        ...appendProvisionalUserEntry(submitted, prompt, message.submissionId),
        busy: true,
        activity: { _tag: "Sending" as const },
      }
    }
  }
  return undefined
}

const admittedHistory = (
  model: Model,
  draft: Model["submittedDrafts"][number] | undefined,
  prompt: string | undefined,
) => {
  if (draft === undefined || prompt === undefined) {
    return {
      history: model.history,
      historyComposers: model.historyComposers,
      historyDraft: model.historyDraft,
      historyIndex: model.historyIndex,
      historySearch: model.historySearch,
    }
  }
  return {
    history: [...model.history.filter((candidate) => candidate !== prompt), prompt],
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
}

const admittedQueueItem = (
  item: QueueItem,
  submissionId: string | undefined,
  turnId: string,
  status: "active" | "queued" | undefined,
): ReadonlyArray<QueueItem> => {
  if ((item.id !== submissionId && item.id !== turnId) || item.provisional !== true) return [item]
  if (status === "queued") return [{ ...item, id: turnId }]
  return []
}

const admittedQueue = (
  model: Model,
  submissionId: string | undefined,
  turnId: string,
  status: "active" | "queued" | undefined,
  prompt: string | undefined,
): ReadonlyArray<QueueItem> => {
  const queue = model.queue.flatMap((item) => admittedQueueItem(item, submissionId, turnId, status))
  if (status !== "queued" || queue.some((item) => item.id === turnId) || prompt === undefined) return queue
  return [...queue, { id: turnId, prompt, provisional: true }]
}

const reduceSubmissionAdmitted = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "SubmissionAdmitted": {
      const draft = model.submittedDrafts.find(
        (candidate) =>
          (message.submissionId !== undefined && candidate.submissionId === message.submissionId) ||
          candidate.turnId === message.turnId,
      )
      const prompt = draft === undefined ? undefined : expandPastedText(draft.input, draft.attachments)
      const composerUnchanged =
        draft !== undefined && model.input === draft.input && model.pastedText === draft.attachments
      const submissionReference =
        message.submissionId === undefined
          ? { turnId: message.turnId }
          : { turnId: message.turnId, submissionId: message.submissionId }
      const submittedHistory = admittedHistory(model, draft, prompt)
      const queue = admittedQueue(model, message.submissionId, message.turnId, message.status, prompt)
      const sendingActivity: Activity = { _tag: "Sending" }
      const laneModel =
        message.status === "queued"
          ? settleProvisionalUserEntry({ ...model, queue }, submissionReference, true)
          : { ...model, queue, busy: true, activity: model.busy ? model.activity : sendingActivity }
      const admitted = reconcileUserEntry(
        {
          ...laneModel,
          ...submittedHistory,
          input: composerUnchanged ? "" : laneModel.input,
          cursor: composerUnchanged ? 0 : laneModel.cursor,
          pastedText: composerUnchanged ? [] : laneModel.pastedText,
          queueSelection: validQueueSelection(laneModel.queueSelection, queue),
          submittedDrafts: bindSubmittedDraft(model.submittedDrafts, message.turnId, message.submissionId),
        },
        { ...submissionReference, started: false },
      )
      if (message.status !== "active" || admitted.found || prompt === undefined) return admitted.model
      return reconcileUserEntry(appendProvisionalUserEntry(admitted.model, prompt, message.submissionId), {
        ...submissionReference,
        started: false,
      }).model
    }
  }
  return undefined
}

const reduceSubmissionExecution = (model: Model, message: Message): Model | undefined =>
  reduceSubmitted(model, message) ?? reduceSubmissionAdmitted(model, message)

const reduceSteeringFailure = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "SteeringFailed": {
      const index = model.steeringRequests.findIndex((row) => row.requestId === message.requestId)
      if (index < 0) return model
      const rejected = model.steeringRequests[index]
      if (rejected === undefined) return model
      const steeringRequests = model.steeringRequests.filter((_, position) => position !== index)
      if (model.activeTurnId !== rejected.turnId) return { ...model, steeringRequests }
      const restoreInput = rejected.origin === "composer" && model.input.length === 0
      return {
        ...model,
        steeringRequests,
        input: restoreInput ? rejected.text : model.input,
        cursor: restoreInput ? rejected.text.length : model.cursor,
        blocks: [...model.blocks, { _tag: "Error", title: "Steering not delivered", detail: message.message }],
        items: [...model.items, { _tag: "Block", index: model.blocks.length }],
      }
    }
    case "CancelFailed":
      return {
        ...model,
        cancelPending: false,
        blocks: [...model.blocks, { _tag: "Error", title: "Cancellation not completed", detail: message.message }],
        items: [...model.items, { _tag: "Block", index: model.blocks.length }],
      }
  }
  return undefined
}

const reduceCompaction = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "CompactionChanged": {
      const { compactionPending: _, ...contextAnimation } = model.contextAnimation
      const { compactionShimmer: _compactionShimmer, ...modelWithoutShimmer } = model
      const running = message.status === "running"
      const complete = message.status === "complete"
      let compactionShimmer = model.compactionShimmer
      if (running) compactionShimmer = undefined
      else if (complete) compactionShimmer = model.compactionShimmer ?? { tick: 0, remaining: 14 }
      const compacted = {
        ...modelWithoutShimmer,
        contextAnimation:
          running || complete ? { ...model.contextAnimation, compactionPending: true } : contextAnimation,
      }
      const activity: Activity = running ? { _tag: "Compacting" } : { _tag: "Waiting" }
      if (compactionShimmer !== undefined) {
        return model.busy ? { ...compacted, compactionShimmer, activity } : { ...compacted, compactionShimmer }
      }
      return model.busy ? { ...compacted, activity } : compacted
    }
  }
  return undefined
}

const reduceControlExecution = (model: Model, message: Message): Model | undefined =>
  reduceSteeringFailure(model, message) ?? reduceCompaction(model, message)

const reduceTurnExecution = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "TurnStarted": {
      const boundDrafts = bindSubmittedDraft(model.submittedDrafts, message.turnId, message.submissionId)
      const boundModel = { ...model, submittedDrafts: boundDrafts }
      const submissionReference =
        message.submissionId === undefined
          ? { turnId: message.turnId }
          : { turnId: message.turnId, submissionId: message.submissionId }
      const reconciled = reconcileUserEntry(boundModel, {
        ...submissionReference,
        prompt: message.prompt,
        started: true,
      })
      const userEntry: Model["entries"][number] = { role: "user", text: message.prompt, turnId: message.turnId }
      const userItem: TranscriptItem = {
        _tag: "Entry",
        index: model.entries.length,
        id: `turn:${message.turnId}:user`,
        turnId: message.turnId,
      }
      const started =
        reconciled.found || model.entries.some((entry) => entry.role === "user" && entry.turnId === message.turnId)
          ? reconciled.model
          : {
              ...boundModel,
              entries: [...model.entries, userEntry],
              items: [...model.items, userItem],
            }
      return {
        ...started,
        activeTurnId: message.turnId,
        busy: true,
        activity: { _tag: "Waiting" },
        contextAnimation: {
          munchTick: model.contextAnimation.munchTick,
          flashTicks: 0,
          flashed75: false,
          flashed90: false,
        },
      }
    }
    case "BlockAdded": {
      const blocks = [...model.blocks, message.block]
      const item: TranscriptItem = { _tag: "Block", index: model.blocks.length }
      const items = [...model.items, item]
      const activityForAddedBlock = (): Activity => {
        if (message.block._tag === "ToolCall" || message.block._tag === "Cell")
          return runningToolsActivity({ ...model, blocks, items })
        if (message.block._tag === "ToolResult") return { _tag: "Waiting" }
        if (message.block._tag === "Compaction") {
          return message.block.status === "running" ? { _tag: "Compacting" } : { _tag: "Waiting" }
        }
        return model.activity ?? { _tag: "Waiting" }
      }
      const added = {
        ...model,
        blocks,
        items,
      }
      return model.busy ? { ...added, activity: activityForAddedBlock() } : added
    }
  }
  return undefined
}

const reduceExecutionImpl = (
  model: Model,
  message: Message,
  _reduce: (model: Model, message: Message) => Model,
): Model | undefined =>
  reduceLayoutExecution(model, message) ??
  reduceSubmissionExecution(model, message) ??
  reduceControlExecution(model, message) ??
  reduceTurnExecution(model, message)

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
