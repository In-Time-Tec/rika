import * as InteractiveEvent from "@rika/product/interactive-event"
import * as ThreadView from "@rika/product/thread-view"
import { Effect } from "effect"
import type { Model } from "@rika/terminal/terminal-state"
import { updateState } from "./terminal-interactive-feed"

export type TranscriptEvent = Extract<
  InteractiveEvent.InteractiveEvent,
  | { readonly _tag: "ThreadViewSnapshot" }
  | { readonly _tag: "ThreadViewPatch" }
  | { readonly _tag: "ResyncRequired" }
  | { readonly _tag: "ThreadRefolding" }
>

export interface State {
  readonly model: Model
  readonly view?: ThreadView.ThreadViewSnapshot
}

export interface Update {
  readonly state: State
  readonly preserveAnchor: boolean
  readonly discarded?: boolean
  readonly resync?: boolean
  readonly rejection?: "gap" | "thread" | "revision"
}

export const warnUnattached = (_unattached: ReadonlyArray<string>) => Effect.void

export const update: {
  (event: TranscriptEvent): (state: State) => Update
  (state: State, event: TranscriptEvent): Update
} = updateState
