import { describe, expect, it } from "@effect/vitest"
import { animationActive, lifecycleLabel, statusContent } from "../../../src/opentui/surface/content"
import { initial, type Model } from "../../../src/state/model"
import { styledTextValue } from "../../support/surface/transcript/pane-geometry.fixture"

const model = (): Model => ({
  ...initial("/work", "high"),
  width: 120,
  height: 40,
})

it("keeps the Unicode spinner but hides the internal finishing label", () => {
  const finishing = { ...model(), busy: true, activity: { _tag: "Finishing" as const } }

  expect(lifecycleLabel(finishing, 0)).toBeUndefined()
  expect(styledTextValue(statusContent(finishing, 0, 0))).toBe(" ∼ ")
  expect(styledTextValue(statusContent(finishing, 2, 0))).toBe(" ≋ ")
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

  it("uses explicit sandbox status instead of inferring it from an Orb submission", () => {
    const sending = { ...model(), busy: true, activity: { _tag: "Sending" as const } }
    const connection = { connectivity: "connected" as const, participants: 1 }
    expect(
      lifecycleLabel({ ...sending, connection: { ...connection, target: "orb", activity: "executor-waiting" } }, 0),
    ).toBe("Sending")
    expect(
      lifecycleLabel({ ...sending, connection: { ...connection, target: "runner", activity: "executor-waiting" } }, 0),
    ).toBe("Sending")
    expect(lifecycleLabel({ ...sending, connection: { ...connection, target: "orb", activity: "terminal" } }, 0)).toBe(
      "Sending",
    )
  })

  it.each([
    ["sandbox-preparing", "Preparing sandbox"],
    ["sandbox-waking", "Waking sandbox"],
    ["prompt-waiting", "Waiting"],
  ] as const)("renders %s exactly", (activity, expected) => {
    expect(
      lifecycleLabel(
        {
          ...model(),
          busy: true,
          activity: { _tag: "Sending" },
          connection: { connectivity: "connected", target: "orb", participants: 1, activity },
        },
        0,
      ),
    ).toBe(expected)
  })

  it("keeps connectivity failures above sandbox status", () => {
    expect(
      lifecycleLabel(
        {
          ...model(),
          connection: {
            connectivity: "disconnected",
            target: "orb",
            participants: 1,
            activity: "sandbox-waking",
            errorMessage: "Network unavailable",
          },
        },
        0,
      ),
    ).toBe("Disconnected · Network unavailable")
  })
})
