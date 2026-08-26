import { describe, expect, test } from "vitest"
import { reduceViewport } from "../../../../src/presentation/transcript/viewport/reducer"
import { isFollowing, isAnchored, anchorOf } from "../../../../src/presentation/transcript/viewport/model"
import { following, wheelIdle, type TranscriptViewport } from "../../../../src/presentation/transcript/viewport/state"

const viewport = (): TranscriptViewport => ({ mode: following, wheel: wheelIdle, nextToken: 0 })
const anchor = { unitId: "unit-a", offset: 3 }

describe("follow detaches permanently until true bottom", () => {
  test("scrolling up detaches", () => {
    const detached = reduceViewport(viewport(), {
      _tag: "WheelObserved",
      direction: "up",
      delta: 3,
      atTrueBottom: false,
      atMountedBottom: false,
      anchorPending: false,
      anchor,
    })
    expect(isAnchored(detached.viewport.mode)).toBe(true)
    expect(anchorOf(detached.viewport.mode)).toEqual(anchor)
  })

  test("a settle that is not at the true bottom never re-follows", () => {
    const detached = { ...viewport(), mode: { _tag: "Anchored" as const, anchor } }
    const settled = reduceViewport(detached, {
      _tag: "WheelSettleFired",
      token: 0,
      atTrueBottom: false,
      atMountedBottom: false,
    })
    expect(isFollowing(settled.viewport.mode)).toBe(false)
  })

  test("reaching the true bottom re-follows exactly once", () => {
    const detached = { ...viewport(), mode: { _tag: "Anchored" as const, anchor } }
    const settled = reduceViewport(detached, { _tag: "BottomSettled" })
    expect(isFollowing(settled.viewport.mode)).toBe(true)
    expect(settled.effects.some((effect) => effect._tag === "NotifyFollowed")).toBe(true)
    const again = reduceViewport(settled.viewport, { _tag: "BottomSettled" })
    expect(again.effects).toEqual([])
  })

  test("an anchorless detach cannot strand the viewport", () => {
    const decision = reduceViewport(viewport(), { _tag: "DetachCommanded", anchor: undefined })
    expect(isFollowing(decision.viewport.mode)).toBe(true)
    expect(decision.effects).toEqual([])
  })

  test("wheel down while following at the true bottom is an exact no-op", () => {
    const decision = reduceViewport(viewport(), {
      _tag: "WheelObserved",
      direction: "down",
      delta: 2,
      atTrueBottom: true,
      atMountedBottom: true,
      anchorPending: false,
      anchor,
    })
    expect(decision.effects).toEqual([])
    expect(isFollowing(decision.viewport.mode)).toBe(true)
  })
})
