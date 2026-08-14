import { describe, expect, it } from "@effect/vitest"
import { HarnessEntry, HarnessState } from "@batonfx/harness"
import { Effect } from "effect"
import * as ExecutionPins from "@rika/kernel/execution-pins"
import * as SnapshotPin from "@rika/kernel/harness-snapshot-pin"

const entry = (id: string, content: string): HarnessEntry.HarnessEntry => ({
  id,
  kind: "memory",
  scope: "thread:session",
  title: "t",
  content,
  version: 1,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
})

const state = (entries: ReadonlyArray<HarnessEntry.HarnessEntry>) =>
  HarnessState.make({ scope: "thread:session", entries })

describe("skill pins on the Agent manifest", () => {
  it("turns discovered skills into named capabilities, replacing the pinned empty list", () => {
    const pinned = ExecutionPins.skills([
      { name: "review", digest: "a".repeat(64) },
      { name: "deploy", digest: "b".repeat(64), importName: "@acme/deploy-skill" },
    ])
    expect(pinned.capabilities.map((capability) => capability.name)).toEqual(["deploy", "review"])
    for (const capability of pinned.capabilities) expect(capability.pin).toMatch(/^capability-pin:/)
  })

  it("emits one registration per capability so every required pin resolves", () => {
    const pinned = ExecutionPins.skills([{ name: "review", digest: "a".repeat(64) }])
    expect(pinned.registrations).toHaveLength(1)
    expect(pinned.registrations[0]).toMatchObject({
      pin: pinned.capabilities[0]!.pin,
      codec: "rika-skill",
      version: "1",
    })
  })

  it("pins name and digest only, never a skill body", () => {
    const pinned = ExecutionPins.skills([{ name: "review", digest: "a".repeat(64) }])
    expect(pinned.registrations[0]!.payload).toEqual({ name: "review", digest: "a".repeat(64) })
  })

  it("carries the import name so a TypeScript-backed skill is reconstructable", () => {
    const pinned = ExecutionPins.skills([{ name: "deploy", digest: "b".repeat(64), importName: "@acme/deploy" }])
    expect(pinned.registrations[0]!.payload).toMatchObject({ importName: "@acme/deploy" })
  })

  it("gives a changed skill a different pin, so a replay cannot silently use a new body", () => {
    const before = ExecutionPins.skills([{ name: "review", digest: "a".repeat(64) }])
    const after = ExecutionPins.skills([{ name: "review", digest: "c".repeat(64) }])
    expect(after.capabilities[0]!.pin).not.toBe(before.capabilities[0]!.pin)
  })

  it("is stable under input order, so discovery order cannot churn the Execution", () => {
    const left = ExecutionPins.skills([
      { name: "review", digest: "a".repeat(64) },
      { name: "deploy", digest: "b".repeat(64) },
    ])
    const right = ExecutionPins.skills([
      { name: "deploy", digest: "b".repeat(64) },
      { name: "review", digest: "a".repeat(64) },
    ])
    expect(right.capabilities).toEqual(left.capabilities)
  })

  it("pins nothing when nothing was discovered", () => {
    expect(ExecutionPins.skills([])).toEqual({ capabilities: [], registrations: [] })
  })
})

describe("harness snapshot on the Agent manifest", () => {
  it("pins the snapshot as one named service capability", () => {
    const pinned = ExecutionPins.harness(state([entry("a", "c")]))
    expect(pinned.capabilities).toHaveLength(1)
    expect(pinned.capabilities[0]!.name).toBe("rika-harness-snapshot")
  })

  it("registers the payload under Baton's own harness codec", () => {
    const pinned = ExecutionPins.harness(state([entry("a", "c")]))
    expect(pinned.registrations[0]).toMatchObject({ codec: "@batonfx/harness/snapshot", version: "1" })
  })

  it.effect("registers a payload that reconstructs the exact pinned snapshot", () =>
    Effect.gen(function* () {
      const source = state([entry("a", "c")])
      const pinned = ExecutionPins.harness(source)
      const restored = yield* SnapshotPin.reconstruct(HarnessState.snapshotId(source), pinned.registrations[0]!.payload)
      expect(HarnessState.snapshotId(restored)).toBe(HarnessState.snapshotId(source))
    }),
  )

  it("changes the pin when the harness is refined, so the NEXT Execution is a new one", () => {
    const before = ExecutionPins.harness(state([entry("a", "c")]))
    const after = ExecutionPins.harness(state([entry("a", "refined")]))
    expect(after.capabilities[0]!.pin).not.toBe(before.capabilities[0]!.pin)
  })

  it("leaves the pin unchanged when nothing was refined, so an idle Turn does not churn", () => {
    const before = ExecutionPins.harness(state([entry("a", "c")]))
    const after = ExecutionPins.harness(state([entry("a", "c")]))
    expect(after.capabilities[0]!.pin).toBe(before.capabilities[0]!.pin)
  })
})
