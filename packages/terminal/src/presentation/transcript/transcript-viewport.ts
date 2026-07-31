import { Function } from "effect"

export interface ViewportAnchor {
  readonly unitId: string
  readonly offset: number
}

export type ViewportState =
  | { readonly _tag: "Following" }
  | { readonly _tag: "Anchored"; readonly anchor: ViewportAnchor }

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
      readonly displacement: number
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

export type ViewportEffect =
  | { readonly _tag: "ProjectState" }
  | { readonly _tag: "RequestFollowPosition" }
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

export const anchored = (anchor: ViewportAnchor): ViewportState => ({ _tag: "Anchored", anchor })

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

export const detach = (anchor: ViewportAnchor): ViewportState => anchored(anchor)

export const follow = (): ViewportState => following

const reduceWheelObserved = (
  viewport: TranscriptViewport,
  event: Extract<ViewportEvent, { _tag: "WheelObserved" }>,
): ViewportDecision => {
  if (event.direction === "down" && isFollowing(viewport.mode) && event.atTrueBottom) return { viewport, effects: [] }
  const detachRequested = event.direction === "up" && isFollowing(viewport.mode)
  if (detachRequested && event.anchor === undefined) return { viewport, effects: [] }
  const wasFollowing = detachRequested
  const mode = detachRequested ? anchored(event.anchor!) : viewport.mode
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
  const displacement = (event.direction === "down" ? 1 : -1) * Math.max(1, event.delta)
  if (viewport.wheel._tag === "AwaitingSettle")
    return {
      viewport: {
        ...viewport,
        mode,
        wheel: { ...viewport.wheel, displacement: viewport.wheel.displacement + displacement },
      },
      effects: modeEffects,
    }
  const token = viewport.nextToken
  return {
    viewport: {
      ...viewport,
      mode,
      wheel: { _tag: "AwaitingSettle", token, displacement },
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
  const { displacement } = viewport.wheel
  const settled: TranscriptViewport = { ...viewport, wheel: wheelIdle }
  if (displacement > 0 && isFollowing(viewport.mode) && event.atTrueBottom) return { viewport: settled, effects: [] }
  if (displacement > 0 && event.atMountedBottom)
    return { viewport: settled, effects: [{ _tag: "PageForward", scrollBy: displacement }] }
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
      if (isAnchored(viewport.mode) || event.anchor === undefined) return { viewport, effects: [] }
      return {
        viewport: { ...viewport, mode: anchored(event.anchor) },
        effects: [{ _tag: "ProjectState" }],
      }
    case "FollowCommanded":
      return {
        viewport: isFollowing(viewport.mode) ? viewport : { ...viewport, mode: following },
        effects: isFollowing(viewport.mode)
          ? []
          : [{ _tag: "ProjectState" }, { _tag: "RequestFollowPosition" }, { _tag: "NotifyFollowed" }],
      }
    case "ResetCommanded":
      return {
        viewport: { mode: following, wheel: wheelIdle, nextToken: viewport.nextToken },
        effects: [{ _tag: "ProjectState" }, { _tag: "RequestFollowPosition" }],
      }
    case "BottomSettled":
      return isFollowing(viewport.mode)
        ? { viewport, effects: [] }
        : {
            viewport: { ...viewport, mode: following },
            effects: [{ _tag: "ProjectState" }, { _tag: "NotifyFollowed" }],
          }
  }
})

export const reanchor: {
  (anchor: ViewportAnchor | undefined): (state: ViewportState) => ViewportState
  (state: ViewportState, anchor: ViewportAnchor | undefined): ViewportState
} = Function.dual(
  2,
  (state: ViewportState, anchor: ViewportAnchor | undefined): ViewportState =>
    state._tag === "Anchored" && anchor !== undefined ? anchored(anchor) : state,
)

export const contentChanged = (state: ViewportState): ViewportState => state

export const resized = (state: ViewportState): ViewportState => state

export const toggled = (anchor: ViewportAnchor | undefined): ViewportState =>
  anchor === undefined ? following : anchored(anchor)

export const settle: {
  (anchor: ViewportAnchor | undefined): (metrics: ViewportMetrics) => ViewportState
  (metrics: ViewportMetrics, anchor: ViewportAnchor | undefined): ViewportState
} = Function.dual(2, (metrics: ViewportMetrics, anchor: ViewportAnchor | undefined): ViewportState => {
  if (atBottom(metrics) || anchor === undefined) return following
  return anchored(anchor)
})

export interface TranscriptContentChange {
  readonly prepended: ReadonlyArray<string>
  readonly appended: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
}

export const classifyTranscriptContent: {
  (
    current: ReadonlyArray<{ readonly id: string }>,
  ): (previous: ReadonlyArray<{ readonly id: string }>) => TranscriptContentChange
  (
    previous: ReadonlyArray<{ readonly id: string }>,
    current: ReadonlyArray<{ readonly id: string }>,
  ): TranscriptContentChange
} = Function.dual(
  2,
  (
    previous: ReadonlyArray<{ readonly id: string }>,
    current: ReadonlyArray<{ readonly id: string }>,
  ): TranscriptContentChange => {
    const previousIds = new Set(previous.map(({ id }) => id))
    const currentIds = new Set(current.map(({ id }) => id))
    const retained = current.findIndex(({ id }) => previousIds.has(id))
    const lastRetained = current.findLastIndex(({ id }) => previousIds.has(id))
    return {
      prepended: (retained < 0 ? [] : current.slice(0, retained)).map(({ id }) => id),
      appended: (lastRetained < 0 ? current : current.slice(lastRetained + 1)).map(({ id }) => id),
      removed: previous.filter(({ id }) => !currentIds.has(id)).map(({ id }) => id),
    }
  },
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
