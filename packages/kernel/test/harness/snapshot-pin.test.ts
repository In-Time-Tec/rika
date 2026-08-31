import { describe, expect, it } from "@effect/vitest"
import { Entry, State } from "generalist/instructions"
import { Effect } from "effect"
import * as SnapshotPin from "@rika/kernel/harness-snapshot-pin"
import * as PromptSections from "@rika/kernel/harness-prompt-sections"

const entry = (id: string, title: string, content: string): Entry.GuidanceEntry => ({
  id,
  kind: "memory",
  scope: "thread:session",
  title,
  content,
  version: 1,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
})

const state = (entries: ReadonlyArray<Entry.GuidanceEntry>) => State.make({ scope: "thread:session", entries })

describe("harness snapshot pinning", () => {
  it("pins a content-addressed capability an Execution can carry", () => {
    const pinned = SnapshotPin.pin(state([entry("a", "t", "c")]))
    expect(pinned.capability.name).toBe("rika-harness-snapshot")
    expect(pinned.id).toMatch(/^guidance-snapshot:v1:sha256:[0-9a-f]{64}$/)
  })

  it("gives the same state the same pin, so an unchanged harness does not churn the Execution", () => {
    const left = SnapshotPin.pin(state([entry("a", "t", "c")]))
    const right = SnapshotPin.pin(state([entry("a", "t", "c")]))
    expect(right.id).toBe(left.id)
    expect(right.capability.pin).toBe(left.capability.pin)
  })

  it("gives a refined state a different pin, which is what makes the next Execution new", () => {
    const before = SnapshotPin.pin(state([entry("a", "t", "c")]))
    const after = SnapshotPin.pin(state([entry("a", "t", "refined")]))
    expect(after.id).not.toBe(before.id)
  })

  it.effect("reconstructs the exact pinned state", () =>
    Effect.gen(function* () {
      const pinned = SnapshotPin.pin(state([entry("a", "t", "c")]))
      const restored = yield* SnapshotPin.reconstruct(pinned.id, pinned.payload)
      expect(State.snapshotId(restored)).toBe(pinned.id)
      expect(restored.entries.memory.map((value) => value.id)).toEqual(["a"])
    }),
  )

  it.effect("fails typed when a payload drifts from the id it claims", () =>
    Effect.gen(function* () {
      const pinned = SnapshotPin.pin(state([entry("a", "t", "c")]))
      const drifted = SnapshotPin.pin(state([entry("a", "t", "tampered")]))
      const failure = yield* Effect.flip(SnapshotPin.reconstruct(pinned.id, drifted.payload))
      expect(failure._tag).toBe("generalist/instructions/SnapshotMismatch")
    }),
  )

  it.effect("fails typed when a payload is not a harness snapshot at all", () =>
    Effect.gen(function* () {
      const pinned = SnapshotPin.pin(state([]))
      const failure = yield* Effect.flip(SnapshotPin.reconstruct(pinned.id, { nonsense: true }))
      expect(failure._tag).toBe("generalist/instructions/SnapshotInvalid")
    }),
  )

  it("derives the overview from the same state it pins, so the prompt cannot drift from the pin", () => {
    const pinned = SnapshotPin.pin(state([entry("a", "remember this", "c")]))
    expect(pinned.overview).toContain("remember this")
  })
})

describe("prompt sections", () => {
  const input = { harness: state([entry("a", "remember this", "c")]), skillListings: "", mcpServers: [] }

  it("always carries the bounded harness overview", () => {
    expect(PromptSections.sections(input).map((section) => section.name)).toEqual(["continual-harness"])
  })

  it("omits the skill and MCP sections entirely when there is nothing to say", () => {
    expect(PromptSections.block(input)).not.toContain("<skills>")
    expect(PromptSections.block(input)).not.toContain("<mcp-servers>")
  })

  it("lists MCP server names only, never tool schemas", () => {
    const text = PromptSections.block({ ...input, mcpServers: ["files", "search"] })
    expect(text).toContain("- files")
    expect(text).toContain("- search")
    expect(text).toContain("rika.mcp.tools({ server })")
    expect(text).not.toContain("inputSchema")
  })

  it("passes the skill listing string through without re-formatting it", () => {
    const text = PromptSections.block({ ...input, skillListings: "- review: check the diff" })
    expect(text).toContain("<skills>\n- review: check the diff\n</skills>")
  })

  it("returns additions only, so the base prompt is never rewritten by a harness entry", () => {
    const bare = PromptSections.block({ harness: state([]), skillListings: "", mcpServers: [] })
    const refined = PromptSections.block(input)
    expect(bare.startsWith("<continual-harness>")).toBe(true)
    expect(refined.startsWith("<continual-harness>")).toBe(true)
    expect(refined).not.toContain("Work directly on the user")
  })

  it("respects tightened overview bounds", () => {
    const many = state(Array.from({ length: 12 }, (_, index) => entry(`note${index}`, "t", "c")))
    const text = PromptSections.block({ ...input, harness: many, overviewOptions: { maxEntriesPerKind: 2 } })
    expect(text).toContain("memory: 12 (showing 2)")
  })
})
