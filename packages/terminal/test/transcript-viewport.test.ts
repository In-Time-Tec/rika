import { describe, expect, test } from "vitest"
import {
  advanceWindow,
  anchorOf,
  atBottom,
  atBottomWithin,
  atWindowBottom,
  atWindowTop,
  clampScrollTop,
  clampWindow,
  classifyTranscriptContent,
  contentChanged,
  detach,
  follow,
  following,
  initialWindow,
  isAnchored,
  isFollowing,
  maxScrollTop,
  reanchor,
  reduceViewport,
  resized,
  settle,
  toggled,
  wheelIdle,
  windowStart,
  type TranscriptViewport,
  type ViewportAnchor,
  type ViewportEvent,
  type ViewportState,
  type WheelPhase,
} from "../src/transcript-viewport"

const anchor = (unitId: string, offset: number): ViewportAnchor => ({ unitId, offset })
const metrics = (scrollTop: number, scrollHeight: number, viewportHeight: number) => ({
  scrollTop,
  scrollHeight,
  viewportHeight,
})

describe("transcript viewport follow/anchor state", () => {
  test("starts following", () => {
    expect(isFollowing(following)).toBe(true)
    expect(isAnchored(following)).toBe(false)
    expect(anchorOf(following)).toBeUndefined()
  })

  test("wheel up detaches and holds the captured anchor", () => {
    const state = detach(anchor("unit-a", 4))
    expect(isAnchored(state)).toBe(true)
    expect(anchorOf(state)).toEqual({ unitId: "unit-a", offset: 4 })
  })

  test("follow re-pins", () => {
    const state = follow()
    expect(isFollowing(state)).toBe(true)
  })

  test("toggle anchors on the toggled row", () => {
    const state = toggled(anchor("tool-x", 0))
    expect(anchorOf(state)).toEqual({ unitId: "tool-x", offset: 0 })
  })

  test("content change keeps the anchor while detached", () => {
    const state = detach(anchor("unit-a", 2))
    expect(contentChanged(state)).toBe(state)
    expect(anchorOf(contentChanged(state))).toEqual({ unitId: "unit-a", offset: 2 })
  })

  test("content change keeps following while following", () => {
    expect(isFollowing(contentChanged(following))).toBe(true)
  })

  test("resize keeps the anchor", () => {
    const state = detach(anchor("unit-a", 7))
    expect(anchorOf(resized(state))).toEqual({ unitId: "unit-a", offset: 7 })
  })

  test("reanchor updates the anchor only while detached", () => {
    const detached = detach(anchor("unit-a", 1))
    expect(anchorOf(reanchor(detached, anchor("unit-b", 9)))).toEqual({ unitId: "unit-b", offset: 9 })
    expect(isFollowing(reanchor(following, anchor("unit-b", 9)))).toBe(true)
  })
})

const viewportOf = (mode: ViewportState, wheel: WheelPhase = wheelIdle, nextToken = 0): TranscriptViewport => ({
  mode,
  wheel,
  nextToken,
})

const wheel = (
  direction: "up" | "down",
  delta: number,
  facts: {
    atTrueBottom?: boolean
    atMountedBottom?: boolean
    anchorPending?: boolean
    anchor?: ViewportAnchor | undefined
  } = {},
): Extract<ViewportEvent, { _tag: "WheelObserved" }> => ({
  _tag: "WheelObserved",
  direction,
  delta,
  atTrueBottom: facts.atTrueBottom ?? false,
  atMountedBottom: facts.atMountedBottom ?? false,
  anchorPending: facts.anchorPending ?? false,
  anchor: "anchor" in facts ? facts.anchor : anchor("unit-a", 0),
})

describe("transcript viewport wheel reducer", () => {
  test("followed wheel-down at the true bottom is an exact no-op", () => {
    const viewport = viewportOf(following)
    const decision = reduceViewport(viewport, wheel("down", 3, { atTrueBottom: true, atMountedBottom: true }))
    expect(decision.viewport).toBe(viewport)
    expect(decision.effects).toEqual([])
  })

  test("followed wheel-down away from the true bottom schedules one settle", () => {
    const decision = reduceViewport(viewportOf(following), wheel("down", 4))
    expect(decision.viewport.mode).toBe(following)
    expect(decision.viewport.wheel).toEqual({ _tag: "AwaitingSettle", token: 0, displacement: 4 })
    expect(decision.viewport.nextToken).toBe(1)
    expect(decision.effects).toEqual([{ _tag: "ScheduleWheelSettle", token: 0 }])
  })

  test("detached wheel-down at the true bottom still schedules a settle", () => {
    const viewport = viewportOf(detach(anchor("unit-a", 2)))
    const decision = reduceViewport(viewport, wheel("down", 1, { atTrueBottom: true }))
    expect(decision.viewport.mode).toBe(viewport.mode)
    expect(decision.effects).toEqual([{ _tag: "ScheduleWheelSettle", token: 0 }])
  })

  test("wheel-down at the mounted bottom accumulates settle scroll across events", () => {
    const first = reduceViewport(viewportOf(following), wheel("down", 2, { atMountedBottom: true }))
    const second = reduceViewport(first.viewport, wheel("down", 3, { atMountedBottom: true }))
    expect(second.viewport.wheel).toEqual({ _tag: "AwaitingSettle", token: 0, displacement: 5 })
    expect(second.effects).toEqual([])
  })

  test("an upward detach cannot reverse into forward paging before the gesture settles", () => {
    const upward = reduceViewport(viewportOf(following), wheel("up", 1))
    const reversed = reduceViewport(upward.viewport, wheel("down", 1, { atMountedBottom: true }))
    const settled = reduceViewport(reversed.viewport, {
      _tag: "WheelSettleFired",
      token: 0,
      atTrueBottom: false,
      atMountedBottom: true,
    })

    expect(isAnchored(settled.viewport.mode)).toBe(true)
    expect(settled.effects).not.toContainEqual({ _tag: "PageForward", scrollBy: 1 })
  })

  test("first wheel-up detaches before notifying and scheduling", () => {
    const decision = reduceViewport(viewportOf(following), wheel("up", 2))
    expect(isAnchored(decision.viewport.mode)).toBe(true)
    expect(decision.effects).toEqual([
      { _tag: "ProjectState" },
      { _tag: "NotifyDetached" },
      { _tag: "ScheduleWheelSettle", token: 0 },
    ])
  })

  test("wheel-up while detached preserves the anchor and does not notify again", () => {
    const mode = detach(anchor("unit-a", 7))
    const decision = reduceViewport(viewportOf(mode), wheel("up", 1))
    expect(decision.viewport.mode).toBe(mode)
    expect(decision.effects).toEqual([{ _tag: "ProjectState" }, { _tag: "ScheduleWheelSettle", token: 0 }])
  })

  test("wheel while an anchor transaction is pending queues into it instead of settling", () => {
    const down = reduceViewport(viewportOf(following), wheel("down", 3, { anchorPending: true }))
    expect(down.viewport.wheel).toEqual(wheelIdle)
    expect(down.effects).toEqual([{ _tag: "QueueAnchorScroll", scrollBy: 3 }])
    const up = reduceViewport(viewportOf(following), wheel("up", 2, { anchorPending: true }))
    expect(up.effects).toEqual([
      { _tag: "ProjectState" },
      { _tag: "NotifyDetached" },
      { _tag: "QueueAnchorScroll", scrollBy: -2 },
    ])
  })

  test("a stale settle token is rejected without effects", () => {
    const scheduled = reduceViewport(viewportOf(following), wheel("down", 1))
    const cancelled = reduceViewport(scheduled.viewport, { _tag: "WheelCancelled" })
    const decision = reduceViewport(cancelled.viewport, {
      _tag: "WheelSettleFired",
      token: 0,
      atTrueBottom: false,
      atMountedBottom: true,
    })
    expect(decision.viewport).toBe(cancelled.viewport)
    expect(decision.effects).toEqual([])
  })

  test("a down settle at the followed true bottom produces no effects", () => {
    const scheduled = reduceViewport(viewportOf(following), wheel("down", 1))
    const decision = reduceViewport(scheduled.viewport, {
      _tag: "WheelSettleFired",
      token: 0,
      atTrueBottom: true,
      atMountedBottom: true,
    })
    expect(decision.viewport.wheel).toEqual(wheelIdle)
    expect(decision.effects).toEqual([])
  })

  test("a down settle at the mounted bottom pages forward with the accumulated scroll", () => {
    const scheduled = reduceViewport(viewportOf(following), wheel("down", 4, { atMountedBottom: true }))
    const decision = reduceViewport(scheduled.viewport, {
      _tag: "WheelSettleFired",
      token: 0,
      atTrueBottom: false,
      atMountedBottom: true,
    })
    expect(decision.viewport.wheel).toEqual(wheelIdle)
    expect(decision.effects).toEqual([{ _tag: "PageForward", scrollBy: 4 }])
  })

  test("an up settle reports settled geometry", () => {
    const scheduled = reduceViewport(viewportOf(detach(anchor("unit-a", 0))), wheel("up", 2))
    const decision = reduceViewport(scheduled.viewport, {
      _tag: "WheelSettleFired",
      token: 0,
      atTrueBottom: false,
      atMountedBottom: false,
    })
    expect(decision.viewport.wheel).toEqual(wheelIdle)
    expect(decision.effects).toEqual([{ _tag: "ReportSettled" }])
  })
})

describe("transcript viewport mode transitions", () => {
  test("settling at the bottom follows and notifies exactly on the detached edge", () => {
    const detached = viewportOf(detach(anchor("unit-a", 1)))
    const followed = reduceViewport(detached, { _tag: "BottomSettled" })
    expect(isFollowing(followed.viewport.mode)).toBe(true)
    expect(followed.effects).toEqual([{ _tag: "ProjectState" }, { _tag: "NotifyFollowed" }])
    const repeat = reduceViewport(followed.viewport, { _tag: "BottomSettled" })
    expect(repeat.viewport).toBe(followed.viewport)
    expect(repeat.effects).toEqual([])
  })

  test("an explicit follow command is an exact no-op while already following", () => {
    const decision = reduceViewport(viewportOf(following), { _tag: "FollowCommanded" })
    expect(isFollowing(decision.viewport.mode)).toBe(true)
    expect(decision.effects).toEqual([])
  })

  test("a detach command anchors and reprojects", () => {
    const decision = reduceViewport(viewportOf(following), {
      _tag: "DetachCommanded",
      anchor: anchor("unit-a", 3),
    })
    expect(isAnchored(decision.viewport.mode)).toBe(true)
    expect(decision.effects).toEqual([{ _tag: "ProjectState" }])
  })

  test("an anchorless detach command cannot create an invalid reading state", () => {
    const decision = reduceViewport(viewportOf(following), {
      _tag: "DetachCommanded",
      anchor: undefined,
    })
    expect(isFollowing(decision.viewport.mode)).toBe(true)
    expect(decision.effects).toEqual([])
  })

  test("an explicit follow command transitions and notifies once", () => {
    const detached = viewportOf(detach(anchor("unit-a", 3)))
    const followed = reduceViewport(detached, { _tag: "FollowCommanded" })
    expect(isFollowing(followed.viewport.mode)).toBe(true)
    expect(followed.effects).toEqual([
      { _tag: "ProjectState" },
      { _tag: "RequestFollowPosition" },
      { _tag: "NotifyFollowed" },
    ])
  })

  test("reset cancels a gesture without reusing its token sequence", () => {
    const pending = viewportOf(following, { _tag: "AwaitingSettle", token: 4, displacement: -2 }, 5)
    const reset = reduceViewport(pending, { _tag: "ResetCommanded" })
    expect(reset.viewport).toEqual({ mode: following, wheel: wheelIdle, nextToken: 5 })
    expect(reset.effects).toEqual([{ _tag: "ProjectState" }, { _tag: "RequestFollowPosition" }])
  })
})

describe("transcript content classification", () => {
  test("distinguishes prepends and appends by stable identity", () => {
    expect(
      classifyTranscriptContent(
        [{ id: "a" }, { id: "b" }],
        [{ id: "older" }, { id: "a" }, { id: "b" }, { id: "newer" }],
      ),
    ).toEqual({ prepended: ["older"], appended: ["newer"], removed: [] })
  })
})

describe("transcript viewport bottom detection", () => {
  test("max scroll top never goes negative", () => {
    expect(maxScrollTop(metrics(0, 10, 30))).toBe(0)
    expect(maxScrollTop(metrics(0, 100, 30))).toBe(70)
  })

  test("at bottom requires the exact maximum, no off-by-one fuzz", () => {
    expect(atBottom(metrics(70, 100, 30))).toBe(true)
    expect(atBottom(metrics(69, 100, 30))).toBe(false)
    expect(atBottom(metrics(71, 100, 30))).toBe(true)
  })

  test("bottom detection shares one viewport-height input across strict and near checks", () => {
    // maxScrollTop derives the single bottom target from the same metrics the
    // near-bottom re-follow fuzz uses, so a followed viewport and a one-row-parked
    // viewport agree on where the bottom is.
    const followed = metrics(70, 100, 30)
    expect(maxScrollTop(followed)).toBe(70)
    expect(atBottomWithin(followed, 0)).toBe(true)
    expect(atBottomWithin(metrics(69, 100, 30), 0)).toBe(false)
    expect(atBottomWithin(metrics(69, 100, 30), 1)).toBe(true)
    expect(atBottom(followed)).toBe(atBottomWithin(followed, 0))
  })

  test("settle re-follows only at the true bottom", () => {
    expect(isFollowing(settle(metrics(70, 100, 30), anchor("u", 0)))).toBe(true)
    const parked = settle(metrics(69, 100, 30), anchor("u", 3))
    expect(isAnchored(parked)).toBe(true)
    expect(anchorOf(parked)).toEqual({ unitId: "u", offset: 3 })
  })

  test("clamps scroll top to live geometry", () => {
    expect(clampScrollTop(200, metrics(0, 100, 30))).toBe(70)
    expect(clampScrollTop(-5, metrics(0, 100, 30))).toBe(0)
    expect(clampScrollTop(50, metrics(0, 100, 30))).toBe(50)
  })

  test("shrink clamps a stale offset down to the new maximum", () => {
    const parkedOffset = 90
    const afterShrink = metrics(parkedOffset, 60, 30)
    expect(clampScrollTop(parkedOffset, afterShrink)).toBe(30)
  })
})

describe("transcript viewport window", () => {
  const limit = 200

  test("initial window mounts everything", () => {
    expect(initialWindow(500)).toEqual({ end: 500 })
    expect(initialWindow(-3)).toEqual({ end: 0 })
  })

  test("window start floors at zero", () => {
    expect(windowStart({ end: 500 }, limit)).toBe(300)
    expect(windowStart({ end: 100 }, limit)).toBe(0)
  })

  test("retreat toward older content stops at the top", () => {
    const retreated = advanceWindow({ end: 500 }, -100, 500, limit)
    expect(retreated.end).toBe(400)
    const atTopWindow = advanceWindow({ end: 300 }, -1000, 500, limit)
    expect(atTopWindow.end).toBe(limit)
    expect(atWindowTop(atTopWindow, limit)).toBe(true)
  })

  test("advance toward newer content stops at the bottom", () => {
    const advanced = advanceWindow({ end: 300 }, 100, 500, limit)
    expect(advanced.end).toBe(400)
    const atBottomWindow = advanceWindow({ end: 400 }, 1000, 500, limit)
    expect(atBottomWindow.end).toBe(500)
    expect(atWindowBottom(atBottomWindow, 500)).toBe(true)
  })

  test("clampWindow snaps to the newest units while following", () => {
    expect(clampWindow({ end: 300 }, 500, limit, true)).toEqual({ end: 500 })
    expect(clampWindow({ end: 0 }, 500, limit, false)).toEqual({ end: 500 })
  })

  test("clampWindow keeps a detached window within bounds when content shrinks", () => {
    expect(clampWindow({ end: 500 }, 320, limit, false)).toEqual({ end: 320 })
    expect(clampWindow({ end: 500 }, 500, limit, false)).toEqual({ end: 500 })
  })
})

describe("transcript viewport data-last overloads agree with data-first", () => {
  const limit = 200
  const window = { end: 500 }
  const geometry = metrics(50, 100, 30)
  const held = anchor("unit-a", 4)

  test("scroll and anchor transitions", () => {
    expect(clampScrollTop(geometry)(200)).toBe(clampScrollTop(200, geometry))
    expect(reanchor(held)(detach(anchor("unit-b", 1)))).toEqual(reanchor(detach(anchor("unit-b", 1)), held))
    expect(settle(held)(geometry)).toEqual(settle(geometry, held))
  })

  test("window queries and transitions", () => {
    expect(windowStart(limit)(window)).toBe(windowStart(window, limit))
    expect(atWindowTop(limit)(window)).toBe(atWindowTop(window, limit))
    expect(atWindowBottom(500)(window)).toBe(atWindowBottom(window, 500))
    expect(advanceWindow(-100, 500, limit)(window)).toEqual(advanceWindow(window, -100, 500, limit))
    expect(clampWindow(320, limit, false)(window)).toEqual(clampWindow(window, 320, limit, false))
  })
})
