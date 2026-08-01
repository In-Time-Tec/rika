export type ViewportEffect =
  | { readonly _tag: "ProjectState" }
  | { readonly _tag: "RequestFollowPosition" }
  | { readonly _tag: "NotifyDetached" }
  | { readonly _tag: "NotifyFollowed" }
  | { readonly _tag: "QueueAnchorScroll"; readonly scrollBy: number }
  | { readonly _tag: "ScheduleWheelSettle"; readonly token: number }
  | { readonly _tag: "PageForward"; readonly scrollBy: number }
  | { readonly _tag: "ReportSettled" }
