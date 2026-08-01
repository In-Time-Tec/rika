import type { ViewportAnchor, WheelDirection } from "./transcript-viewport-state"

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
