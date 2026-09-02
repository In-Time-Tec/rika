import * as InteractiveEvent from "@rika/product/interactive-event"
import * as ThreadView from "@rika/product/thread-view"
import type { Model } from "@rika/terminal/terminal-state"
import { clearPreviewState, updateState } from "./feed"
import type { Overlay as ModelPreviewOverlay } from "./model-preview"

export type TranscriptEvent = Extract<
  InteractiveEvent.InteractiveEvent,
  | { readonly _tag: "ThreadViewSnapshot" }
  | { readonly _tag: "ThreadViewPatch" }
  | { readonly _tag: "ResyncRequired" }
  | { readonly _tag: "ThreadRefolding" }
  | { readonly _tag: "ExecutionModelPreviewChanged" }
>

export interface State {
  readonly model: Model
  readonly view?: ThreadView.ThreadViewAccumulator
  readonly modelPreview?: ModelPreviewOverlay | undefined
}

export interface Update {
  readonly state: State
  readonly preserveAnchor: boolean
  readonly discarded?: boolean
  readonly resync?: boolean
  readonly rejection?: "gap" | "thread" | "revision"
}

export const update: {
  (event: TranscriptEvent): (state: State) => Update
  (state: State, event: TranscriptEvent): Update
} = updateState

export const clearPreview = clearPreviewState
