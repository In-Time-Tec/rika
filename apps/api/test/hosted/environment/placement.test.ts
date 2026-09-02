import { describe, expect, it } from "vitest"
import { DateTime } from "effect"
import { orbWorkspaceReadiness } from "../../../src/hosted/environment/placement"

const now = DateTime.toDate(DateTime.makeUnsafe("2026-09-02T12:00:00.000Z"))
const future = DateTime.toDate(DateTime.makeUnsafe("2026-09-02T12:05:00.000Z"))
const past = DateTime.toDate(DateTime.makeUnsafe("2026-09-02T11:55:00.000Z"))

const placement = (
  overrides: Partial<Parameters<typeof orbWorkspaceReadiness>[0]> = {},
): Parameters<typeof orbWorkspaceReadiness>[0] => ({
  lifecycle: null,
  leaseExpiresAt: null,
  latestCheckpointId: null,
  previousPreparationReady: false,
  preparationState: null,
  databaseNow: now,
  ...overrides,
})

describe("Orb workspace readiness", () => {
  it.each([
    ["unassigned initial workspace", placement(), "fresh"],
    ["initial provisioning", placement({ lifecycle: "provisioning", preparationState: "preparing" }), "fresh"],
    ["failed initial preparation", placement({ preparationState: "failed" }), "fresh"],
    [
      "active prepared workspace with a live lease",
      placement({ lifecycle: "active", leaseExpiresAt: future, preparationState: "ready" }),
      "hot",
    ],
    [
      "prepared workspace with an expired lease",
      placement({ lifecycle: "active", leaseExpiresAt: past, preparationState: "ready" }),
      "cold",
    ],
    ["paused prepared workspace", placement({ lifecycle: "paused", preparationState: "ready" }), "cold"],
    [
      "replacement generation restored from a checkpoint",
      placement({ lifecycle: "provisioning", latestCheckpointId: "checkpoint-1", preparationState: "preparing" }),
      "cold",
    ],
    [
      "replacement generation after an earlier successful preparation",
      placement({ lifecycle: "provisioning", previousPreparationReady: true, preparationState: "preparing" }),
      "cold",
    ],
  ] as const)("classifies %s", (_name, row, expected) => {
    expect(orbWorkspaceReadiness(row)).toBe(expected)
  })
})
