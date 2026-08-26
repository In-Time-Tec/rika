export interface ViewportAnchor {
  readonly unitId: string
  readonly offset: number
}
export type ViewportState =
  | { readonly _tag: "Following" }
  | { readonly _tag: "Anchored"; readonly anchor: ViewportAnchor }
export type WheelDirection = "up" | "down"
export type WheelPhase =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "AwaitingSettle"; readonly token: number; readonly displacement: number }
export interface TranscriptViewport {
  readonly mode: ViewportState
  readonly wheel: WheelPhase
  readonly nextToken: number
}
export const following: ViewportState = { _tag: "Following" }
export const wheelIdle: WheelPhase = { _tag: "Idle" }
export const initialViewport: TranscriptViewport = { mode: following, wheel: wheelIdle, nextToken: 0 }
