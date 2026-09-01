import { describe, expect, it } from "@effect/vitest"
import { animationActive } from "../../../src/opentui/surface/content"
import { initial, type Model } from "../../../src/state/model"

const model = (): Model => ({
  ...initial("/work", "high"),
  width: 120,
  height: 40,
})

describe("connection animation", () => {
  it("stops after a terminal disconnect", () => {
    const connection = { target: "runner" as const, participants: 1 }
    expect(animationActive({ ...model(), connection: { ...connection, connectivity: "reconnecting" } })).toBe(true)
    expect(animationActive({ ...model(), connection: { ...connection, connectivity: "disconnected" } })).toBe(false)
  })
})
