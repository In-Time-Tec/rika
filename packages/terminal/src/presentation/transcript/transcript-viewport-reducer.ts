import { Function } from "effect"
import type { TranscriptViewport } from "./transcript-viewport-state"
import type { ViewportEvent, ViewportEffect, ViewportDecision } from "./transcript-viewport-protocol"
import { following, wheelIdle } from "./transcript-viewport-state"
import { anchored, isAnchored, isFollowing } from "./transcript-viewport"

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
