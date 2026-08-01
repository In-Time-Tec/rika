import type { Unit } from "@rika/transcript/transcript-unit"
import type { Key } from "../../presentation/terminal/terminal-keymap"
import type { ChangedFile } from "./terminal-changed-file"
import type { ThreadItem } from "./terminal-thread-state"
import type { TranscriptBlock } from "./terminal-transcript-state"

export interface PastedTextAttachment {
  readonly type: "text" | "image"
  readonly token: string
  readonly value?: string
  readonly path?: string
  readonly label: string
}

export type UiEvent = {
  readonly id: string
  readonly cursor: string
  readonly turnId?: string
  readonly block: TranscriptBlock
}

export type Message =
  | { readonly _tag: "KeyPressed"; readonly key: Key }
  | { readonly _tag: "Pasted"; readonly text: string }
  | { readonly _tag: "ImageInserted"; readonly path: string }
  | { readonly _tag: "ImageRemoved"; readonly path: string }
  | { readonly _tag: "PastedTextExpanded"; readonly token: string }
  | { readonly _tag: "Resized"; readonly width: number; readonly height: number }
  | { readonly _tag: "ComposerHeightChanged"; readonly height: number }
  | { readonly _tag: "Submitted"; readonly submissionId?: string }
  | {
      readonly _tag: "SubmissionAdmitted"
      readonly turnId: string
      readonly status?: "active" | "queued"
      readonly submissionId?: string
    }
  | { readonly _tag: "TurnStarted"; readonly turnId: string; readonly prompt: string; readonly submissionId?: string }
  | {
      readonly _tag: "SteeringAccepted"
      readonly turnId: string
      readonly sequence: number
      readonly text: string
    }
  | { readonly _tag: "SteeringDelivered"; readonly turnId: string; readonly sequences: ReadonlyArray<number> }
  | { readonly _tag: "SteeringFailed"; readonly turnId: string; readonly text: string; readonly message: string }
  | { readonly _tag: "CancelFailed"; readonly turnId?: string; readonly message: string }
  | { readonly _tag: "AssistantStreamed"; readonly id?: string; readonly turnId?: string; readonly text: string }
  | { readonly _tag: "AssistantCompleted"; readonly id?: string; readonly turnId?: string; readonly text: string }
  | { readonly _tag: "ExecutionCompleted"; readonly turnId?: string }
  | { readonly _tag: "ExecutionFailed"; readonly turnId?: string; readonly message: string }
  | { readonly _tag: "ExecutionCancelled"; readonly turnId?: string; readonly agentResponseArrived?: boolean }
  | { readonly _tag: "BlockAdded"; readonly block: TranscriptBlock }
  | { readonly _tag: "ReasoningStreamed"; readonly text: string }
  | { readonly _tag: "ReasoningToggled"; readonly index: number }
  | { readonly _tag: "ScrollMoved"; readonly offset: number }
  | { readonly _tag: "ScrollFollowed" }
  | { readonly _tag: "PaletteActionConsumed" }
  | { readonly _tag: "ThreadsReplaced"; readonly threads: ReadonlyArray<ThreadItem> }
  | { readonly _tag: "ThreadActivated"; readonly threadId: string; readonly title: string }
  | { readonly _tag: "ThreadTitleChanged"; readonly threadId: string; readonly title: string }
  | { readonly _tag: "FilesReplaced"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "BranchDetected"; readonly branch: string }
  | { readonly _tag: "UsageReported"; readonly costUsd?: number }
  | { readonly _tag: "WorkspaceFilesToggled" }
  | { readonly _tag: "ThreadSidebarSelectionMoved"; readonly offset: number }
  | { readonly _tag: "ThreadSidebarSelectionConfirmed"; readonly index?: number }
  | { readonly _tag: "ThreadPreviewScrolled"; readonly offset: number }
  | { readonly _tag: "EventReplayed"; readonly event: UiEvent }
  | { readonly _tag: "DetailMoved"; readonly offset: number }
  | { readonly _tag: "DetailToggled"; readonly id?: string }
  | { readonly _tag: "AllDetailsToggled" }
  | { readonly _tag: "FastModeToggled" }
  | { readonly _tag: "SidebarViewToggled" }
  | { readonly _tag: "SidebarWidthChanged"; readonly width: number }
  | { readonly _tag: "ComposerReplaced"; readonly text: string }
  | { readonly _tag: "ChangedFilesRequested" }
  | { readonly _tag: "ChangedFilesReplaced"; readonly files: ReadonlyArray<ChangedFile> }
  | { readonly _tag: "FilesRequested" }
  | { readonly _tag: "FilesFailed"; readonly message: string }
  | { readonly _tag: "ThreadPreviewRequested" }
  | { readonly _tag: "ThreadOpenRequested" }
  | { readonly _tag: "ThreadOpenCompleted" }
  | { readonly _tag: "ThreadRefolding"; readonly threadId: string; readonly refolding: boolean }
  | {
      readonly _tag: "ThreadPreviewLoaded"
      readonly threadId: string
      readonly turns: ReadonlyArray<{ readonly prompt: string; readonly units: ReadonlyArray<Unit> }>
    }
