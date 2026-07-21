import { Function } from "effect"

export interface ViewportAnchor {
  readonly unitId: string
  readonly offset: number
}

export type ViewportState =
  | { readonly _tag: "Following" }
  | { readonly _tag: "Anchored"; readonly anchor: ViewportAnchor | undefined }

export interface ViewportWindow {
  readonly end: number
}

export interface ViewportMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly viewportHeight: number
}

export const following: ViewportState = { _tag: "Following" }

export type WheelDirection = "up" | "down"

export type WheelPhase =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "AwaitingSettle"
      readonly token: number
      readonly direction: WheelDirection
      readonly scrollBy: number
    }

export const wheelIdle: WheelPhase = { _tag: "Idle" }

export interface TranscriptViewport {
  readonly mode: ViewportState
  readonly wheel: WheelPhase
  readonly nextToken: number
}

export const initialViewport: TranscriptViewport = { mode: following, wheel: wheelIdle, nextToken: 0 }

export type ViewportEvent =
  | {
      readonly _tag: "WheelObserved"
      readonly direction: WheelDirection
      readonly delta: number
      readonly atTrueBottom: boolean
      readonly atMountedBottom: boolean
      readonly anchorPending: boolean
    }
  | {
      readonly _tag: "WheelSettleFired"
      readonly token: number
      readonly atTrueBottom: boolean
      readonly atMountedBottom: boolean
    }
  | { readonly _tag: "WheelCancelled" }
  | { readonly _tag: "DetachCommanded" }
  | { readonly _tag: "FollowCommanded" }
  | { readonly _tag: "BottomSettled" }
  | { readonly _tag: "ModelSynced"; readonly scrollFollow: boolean; readonly followForced: boolean }

export type ViewportEffect =
  | { readonly _tag: "ProjectState" }
  | { readonly _tag: "NotifyDetached" }
  | { readonly _tag: "NotifyFollowed" }
  | { readonly _tag: "QueueAnchorScroll"; readonly scrollBy: number }
  | { readonly _tag: "ScheduleWheelSettle"; readonly token: number }
  | { readonly _tag: "PageForward"; readonly scrollBy: number }
  | { readonly _tag: "ReportSettled" }

export interface ViewportDecision {
  readonly viewport: TranscriptViewport
  readonly effects: ReadonlyArray<ViewportEffect>
}

export const anchored = (anchor?: ViewportAnchor): ViewportState => ({ _tag: "Anchored", anchor })

export const isFollowing = (state: ViewportState): boolean => state._tag === "Following"

export const isAnchored = (state: ViewportState): boolean => state._tag === "Anchored"

export const anchorOf = (state: ViewportState): ViewportAnchor | undefined =>
  state._tag === "Anchored" ? state.anchor : undefined

export const maxScrollTop = (metrics: ViewportMetrics): number =>
  Math.max(0, metrics.scrollHeight - metrics.viewportHeight)

export const atBottomWithin: {
  (tolerance: number): (metrics: ViewportMetrics) => boolean
  (metrics: ViewportMetrics, tolerance: number): boolean
} = Function.dual(
  2,
  (metrics: ViewportMetrics, tolerance: number): boolean => metrics.scrollTop >= maxScrollTop(metrics) - tolerance,
)

export const atBottom = (metrics: ViewportMetrics): boolean => atBottomWithin(metrics, 0)

export const clampScrollTop: {
  (metrics: ViewportMetrics): (scrollTop: number) => number
  (scrollTop: number, metrics: ViewportMetrics): number
} = Function.dual(2, (scrollTop: number, metrics: ViewportMetrics): number =>
  Math.max(0, Math.min(scrollTop, maxScrollTop(metrics))),
)

export const detach = (anchor?: ViewportAnchor): ViewportState => anchored(anchor)

export const follow = (): ViewportState => following

const detachedMode = (mode: ViewportState): ViewportState => (mode._tag === "Anchored" ? mode : anchored())

const reduceWheelObserved = (
  viewport: TranscriptViewport,
  event: Extract<ViewportEvent, { _tag: "WheelObserved" }>,
): ViewportDecision => {
  if (event.direction === "down" && isFollowing(viewport.mode) && event.atTrueBottom) return { viewport, effects: [] }
  const wasFollowing = event.direction === "up" && isFollowing(viewport.mode)
  const mode = event.direction === "up" ? detachedMode(viewport.mode) : viewport.mode
  const modeEffects: ReadonlyArray<ViewportEffect> =
    event.direction === "up"
      ? [{ _tag: "ProjectState" }, ...(wasFollowing ? ([{ _tag: "NotifyDetached" }] as const) : [])]
      : []
  if (event.anchorPending)
    return {
      viewport: mode === viewport.mode ? viewport : { ...viewport, mode },
      effects: [
        ...modeEffects,
        { _tag: "QueueAnchorScroll", scrollBy: (event.direction === "down" ? 1 : -1) * Math.max(1, event.delta) },
      ],
    }
  const accumulated = event.direction === "down" && event.atMountedBottom ? event.delta : 0
  if (viewport.wheel._tag === "AwaitingSettle")
    return {
      viewport: {
        ...viewport,
        mode,
        wheel: { ...viewport.wheel, direction: event.direction, scrollBy: viewport.wheel.scrollBy + accumulated },
      },
      effects: modeEffects,
    }
  const token = viewport.nextToken
  return {
    viewport: {
      ...viewport,
      mode,
      wheel: { _tag: "AwaitingSettle", token, direction: event.direction, scrollBy: accumulated },
      nextToken: token + 1,
    },
    effects: [...modeEffects, { _tag: "ScheduleWheelSettle", token }],
  }
}

const reduceWheelSettleFired = (
  viewport: TranscriptViewport,
  event: Extract<ViewportEvent, { _tag: "WheelSettleFired" }>,
): ViewportDecision => {
  if (viewport.wheel._tag !== "AwaitingSettle" || viewport.wheel.token !== event.token) return { viewport, effects: [] }
  const { direction, scrollBy } = viewport.wheel
  const settled: TranscriptViewport = { ...viewport, wheel: wheelIdle }
  if (direction === "down" && isFollowing(viewport.mode) && event.atTrueBottom)
    return { viewport: settled, effects: [] }
  if (direction === "down" && event.atMountedBottom)
    return { viewport: settled, effects: [{ _tag: "PageForward", scrollBy }] }
  return { viewport: settled, effects: [{ _tag: "ReportSettled" }] }
}

export const reduceViewport: {
  (event: ViewportEvent): (viewport: TranscriptViewport) => ViewportDecision
  (viewport: TranscriptViewport, event: ViewportEvent): ViewportDecision
} = Function.dual(2, (viewport: TranscriptViewport, event: ViewportEvent): ViewportDecision => {
  switch (event._tag) {
    case "WheelObserved":
      return reduceWheelObserved(viewport, event)
    case "WheelSettleFired":
      return reduceWheelSettleFired(viewport, event)
    case "WheelCancelled":
      return viewport.wheel._tag === "Idle"
        ? { viewport, effects: [] }
        : { viewport: { ...viewport, wheel: wheelIdle }, effects: [] }
    case "DetachCommanded":
      return {
        viewport: isAnchored(viewport.mode) ? viewport : { ...viewport, mode: anchored() },
        effects: [{ _tag: "ProjectState" }],
      }
    case "FollowCommanded":
      return {
        viewport: isFollowing(viewport.mode) ? viewport : { ...viewport, mode: following },
        effects: [{ _tag: "NotifyFollowed" }],
      }
    case "BottomSettled":
      return isFollowing(viewport.mode)
        ? { viewport, effects: [] }
        : { viewport: { ...viewport, mode: following }, effects: [{ _tag: "NotifyFollowed" }] }
    case "ModelSynced": {
      let mode = viewport.mode
      if (!event.scrollFollow) mode = detachedMode(viewport.mode)
      else if (event.followForced) mode = following
      return mode === viewport.mode ? { viewport, effects: [] } : { viewport: { ...viewport, mode }, effects: [] }
    }
  }
})

export const reanchor: {
  (anchor: ViewportAnchor | undefined): (state: ViewportState) => ViewportState
  (state: ViewportState, anchor: ViewportAnchor | undefined): ViewportState
} = Function.dual(
  2,
  (state: ViewportState, anchor: ViewportAnchor | undefined): ViewportState =>
    state._tag === "Anchored" ? anchored(anchor) : state,
)

export const contentChanged = (state: ViewportState): ViewportState => state

export const resized = (state: ViewportState): ViewportState => state

export const toggled = (anchor: ViewportAnchor | undefined): ViewportState => anchored(anchor)

export const settle: {
  (anchor: ViewportAnchor | undefined): (metrics: ViewportMetrics) => ViewportState
  (metrics: ViewportMetrics, anchor: ViewportAnchor | undefined): ViewportState
} = Function.dual(
  2,
  (metrics: ViewportMetrics, anchor: ViewportAnchor | undefined): ViewportState =>
    atBottom(metrics) ? following : anchored(anchor),
)

export const initialWindow = (total: number): ViewportWindow => ({ end: Math.max(0, total) })

export const windowStart: {
  (limit: number): (window: ViewportWindow) => number
  (window: ViewportWindow, limit: number): number
} = Function.dual(2, (window: ViewportWindow, limit: number): number => Math.max(0, window.end - limit))

export const atWindowTop: {
  (limit: number): (window: ViewportWindow) => boolean
  (window: ViewportWindow, limit: number): boolean
} = Function.dual(2, (window: ViewportWindow, limit: number): boolean => windowStart(window, limit) <= 0)

export const atWindowBottom: {
  (total: number): (window: ViewportWindow) => boolean
  (window: ViewportWindow, total: number): boolean
} = Function.dual(2, (window: ViewportWindow, total: number): boolean => window.end >= total)

export const advanceWindow: {
  (delta: number, total: number, limit: number): (window: ViewportWindow) => ViewportWindow
  (window: ViewportWindow, delta: number, total: number, limit: number): ViewportWindow
} = Function.dual(4, (window: ViewportWindow, delta: number, total: number, limit: number): ViewportWindow => {
  const minimumEnd = Math.min(limit, total)
  const end = Math.min(total, Math.max(minimumEnd, window.end + delta))
  return { end }
})

export const clampWindow: {
  (total: number, limit: number, pinned: boolean): (window: ViewportWindow) => ViewportWindow
  (window: ViewportWindow, total: number, limit: number, pinned: boolean): ViewportWindow
} = Function.dual(4, (window: ViewportWindow, total: number, limit: number, pinned: boolean): ViewportWindow => {
  if (pinned || window.end === 0) return { end: total }
  const minimumEnd = Math.min(limit, total)
  return { end: Math.min(total, Math.max(minimumEnd, window.end)) }
})
