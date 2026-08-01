import type { TranscriptViewport } from "./transcript-viewport-state"
import type { ViewportEffect } from "./transcript-viewport-effects"

export interface ViewportDecision {
  readonly viewport: TranscriptViewport
  readonly effects: ReadonlyArray<ViewportEffect>
}
