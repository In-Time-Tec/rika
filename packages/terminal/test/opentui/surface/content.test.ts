import { describe, expect, it } from "@effect/vitest"
import { animationActive, lifecycleLabel } from "../../../src/opentui/surface/content"
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

  it("shows the disconnect cause instead of a bare status", () => {
    expect(
      lifecycleLabel(
        {
          ...model(),
          connection: {
            connectivity: "disconnected",
            target: "runner",
            participants: 1,
            errorMessage: "Runner registration failed",
          },
        },
        0,
      ),
    ).toBe("Disconnected · Runner registration failed")
  })

  it("names Orb preparation while a first prompt waits for the sandbox", () => {
    const sending = { ...model(), busy: true, activity: { _tag: "Sending" as const } }
    const connection = { connectivity: "connected" as const, participants: 1 }
    expect(
      lifecycleLabel({ ...sending, connection: { ...connection, target: "orb", activity: "executor-waiting" } }, 0),
    ).toBe("Preparing Orb workspace")
    expect(
      lifecycleLabel({ ...sending, connection: { ...connection, target: "runner", activity: "executor-waiting" } }, 0),
    ).toBe("Sending")
    expect(lifecycleLabel({ ...sending, connection: { ...connection, target: "orb", activity: "terminal" } }, 0)).toBe(
      "Sending",
    )
  })
})
