import type { TranscriptViewport, ViewportAnchor, WheelDirection } from "./transcript-viewport-state"

export type ViewportEffect =
  | { readonly _tag: "ProjectState" }
  | { readonly _tag: "RequestFollowPosition" }
  | { readonly _tag: "NotifyDetached" }
  | { readonly _tag: "NotifyFollowed" }
  | { readonly _tag: "QueueAnchorScroll"; readonly scrollBy: number }
  | { readonly _tag: "ScheduleWheelSettle"; readonly token: number }
  | { readonly _tag: "PageForward"; readonly scrollBy: number }
  | { readonly _tag: "ReportSettled" }

export type ViewportEvent =
  | {
      readonly _tag: "WheelObserved"
      readonly direction: WheelDirection
      readonly delta: number
      readonly atTrueBottom: boolean
      readonly atMountedBottom: boolean
      readonly anchorPending: boolean
      readonly anchor: ViewportAnchor | undefined
    }
  | {
      readonly _tag: "WheelSettleFired"
      readonly token: number
      readonly atTrueBottom: boolean
      readonly atMountedBottom: boolean
    }
  | { readonly _tag: "WheelCancelled" }
  | { readonly _tag: "DetachCommanded"; readonly anchor: ViewportAnchor | undefined }
  | { readonly _tag: "FollowCommanded" }
  | { readonly _tag: "ResetCommanded" }
  | { readonly _tag: "BottomSettled" }

export interface ViewportDecision {
  readonly viewport: TranscriptViewport
  readonly effects: ReadonlyArray<ViewportEffect>
}
