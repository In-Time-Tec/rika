import { Function } from "effect"
import type { ViewportAnchor, ViewportState } from "./state"
import { following } from "./state"
import type { ViewportMetrics } from "./metrics"

export const anchored = (anchor: ViewportAnchor): ViewportState => ({ _tag: "Anchored", anchor })
export const isFollowing = (state: ViewportState): boolean => state._tag === "Following"
export const isAnchored = (state: ViewportState): boolean => state._tag === "Anchored"
export const anchorOf = (state: ViewportState): ViewportAnchor | undefined =>
  state._tag === "Anchored" ? state.anchor : undefined

import { maxScrollTop } from "./metrics"

export const clampScrollTop: {
  (metrics: ViewportMetrics): (scrollTop: number) => number
  (scrollTop: number, metrics: ViewportMetrics): number
} = Function.dual(2, (scrollTop: number, metrics: ViewportMetrics): number =>
  Math.max(0, Math.min(scrollTop, maxScrollTop(metrics))),
)

export const detach = (anchor: ViewportAnchor): ViewportState => anchored(anchor)

export const follow = (): ViewportState => following
