import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import type { SourceEvent } from "../src/schema/transcript-source-event"

describe("Transcript projection", () => {
  it("projects a delivered steering message as a user entry in event order", () => {
    const projection = TranscriptProjection.Projection.project("turn", "prompt", [
      { cursor: "output-0", sequence: 0, type: "model.output.completed", createdAt: 0, text: "Working." },
      {
        cursor: "tool-1",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "call", tool_name: "bash", input: { command: "ls" } },
      },
      { cursor: "tool-2", sequence: 2, type: "tool.result.received", createdAt: 2, data: { tool_call_id: "call" } },
      {
        cursor: "steer-3",
        sequence: 3,
        type: "steering.delivered",
        createdAt: 3,
        text: "Focus on the fixture text.",
        data: {
          kind: "steering",
          drain_id: "drain:turn:steering:steering:sequence:3",
          message_sequences: [0],
          message_count: 1,
        },
      },
      { cursor: "output-4", sequence: 4, type: "model.output.completed", createdAt: 4, text: "Refocused." },
    ])
    const steering = projection.units.find((candidate) => candidate.key === "steering:turn:%n3:%n0")
    expect(steering?.content).toEqual({ _tag: "Entry", role: "user", text: "Focus on the fixture text." })
    const keys = projection.units.map((candidate) => candidate.key)
    expect(keys.indexOf("steering:turn:%n3:%n0")).toBeGreaterThan(keys.indexOf("tool:turn:call"))
  })

  it("ignores an empty steering drain event", () => {
    const projection = TranscriptProjection.Projection.project("turn", "prompt", [
      {
        cursor: "steer-0",
        sequence: 0,
        type: "steering.delivered",
        createdAt: 0,
        data: {
          kind: "steering",
          drain_id: "drain:turn:steering:steering:sequence:0",
          message_sequences: [],
          message_count: 0,
        },
      },
    ])
    expect(projection.units.some((candidate) => candidate.key.startsWith("steering:"))).toBe(false)
  })

  it("projects each delivered steering message as its own user entry", () => {
    const projection = TranscriptProjection.Projection.project("turn", "prompt", [
      {
        cursor: "steer-2",
        sequence: 2,
        type: "steering.delivered",
        createdAt: 2,
        text: "First correction.Second correction.",
        content: [
          { type: "text", text: "First correction." },
          { type: "text", text: "Second correction." },
        ],
        data: {
          kind: "steering",
          drain_id: "drain:turn:steering:steering:sequence:2",
          message_sequences: [0, 1],
          message_count: 2,
        },
      },
    ])
    const steering = projection.units.filter((candidate) => candidate.key.startsWith("steering:turn:%n2"))
    expect(steering.map((candidate) => candidate.content)).toEqual([
      { _tag: "Entry", role: "user", text: "First correction." },
      { _tag: "Entry", role: "user", text: "Second correction." },
    ])
  })

  it("replays a delivered steering event into one stable unit", () => {
    const delivered: SourceEvent = {
      cursor: "steer-1",
      sequence: 1,
      type: "steering.delivered",
      createdAt: 1,
      text: "Check the failure path.",
      data: {
        kind: "steering",
        drain_id: "drain:turn:steering:steering:sequence:1",
        message_sequences: [0],
        message_count: 1,
      },
    }
    const first = TranscriptProjection.Projection.applyEvent(
      TranscriptProjection.Projection.empty("turn", "prompt"),
      delivered,
    )
    const replayed = TranscriptProjection.Projection.applyEvent(first, delivered)
    expect(replayed.units.filter((candidate) => candidate.key === "steering:turn:%n1:%n0")).toHaveLength(1)
  })
})
