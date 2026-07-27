import { describe, expect, it } from "@effect/vitest"
import { applyEvent, empty, isTransientEvent, project, type Projection, type SourceEvent } from "../src"

const transientDelta = (index: number, text: string, sequence = 1): SourceEvent => ({
  cursor: `delta-${index}`,
  sequence,
  type: "model.output.delta",
  createdAt: index,
  text,
  data: { delta: text, transient_index: index },
})

const transientReasoning = (index: number, text: string, sequence = 1): SourceEvent => ({
  cursor: `reasoning-${index}`,
  sequence,
  type: "model.reasoning.delta",
  createdAt: index,
  text,
  data: { delta: text, transient_index: index },
})

const durable = (sequence: number, type: string, data?: Record<string, unknown>): SourceEvent => ({
  cursor: `${type}-${sequence}`,
  sequence,
  type,
  createdAt: sequence,
  ...(data === undefined ? {} : { data }),
})

const keysOf = (projection: Projection) => projection.units.map((unit) => unit.key)

const fold = (events: ReadonlyArray<SourceEvent>, projection: Projection) =>
  events.reduce((current, event) => applyEvent(current, event), projection)

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

  it("ignores transient deltas re-delivered after the durable cycle completed", () => {
    const reply = "I’ll trace the current permission/path enforcement and every related test."
    const thoughts = "**Planning project exploration and permissions review**"
    const streamed = fold(
      [
        durable(0, "execution.accepted"),
        durable(1, "execution.started"),
        durable(2, "model.input.prepared"),
        durable(3, "model.call.started"),
        durable(4, "model.attempt.started"),
        durable(5, "model.attempt.first_output"),
        transientReasoning(1, thoughts, 5),
        durable(6, "model.attempt.first_output"),
        transientDelta(2, reply, 6),
        durable(7, "model.attempt.first_output"),
        durable(8, "model.cycle.completed", { text: reply }),
        durable(9, "model.reasoning.completed", { text: thoughts }),
        durable(10, "tool.call.requested", { tool_call_id: "call_t80", tool_name: "read", input: "{}" }),
        durable(11, "tool.call.requested", { tool_call_id: "call_BLq", tool_name: "read", input: "{}" }),
        durable(14, "execution.cancelled"),
      ],
      empty("turn-a", "prompt"),
    )
    const reattached = fold([transientReasoning(1, thoughts, 5), transientDelta(2, reply, 6)], streamed)

    expect(keysOf(streamed)).toEqual(keysOf(reattached))
    expect(keysOf(reattached)).toEqual([
      "turn:turn-a:user",
      "reasoning:turn-a:0",
      "assistant:turn-a:0",
      "tool:turn-a:call_t80",
      "tool:turn-a:call_BLq",
      "execution:turn-a:cancelled",
    ])
    expect(assistantText(reattached)).toBe(reply)
    expect(reasoningText(reattached)).toBe(thoughts)
  })

  it("ignores transient deltas from an earlier cycle after steering advanced the model phase", () => {
    const first = "I’ll create an isolated worktree and branch from the current remote main."
    const latest = "The isolated branch is now based on the fetched remote main."
    const streamed = fold(
      [
        durable(2, "model.input.prepared"),
        durable(5, "model.attempt.first_output"),
        transientDelta(1, first, 5),
        durable(8, "model.cycle.completed", { text: first }),
        durable(10, "tool.call.requested", { tool_call_id: "call_mAk", tool_name: "read", input: "{}" }),
        durable(11, "tool.result.received", { tool_call_id: "call_mAk" }),
        durable(15, "steering.delivered", { message_count: 1 }),
        durable(16, "model.call.started"),
        durable(26, "steering.delivered", { message_count: 1 }),
        durable(29, "model.attempt.first_output"),
        durable(32, "model.cycle.completed", { text: latest }),
        durable(34, "tool.call.requested", { tool_call_id: "call_Alg", tool_name: "read", input: "{}" }),
        durable(46, "execution.cancelled"),
      ],
      empty("turn-b", "prompt"),
    )
    const reattached = applyEvent(streamed, transientDelta(1, first, 5))

    expect(keysOf(streamed)).toEqual(keysOf(reattached))
    expect(reattached.units.filter((unit) => unit.key.startsWith("assistant:turn-b:"))).toHaveLength(2)
    expect(entryTexts(reattached).filter((text) => text === first)).toHaveLength(1)
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
