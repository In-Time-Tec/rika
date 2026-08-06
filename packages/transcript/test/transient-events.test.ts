import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import { foldOperations } from "../src/projection/transcript-event-fold"
const { applyFoldEvent, isTransientEvent, restoreProjectionFold, snapshotFoldProjection } = foldOperations
import type { Projection } from "../src/schema/transcript-projection-model"
import type { SourceEvent } from "../src/schema/transcript-source-event"

const attemptData = (attempt: string) => ({ model_call_id: `call-${attempt}`, model_attempt_id: `attempt-${attempt}` })

const transientDelta = (index: number, text: string, sequence = 1, attempt = "a"): SourceEvent => ({
  cursor: `delta-${attempt}-${index}`,
  sequence,
  type: "model.output.delta",
  createdAt: index,
  text,
  data: { delta: text, transient_index: index, ...attemptData(attempt) },
})

const transientReasoning = (index: number, text: string, sequence = 1, attempt = "a"): SourceEvent => ({
  cursor: `reasoning-${attempt}-${index}`,
  sequence,
  type: "model.reasoning.delta",
  createdAt: index,
  text,
  data: { delta: text, transient_index: index, ...attemptData(attempt) },
})

const transientTool = (index: number, id: string, sequence = 1, attempt = "a"): SourceEvent => ({
  cursor: `tool-${attempt}-${index}`,
  sequence,
  type: "model.toolcall.delta",
  createdAt: index,
  data: {
    delta: `{"path":"${id}"}`,
    tool_call_id: id,
    tool_name: "read",
    transient_index: index,
    ...attemptData(attempt),
  },
})

const durableEvent = (sequence: number, type: string, data?: Record<string, unknown>): SourceEvent => ({
  cursor: `${type}-${sequence}`,
  sequence,
  type,
  createdAt: sequence,
  ...(data === undefined ? {} : { data }),
})

const keysOf = (projection: Projection) => projection.units.map((unit) => unit.key)

const fold = (events: ReadonlyArray<SourceEvent>, projection: Projection) => {
  const retained = restoreProjectionFold(projection)
  for (const event of events) applyFoldEvent(retained, event)
  return snapshotFoldProjection(retained)
}

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
      isTransientEvent({ cursor: "delta", sequence: 5, type: "model.output.delta", createdAt: 5, text: "a" }),
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
    const base = TranscriptProjection.Projection.applyEvent(TranscriptProjection.Projection.empty("turn-a", "prompt"), {
      cursor: "prepared",
      sequence: 1,
      type: "model.input.prepared",
      createdAt: 1,
    })
    const streamed = TranscriptProjection.Projection.applyEvent(
      TranscriptProjection.Projection.applyEvent(base, transientDelta(1, "hel")),
      transientDelta(2, "lo"),
    )

    expect(assistantText(streamed)).toBe("hello")
    expect(streamed.revision).toBe(base.revision)
    expect(streamed.checkpointCursor).toBe(base.checkpointCursor)
    expect(streamed.oldestCursor).toBe(base.oldestCursor)
  })

  it("replaces streamed text with the durable model output without duplication", () => {
    const base = TranscriptProjection.Projection.applyEvent(TranscriptProjection.Projection.empty("turn-a", "prompt"), {
      cursor: "prepared",
      sequence: 1,
      type: "model.input.prepared",
      createdAt: 1,
    })
    const streamed = TranscriptProjection.Projection.applyEvent(
      TranscriptProjection.Projection.applyEvent(base, transientDelta(1, "hel")),
      transientDelta(2, "lo"),
    )
    const completed = TranscriptProjection.Projection.applyEvent(streamed, {
      cursor: "cycle-0",
      sequence: 2,
      type: "model.output.completed",
      createdAt: 3,
      text: "hello",
    })

    expect(assistantText(completed)).toBe("hello")
    expect(completed.revision).toBe(2)
    expect(completed.checkpointCursor).toBe("cycle-0")
  })

  it("replaces streamed reasoning with the durable reasoning completion", () => {
    const base = TranscriptProjection.Projection.applyEvent(TranscriptProjection.Projection.empty("turn-a", "prompt"), {
      cursor: "prepared",
      sequence: 1,
      type: "model.input.prepared",
      createdAt: 1,
    })
    const streamed = TranscriptProjection.Projection.applyEvent(
      TranscriptProjection.Projection.applyEvent(base, transientReasoning(1, "thinking ")),
      transientReasoning(2, "hard"),
    )
    const completed = TranscriptProjection.Projection.applyEvent(streamed, {
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
      { cursor: "cycle-0", sequence: 2, type: "model.output.completed", createdAt: 2, text: "first cycle" },
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
      { cursor: "cycle-1", sequence: 7, type: "model.output.completed", createdAt: 7, text: "final answer" },
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

    const replayed = TranscriptProjection.Projection.project("turn-a", "prompt", durable)
    const streamed = live.reduce(
      (current, event) => TranscriptProjection.Projection.applyEvent(current, event),
      TranscriptProjection.Projection.empty("turn-a", "prompt"),
    )

    expect(entryTexts(replayed)).toEqual(entryTexts(streamed))
    expect(replayed.revision).toBe(streamed.revision)
  })

  it("ignores transient deltas re-delivered after the durable cycle completed", () => {
    const reply = "I’ll trace the current permission/path enforcement and every related test."
    const thoughts = "**Planning project exploration and permissions review**"
    const streamed = fold(
      [
        durableEvent(0, "execution.accepted"),
        durableEvent(1, "execution.started"),
        durableEvent(2, "model.input.prepared"),
        durableEvent(3, "model.call.started"),
        durableEvent(4, "model.attempt.started"),
        durableEvent(5, "model.attempt.first_output"),
        transientReasoning(1, thoughts, 5),
        durableEvent(6, "model.attempt.first_output"),
        transientDelta(2, reply, 6),
        durableEvent(7, "model.attempt.first_output"),
        { ...durableEvent(8, "model.output.completed"), text: reply },
        durableEvent(9, "model.reasoning.completed", { text: thoughts }),
        durableEvent(10, "tool.call.requested", { tool_call_id: "call_t80", tool_name: "read", input: "{}" }),
        durableEvent(11, "tool.call.requested", { tool_call_id: "call_BLq", tool_name: "read", input: "{}" }),
        durableEvent(14, "execution.cancelled"),
      ],
      TranscriptProjection.Projection.empty("turn-a", "prompt"),
    )
    const reattached = fold([transientReasoning(1, thoughts, 5), transientDelta(2, reply, 6)], streamed)

    expect(keysOf(streamed)).toEqual(keysOf(reattached))
    expect(keysOf(reattached)).toEqual([
      "turn:turn-a:user",
      "assistant:turn-a:%n0",
      "reasoning:turn-a:%n0",
      "tool:turn-a:call_t80",
      "tool:turn-a:call_BLq",
    ])
    expect(assistantText(reattached)).toBe(reply)
    expect(reasoningText(reattached)).toBe(thoughts)
  })

  it("ignores transient deltas from an earlier cycle after steering advanced the model phase", () => {
    const first = "I’ll create an isolated worktree and branch from the current remote main."
    const latest = "The isolated branch is now based on the fetched remote main."
    const streamed = fold(
      [
        durableEvent(2, "model.input.prepared"),
        durableEvent(5, "model.attempt.first_output"),
        transientDelta(1, first, 5),
        { ...durableEvent(8, "model.output.completed"), text: first },
        durableEvent(10, "tool.call.requested", { tool_call_id: "call_mAk", tool_name: "read", input: "{}" }),
        durableEvent(11, "tool.result.received", { tool_call_id: "call_mAk" }),
        durableEvent(15, "steering.delivered", { message_count: 1 }),
        durableEvent(16, "model.call.started"),
        durableEvent(26, "steering.delivered", { message_count: 1 }),
        durableEvent(29, "model.attempt.first_output"),
        { ...durableEvent(32, "model.output.completed"), text: latest },
        durableEvent(34, "tool.call.requested", { tool_call_id: "call_Alg", tool_name: "read", input: "{}" }),
        durableEvent(46, "execution.cancelled"),
      ],
      TranscriptProjection.Projection.empty("turn-b", "prompt"),
    )
    const reattached = TranscriptProjection.Projection.applyEvent(streamed, transientDelta(1, first, 5))

    expect(keysOf(streamed)).toEqual(keysOf(reattached))
    expect(reattached.units.filter((unit) => unit.key.startsWith("assistant:turn-b:"))).toHaveLength(2)
    expect(entryTexts(reattached).filter((text) => text === first)).toHaveLength(1)
  })

  it("applies a re-delivered transient batch once while the same attempt is still streaming", () => {
    const base = fold(
      [durableEvent(2, "model.input.prepared"), durableEvent(4, "model.attempt.started")],
      TranscriptProjection.Projection.empty("turn-c", "prompt"),
    )
    const batch = [transientDelta(1, "hel", 4), transientDelta(2, "lo", 4)]
    const retained = restoreProjectionFold(base)
    for (const event of batch) applyFoldEvent(retained, event)
    const streamed = snapshotFoldProjection(retained)
    for (const event of batch) applyFoldEvent(retained, event)
    const redelivered = snapshotFoldProjection(retained)

    expect(assistantText(streamed)).toBe("hello")
    expect(assistantText(redelivered)).toBe("hello")
    expect(keysOf(redelivered)).toEqual(keysOf(streamed))
    expect(redelivered.revision).toBe(streamed.revision)
    expect(redelivered.checkpointCursor).toBe(streamed.checkpointCursor)
  })

  it("streams a retried attempt whose transient index restarts below the previous attempt", () => {
    const base = fold(
      [durableEvent(2, "model.input.prepared"), durableEvent(4, "model.attempt.started")],
      TranscriptProjection.Projection.empty("turn-d", "prompt"),
    )
    const first = fold([transientDelta(7, "cut off", 4, "one")], base)
    const retried = fold(
      [durableEvent(5, "model.attempt.started"), transientDelta(1, "complete answer", 5, "two")],
      first,
    )

    expect(assistantText(retried)).toBe("cut offcomplete answer")
  })

  it("keeps the durable cycle completion when a late transient of that cycle arrives after it", () => {
    const streamed = fold(
      [
        durableEvent(2, "model.input.prepared"),
        durableEvent(5, "model.attempt.first_output"),
        transientDelta(1, "partial", 5),
        { ...durableEvent(8, "model.output.completed"), text: "the complete answer" },
      ],
      TranscriptProjection.Projection.empty("turn-e", "prompt"),
    )
    const late = fold([transientDelta(2, " and more", 5), transientDelta(3, " and more still", 6)], streamed)

    expect(assistantText(streamed)).toBe("the complete answer")
    expect(assistantText(late)).toBe("the complete answer")
    expect(keysOf(late)).toEqual(keysOf(streamed))
  })

  it("resolves parallel streamed tool calls across interleaved durable requests and results", () => {
    const retained = restoreProjectionFold(
      fold(
        [durableEvent(2, "model.input.prepared"), durableEvent(4, "model.attempt.started")],
        TranscriptProjection.Projection.empty("turn-parallel-tools", "prompt"),
      ),
    )
    for (const [index, id] of ["call-a", "call-b", "call-c"].entries())
      applyFoldEvent(retained, transientTool(index + 1, id, 4))

    expect(() => {
      applyFoldEvent(
        retained,
        durableEvent(5, "tool.call.requested", { tool_call_id: "call-a", tool_name: "read", input: {} }),
      )
      applyFoldEvent(retained, durableEvent(6, "tool.result.received", { tool_call_id: "call-a", output: "a" }))
      applyFoldEvent(
        retained,
        durableEvent(7, "tool.call.requested", { tool_call_id: "call-b", tool_name: "read", input: {} }),
      )
      applyFoldEvent(
        retained,
        durableEvent(8, "tool.call.requested", { tool_call_id: "call-c", tool_name: "read", input: {} }),
      )
      applyFoldEvent(retained, durableEvent(9, "tool.result.received", { tool_call_id: "call-b", output: "b" }))
      applyFoldEvent(retained, durableEvent(10, "tool.result.received", { tool_call_id: "call-c", output: "c" }))
      applyFoldEvent(retained, durableEvent(11, "execution.completed"))
    }).not.toThrow()

    expect(keysOf(snapshotFoldProjection(retained))).toEqual([
      "turn:turn-parallel-tools:user",
      "tool:turn-parallel-tools:call-a",
      "tool:turn-parallel-tools:call-b",
      "tool:turn-parallel-tools:call-c",
    ])
  })

  it("rejects a result for a streamed tool whose durable request never arrived", () => {
    const retained = restoreProjectionFold(
      fold(
        [durableEvent(2, "model.input.prepared"), durableEvent(4, "model.attempt.started")],
        TranscriptProjection.Projection.empty("turn-result-without-request", "prompt"),
      ),
    )
    applyFoldEvent(retained, transientTool(1, "missing", 4))
    const before = snapshotFoldProjection(retained)

    expect(() =>
      applyFoldEvent(retained, durableEvent(5, "tool.result.received", { tool_call_id: "missing", output: "result" })),
    ).toThrow("unresolved transient units tool:turn-result-without-request:missing")
    expect(snapshotFoldProjection(retained)).toEqual(before)
  })

  it("rejects unresolved assistant and reasoning content at request and result boundaries", () => {
    const transients = [
      {
        key: "assistant:turn-tool-boundary:%n0",
        event: transientDelta(1, "partial", 4),
      },
      {
        key: "reasoning:turn-tool-boundary:%n0",
        event: transientReasoning(1, "partial", 4),
      },
    ] as const
    const boundaries = [
      durableEvent(5, "tool.call.requested", { tool_call_id: "call", tool_name: "read", input: {} }),
      durableEvent(5, "tool.result.received", { tool_call_id: "call", output: "result" }),
    ]

    for (const transient of transients)
      for (const boundary of boundaries) {
        const retained = restoreProjectionFold(
          fold(
            [durableEvent(2, "model.input.prepared"), durableEvent(4, "model.attempt.started")],
            TranscriptProjection.Projection.empty("turn-tool-boundary", "prompt"),
          ),
        )
        applyFoldEvent(retained, transient.event)
        expect(() => applyFoldEvent(retained, boundary)).toThrow(`unresolved transient units ${transient.key}`)
      }
  })

  it("keeps the fold unchanged when another transient blocks a matching tool request", () => {
    const retained = restoreProjectionFold(
      fold(
        [durableEvent(2, "model.input.prepared"), durableEvent(4, "model.attempt.started")],
        TranscriptProjection.Projection.empty("turn-rejected-request", "prompt"),
      ),
    )
    applyFoldEvent(retained, transientDelta(1, "partial", 4))
    applyFoldEvent(retained, transientTool(2, "call", 4))
    const before = snapshotFoldProjection(retained)

    expect(() =>
      applyFoldEvent(
        retained,
        durableEvent(5, "tool.call.requested", { tool_call_id: "call", tool_name: "read", input: {} }),
      ),
    ).toThrow("unresolved transient units assistant:turn-rejected-request:%n0")
    expect(snapshotFoldProjection(retained)).toEqual(before)
  })

  it("rejects a missing sibling tool at the next model and terminal boundaries", () => {
    const orphanedSibling = () => {
      const retained = restoreProjectionFold(
        fold(
          [durableEvent(2, "model.input.prepared"), durableEvent(4, "model.attempt.started")],
          TranscriptProjection.Projection.empty("turn-missing-sibling", "prompt"),
        ),
      )
      applyFoldEvent(retained, transientTool(1, "requested", 4))
      applyFoldEvent(retained, transientTool(2, "missing", 4))
      applyFoldEvent(
        retained,
        durableEvent(5, "tool.call.requested", { tool_call_id: "requested", tool_name: "read", input: {} }),
      )
      applyFoldEvent(retained, durableEvent(6, "tool.result.received", { tool_call_id: "requested", output: "result" }))
      return retained
    }

    for (const boundary of [durableEvent(7, "model.input.prepared"), durableEvent(7, "execution.completed")])
      expect(() => applyFoldEvent(orphanedSibling(), boundary)).toThrow(
        "unresolved transient units tool:turn-missing-sibling:missing",
      )
  })

  it("rejects a terminal boundary when a streamed tool call never becomes durable", () => {
    const retained = restoreProjectionFold(
      fold(
        [durableEvent(2, "model.input.prepared"), durableEvent(4, "model.attempt.started")],
        TranscriptProjection.Projection.empty("turn-missing-tool", "prompt"),
      ),
    )
    applyFoldEvent(retained, transientTool(1, "missing", 4))

    expect(() => applyFoldEvent(retained, durableEvent(5, "execution.completed"))).toThrow(
      "unresolved transient units tool:turn-missing-tool:missing",
    )
  })

  it("rejects a terminal boundary with unresolved transient content", () => {
    const retained = restoreProjectionFold(
      fold(
        [durableEvent(2, "model.input.prepared"), durableEvent(4, "model.attempt.started")],
        TranscriptProjection.Projection.empty("turn-f", "prompt"),
      ),
    )
    applyFoldEvent(retained, transientDelta(1, "partial", 4))

    expect(() => applyFoldEvent(retained, durableEvent(5, "execution.completed"))).toThrow(
      "unresolved transient units assistant:turn-f:%n0",
    )
  })

  it("replaces streamed text with a durable cycle completion sharing the head sequence", () => {
    const base = TranscriptProjection.Projection.project("turn-a", "prompt", [
      { cursor: "started", sequence: 1, type: "execution.started", createdAt: 1 },
      { cursor: "prepared", sequence: 2, type: "model.input.prepared", createdAt: 2 },
    ])
    const streamed = TranscriptProjection.Projection.applyEvent(
      TranscriptProjection.Projection.applyEvent(base, transientDelta(1, "hel", 2)),
      transientDelta(2, "lo", 2),
    )
    expect(assistantText(streamed)).toBe("hello")
    expect(streamed.revision).toBe(2)
    const completed = TranscriptProjection.Projection.applyEvent(streamed, {
      cursor: "cycle-3",
      sequence: 3,
      type: "model.cycle.completed",
      createdAt: 6,
      text: "hello world",
    })

    expect(assistantText(completed)).toBe("hello world")
    expect(completed.revision).toBe(3)
    expect(completed.checkpointCursor).toBe("cycle-3")
  })
})
