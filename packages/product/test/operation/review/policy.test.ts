import { expect, test } from "vitest"
import { isReviewRouteMode, reviewIntent, reviewRouteMode } from "../../../src/operation/review/policy"

test("selects one immutable ordered review policy", () => {
  const intent = reviewIntent("inspect the change")
  expect(intent).toMatchObject({
    _tag: "Review",
    concurrency: 3,
    completion: "wait-for-all",
    lanes: [{ key: "correctness" }, { key: "security" }, { key: "quality" }],
  })
  expect(intent.lanes.every(({ prompt }) => prompt.endsWith("Request:\ninspect the change"))).toBe(true)
  expect(reviewRouteMode("medium")).toBe("review:medium")
  expect(isReviewRouteMode("review:medium")).toBe(true)
  expect(isReviewRouteMode("medium")).toBe(false)
})
