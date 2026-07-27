import { describe, expect, it } from "@effect/vitest"
import { applyEvent, empty, isTransientEvent, project, type Projection, type SourceEvent } from "../src"

const transientDelta = (index: number, text: string): SourceEvent => ({
  cursor: `delta-${index}`,
  sequence: 1,
  type: "model.output.delta",
  createdAt: index,
  text,
  data: { delta: text, transient_index: index },
})

const transientReasoning = (index: number, text: string): SourceEvent => ({
  cursor: `reasoning-${index}`,
  sequence: 1,
  type: "model.reasoning.delta",
  createdAt: index,
  text,
  data: { delta: text, transient_index: index },
})

const assistantText = (projection: Projection): string => {
  const unit = projection.units.find(
    (candidate) => candidate.content._tag === "Entry" && candidate.content.role === "assistant",
  )
  return unit?.content._tag === "Entry" ? unit.content.text : ""
}

const reasoningText = (projection: Projection): string => {
  const unit = projection.units.find(
    (candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "Reasoning",
  )
  return unit?.content._tag === "Block" && unit.content.block._tag === "Reasoning" ? unit.content.block.text : ""
}

const entryTexts = (projection: Projection) =>
  projection.units.map((unit) => {
    if (unit.content._tag === "Entry") return unit.content.text
    if (unit.content.block._tag === "Reasoning") return unit.content.block.text
    return unit.content.block._tag
  })

describe("transient events", () => {
  it("identifies transients by type and transient index", () => {
    expect(isTransientEvent(transientDelta(1, "a"))).toBe(true)
    expect(
      isTransientEvent({ cursor: "legacy", sequence: 5, type: "model.output.delta", createdAt: 5, text: "a" }),
    ).toBe(false)
    expect(
      isTransientEvent({
        cursor: "durable",
        sequence: 5,
        type: "model.output.completed",
        createdAt: 5,
        data: { transient_index: 1 },
      }),
    ).toBe(false)
  })

  it("applies transient delta content without advancing revision or cursors", () => {
    const base = applyEvent(empty("turn-a", "prompt"), {
      cursor: "prepared",
      sequence: 1,
      type: "model.input.prepared",
      createdAt: 1,
    })
    const streamed = applyEvent(applyEvent(base, transientDelta(1, "hel")), transientDelta(2, "lo"))

    expect(assistantText(streamed)).toBe("hello")
    expect(streamed.revision).toBe(base.revision)
    expect(streamed.checkpointCursor).toBe(base.checkpointCursor)
    expect(streamed.oldestCursor).toBe(base.oldestCursor)
  })

  it("replaces streamed cycle text with the durable cycle completion without duplication", () => {
    const base = applyEvent(empty("turn-a", "prompt"), {
      cursor: "prepared",
      sequence: 1,
      type: "model.input.prepared",
      createdAt: 1,
    })
    const streamed = applyEvent(applyEvent(base, transientDelta(1, "hel")), transientDelta(2, "lo"))
    const completed = applyEvent(streamed, {
      cursor: "cycle-0",
      sequence: 2,
      type: "model.cycle.completed",
      createdAt: 3,
      data: { text: "hello" },
    })

    expect(assistantText(completed)).toBe("hello")
    expect(completed.revision).toBe(2)
    expect(completed.checkpointCursor).toBe("cycle-0")
  })

  it("replaces streamed reasoning with the durable reasoning completion", () => {
    const base = applyEvent(empty("turn-a", "prompt"), {
      cursor: "prepared",
      sequence: 1,
      type: "model.input.prepared",
      createdAt: 1,
    })
    const streamed = applyEvent(applyEvent(base, transientReasoning(1, "thinking ")), transientReasoning(2, "hard"))
    const completed = applyEvent(streamed, {
      cursor: "cycle-reasoning-0",
      sequence: 2,
      type: "model.reasoning.completed",
      createdAt: 3,
      data: { text: "thinking hard" },
    })

    expect(reasoningText(streamed)).toBe("thinking hard")
    expect(reasoningText(completed)).toBe("thinking hard")
  })

  it("projects a replay-only history to the same content as the live stream", () => {
    const durable: ReadonlyArray<SourceEvent> = [
      { cursor: "prepared-0", sequence: 1, type: "model.input.prepared", createdAt: 1 },
      { cursor: "cycle-0", sequence: 2, type: "model.cycle.completed", createdAt: 2, data: { text: "first cycle" } },
      { cursor: "cycle-r-0", sequence: 3, type: "model.reasoning.completed", createdAt: 3, data: { text: "thoughts" } },
      {
        cursor: "tool-0",
        sequence: 4,
        type: "tool.call.requested",
        createdAt: 4,
        data: { tool_call_id: "call", tool_name: "read", input: "a" },
      },
      { cursor: "result-0", sequence: 5, type: "tool.result.received", createdAt: 5, data: { tool_call_id: "call" } },
      { cursor: "prepared-1", sequence: 6, type: "model.input.prepared", createdAt: 6 },
      { cursor: "cycle-1", sequence: 7, type: "model.cycle.completed", createdAt: 7, data: { text: "final answer" } },
      {
        cursor: "completed",
        sequence: 8,
        type: "model.output.completed",
        createdAt: 8,
        data: { model_output: "final answer" },
        text: "final answer",
      },
      { cursor: "terminal", sequence: 9, type: "execution.completed", createdAt: 9 },
    ]
    const live = [
      durable[0]!,
      transientDelta(1, "first "),
      transientDelta(2, "cycle"),
      ...durable.slice(1, 6),
      { ...transientDelta(3, "final "), cursor: "delta-3" },
      { ...transientDelta(4, "answer"), cursor: "delta-4" },
      ...durable.slice(6),
    ]

    const replayed = project("turn-a", "prompt", durable)
    const streamed = live.reduce((current, event) => applyEvent(current, event), empty("turn-a", "prompt"))

    expect(entryTexts(replayed)).toEqual(entryTexts(streamed))
    expect(replayed.revision).toBe(streamed.revision)
  })

  it("keeps legacy durable delta histories advancing the revision", () => {
    const base = applyEvent(empty("turn-a", "prompt"), {
      cursor: "prepared",
      sequence: 1,
      type: "model.input.prepared",
      createdAt: 1,
    })
    const legacy = applyEvent(base, {
      cursor: "legacy-delta",
      sequence: 2,
      type: "model.output.delta",
      createdAt: 2,
      text: "legacy",
    })

    expect(assistantText(legacy)).toBe("legacy")
    expect(legacy.revision).toBe(2)
    expect(legacy.checkpointCursor).toBe("legacy-delta")
  })
})
