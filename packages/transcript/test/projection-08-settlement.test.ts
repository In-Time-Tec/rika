import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import { settleChild, settleRunning } from "../src/projection/transcript-settlement"
import type { SourceEvent } from "../src/schema/transcript-source-event"

describe("Transcript projection", () => {
  it("settles running tool and child blocks at every execution terminal boundary", () => {
    const base: ReadonlyArray<SourceEvent> = [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "call", tool_name: "task", input: { prompt: "work" } },
      },
      {
        cursor: "spawn",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { child_execution_id: "orphan-child", preset_name: "task" },
      },
    ]
    const cancelled = TranscriptProjection.Projection.project("turn-a", "prompt", [
      ...base,
      { cursor: "cancelled", sequence: 3, type: "execution.cancelled", createdAt: 3 },
    ])
    const failed = TranscriptProjection.Projection.project("turn-a", "prompt", [
      ...base,
      { cursor: "failed", sequence: 3, type: "execution.failed", createdAt: 3, data: { message: "boom" } },
    ])
    const completed = TranscriptProjection.Projection.project("turn-a", "prompt", [
      ...base,
      { cursor: "completed", sequence: 3, type: "execution.completed", createdAt: 3 },
    ])

    expect(cancelled.units.find((item) => item.key === "tool:turn-a:call")).toMatchObject({
      revision: 3,
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "cancelled" } },
    })
    expect(cancelled.units.find((item) => item.key === "child:turn-a:orphan-child")).toMatchObject({
      revision: 3,
      content: { _tag: "Block", block: { _tag: "ChildAgent", status: "cancelled" } },
    })
    expect(failed.units.find((item) => item.key === "tool:turn-a:call")).toMatchObject({
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "failed" } },
    })
    expect(failed.units.find((item) => item.key === "child:turn-a:orphan-child")).toMatchObject({
      content: { _tag: "Block", block: { _tag: "ChildAgent", status: "failed" } },
    })
    expect(completed.units.find((item) => item.key === "tool:turn-a:call")).toMatchObject({
      revision: 3,
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "cancelled" } },
    })
    expect(completed.units.find((item) => item.key === "child:turn-a:orphan-child")).toMatchObject({
      revision: 3,
      content: { _tag: "Block", block: { _tag: "ChildAgent", status: "cancelled" } },
    })
    expect(TranscriptProjection.Projection.hasRunningBlocks(completed)).toBe(false)
  })

  it("hides model failure telemetry and explains terminal compaction failure", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      { cursor: "attempt", sequence: 1, type: "model.attempt.failed", createdAt: 1 },
      { cursor: "call", sequence: 2, type: "model.call.failed", createdAt: 2 },
      {
        cursor: "failed",
        sequence: 3,
        type: "execution.failed",
        createdAt: 3,
        text: "Automatic compaction could not reduce the thread enough for this model.",
        data: { details: { failure_classification: "context-overflow" } },
      },
    ])

    const errors = projection.units.filter(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error",
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]?.content).toMatchObject({
      _tag: "Block",
      block: {
        _tag: "Error",
        title: "Auto-compaction failed",
        detail: "Automatic compaction could not reduce the thread enough for this model.",
        recovery: "Try again. If the thread is still too large, start a new thread.",
      },
    })
    expect(JSON.stringify(projection.units)).not.toContain("model.attempt.failed")
    expect(JSON.stringify(projection.units)).not.toContain("model.call.failed")
  })

  it("settles linked tools and standalone child agents through the settlement helpers", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "call", tool_name: "task", input: { prompt: "work" } },
      },
      {
        cursor: "spawn",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { tool_call_id: "call", child_execution_id: "child-1", preset_name: "task" },
      },
      {
        cursor: "orphan",
        sequence: 3,
        type: "child_run.spawned",
        createdAt: 3,
        data: { child_execution_id: "orphan-child", preset_name: "task" },
      },
    ])
    const settledLinked = settleChild(projection, "child-1", "complete", 99)
    const settledOrphan = settleChild(settledLinked, "orphan-child", "cancelled", 99)
    const swept = settleRunning(projection, "cancelled", 50)

    expect(settledLinked.units.find((item) => item.key === "tool:turn-a:call")).toMatchObject({
      revision: 99,
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "complete", childId: "child-1" } },
    })
    expect(settledOrphan.units.find((item) => item.key === "child:turn-a:orphan-child")).toMatchObject({
      revision: 99,
      content: { _tag: "Block", block: { _tag: "ChildAgent", status: "cancelled" } },
    })
    expect(TranscriptProjection.Projection.hasRunningBlocks(projection)).toBe(true)
    expect(TranscriptProjection.Projection.hasRunningBlocks(settledOrphan)).toBe(false)
    expect(TranscriptProjection.Projection.hasRunningBlocks(swept)).toBe(false)
    expect(settleChild(settledOrphan, "child-1", "failed", 120)).toEqual(settledOrphan)
  })
})
