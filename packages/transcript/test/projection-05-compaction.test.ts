import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import { settleRunning } from "../src/projection/transcript-settlement"
import type { SourceEvent } from "../src/schema/transcript-source-event"

describe("Transcript projection", () => {
  it("preserves hidden web output with its presentation metadata", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      {
        cursor: "web-call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: "web-1",
          tool_name: "web_search",
          input: { objective: "Find current documentation" },
        },
      },
      {
        cursor: "web-result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "web-1", output: "SEARCH RESULT BODY" },
      },
    ])
    const block = projection.units.find((unit) => unit.key === "tool:turn-a:web-1")?.content

    expect(block).toMatchObject({
      _tag: "Block",
      block: {
        _tag: "ToolCall",
        output: "SEARCH RESULT BODY",
        presentation: { outputDisplay: "hidden" },
      },
    })
  })

  it("applies duplicate and older source events idempotently", () => {
    const event: SourceEvent = {
      cursor: "cursor-1",
      sequence: 1,
      type: "model.output.delta",
      createdAt: 1,
      text: "answer",
    }
    const once = TranscriptProjection.Projection.applyEvent(
      TranscriptProjection.Projection.empty("turn-a", "prompt"),
      event,
    )
    expect(TranscriptProjection.Projection.applyEvent(once, event)).toEqual(once)
    expect(
      TranscriptProjection.Projection.applyEvent(once, { ...event, cursor: "cursor-0", sequence: 0, text: "stale" }),
    ).toEqual(once)
  })

  it("revises one compaction unit from a running start signal to the committed checkpoint", () => {
    const started = TranscriptProjection.Projection.project("turn-a", "prompt", [
      {
        cursor: "compaction-started",
        sequence: 0,
        type: "agent.compaction.started",
        createdAt: 0,
        data: { turn: 3, overflow: true },
      },
    ])
    const startedUnit = started.units.find((item) => item.key === "compaction:turn-a")
    expect(startedUnit).toMatchObject({ content: { _tag: "Block", block: { _tag: "Compaction", status: "running" } } })

    const committed = TranscriptProjection.Projection.project("turn-a", "prompt", [
      {
        cursor: "compaction-started",
        sequence: 0,
        type: "agent.compaction.started",
        createdAt: 0,
        data: { turn: 3, overflow: true },
      },
      {
        cursor: "compaction-committed",
        sequence: 1,
        type: "agent.compaction.completed",
        createdAt: 1,
        text: "Earlier work",
        data: { checkpoint: "entry:checkpoint" },
      },
    ])
    const committedUnit = committed.units.find((item) => item.key === "compaction:turn-a")
    expect(committedUnit).toMatchObject({
      revision: 1,
      content: { _tag: "Block", block: { _tag: "Compaction", status: "complete", checkpoint: "entry:checkpoint" } },
    })
    expect(committed.units.filter((item) => item.key.startsWith("compaction:"))).toHaveLength(1)
  })

  it("does not project a failed compaction event as complete", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      {
        cursor: "compaction-started",
        sequence: 0,
        type: "agent.compaction.started",
        createdAt: 0,
      },
      {
        cursor: "compaction-failed",
        sequence: 1,
        type: "agent.compaction.failed",
        createdAt: 1,
        text: "compaction failed",
      },
    ])
    expect(projection.units.find((item) => item.key === "compaction:turn-a")).toMatchObject({
      content: { _tag: "Block", block: { _tag: "Compaction", status: "failed" } },
    })
  })

  it.each(["microcompact", "unchanged"] as const)(
    "revises a running compaction to complete on %s completed without committed",
    (kind) => {
      const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
        {
          cursor: "compaction-started",
          sequence: 0,
          type: "agent.compaction.started",
          createdAt: 0,
          data: { turn: 3, compaction_id: "c1", trigger: "threshold", started_at: 0 },
        },
        {
          cursor: "compaction-completed",
          sequence: 1,
          type: "agent.compaction.completed",
          createdAt: 1,
          data: { turn: 3, compaction_id: "c1", kind, completed_at: 1 },
        },
      ])
      expect(projection.units.find((item) => item.key === "compaction:turn-a")).toMatchObject({
        revision: 1,
        content: { _tag: "Block", block: { _tag: "Compaction", status: "complete" } },
      })
      expect(projection.units.filter((item) => item.key.startsWith("compaction:"))).toHaveLength(1)
    },
  )

  it("attaches the checkpoint from the applied compaction event", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      {
        cursor: "compaction-started",
        sequence: 0,
        type: "agent.compaction.started",
        createdAt: 0,
        data: { turn: 3, compaction_id: "c1", trigger: "overflow", started_at: 0 },
      },
      {
        cursor: "compaction-completed",
        sequence: 1,
        type: "agent.compaction.completed",
        createdAt: 1,
        data: { turn: 3, compaction_id: "c1", kind: "summarize", completed_at: 1 },
      },
      {
        cursor: "compaction-committed",
        sequence: 2,
        type: "agent.compaction.completed",
        createdAt: 2,
        data: { checkpoint: "entry:checkpoint", compaction_id: "c1", kind: "summarize" },
      },
    ])
    expect(projection.units.find((item) => item.key === "compaction:turn-a")).toMatchObject({
      revision: 2,
      content: {
        _tag: "Block",
        block: { _tag: "Compaction", status: "complete", checkpoint: "entry:checkpoint" },
      },
    })
    expect(projection.units.filter((item) => item.key.startsWith("compaction:"))).toHaveLength(1)
  })

  it("settles a running compaction when the turn is cancelled", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      {
        cursor: "compaction-started",
        sequence: 0,
        type: "agent.compaction.started",
        createdAt: 0,
      },
    ])
    const swept = settleRunning(projection, "cancelled", 50)
    expect(swept.units.find((item) => item.key === "compaction:turn-a")).toMatchObject({
      content: { _tag: "Block", block: { _tag: "Compaction", status: "cancelled" } },
    })
  })
})
