import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import { withNestedProjections } from "../src/projection/nested-transcript-projection"
import { childOrder, unitOrder } from "../src/ordering/transcript-unit-order"
import type { SourceEvent } from "../src/schema/transcript-source-event"

describe("Transcript projection", () => {
  it("projects canonical semantic blocks with stable keys across lifecycle revisions", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      { cursor: "reason", sequence: 0, type: "model.reasoning.delta", createdAt: 0, text: "thinking" },
      {
        cursor: "tool",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "read", tool_name: "read", input: { path: "a.ts" } },
      },
      {
        cursor: "result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "orphan", output: "orphan result" },
      },
      {
        cursor: "usage",
        sequence: 5,
        type: "model.attempt.completed",
        createdAt: 5,
        data: { input_tokens: 10, output_tokens: 20, model: "test" },
      },
      {
        cursor: "compaction-1",
        sequence: 6,
        type: "agent.compaction.completed",
        createdAt: 6,
        text: "Earlier work",
        data: { checkpoint: "checkpoint-1" },
      },
      {
        cursor: "compaction-2",
        sequence: 7,
        type: "agent.compaction.completed",
        createdAt: 7,
        text: "Updated work",
        data: { checkpoint: "checkpoint-2" },
      },
      {
        cursor: "notice",
        sequence: 8,
        type: "model.retry.scheduled",
        createdAt: 8,
        data: { category: "rate_limit", delay_millis: 100 },
      },
      {
        cursor: "child-1",
        sequence: 11,
        type: "child_run.spawned",
        createdAt: 11,
        data: { child_execution_id: "child", invocation_id: "missing-call" },
      },
      { cursor: "error", sequence: 16, type: "program.operation.failed", createdAt: 16, text: "Budget exhausted" },
    ])

    expect(
      projection.units.flatMap((item) => (item.content._tag === "Block" ? [item.content.block._tag] : [])),
    ).toEqual(["Reasoning", "ToolCall", "ToolResult", "Compaction", "Notification", "ChildAgent", "Error"])
    expect(projection.units.find((item) => item.key === "compaction:turn-a")).toMatchObject({ revision: 7 })
    expect(projection.revision).toBe(16)
    expect(projection.oldestCursor).toBe("reason")
    expect(projection.checkpointCursor).toBe("error")
  })

  it("checkpoints every observable Baton event shape without replay duplication", () => {
    const events: ReadonlyArray<SourceEvent> = [
      { cursor: "accepted", sequence: 0, type: "execution.accepted", createdAt: 0 },
      { cursor: "started", sequence: 1, type: "execution.started", createdAt: 1 },
      { cursor: "input", sequence: 2, type: "model.input.prepared", createdAt: 2 },
      { cursor: "output", sequence: 3, type: "model.output.completed", createdAt: 3, text: "answer" },
      {
        cursor: "usage",
        sequence: 4,
        type: "model.attempt.completed",
        createdAt: 4,
        data: {
          provider: "openai",
          model: "gpt-5.6-sol",
          input_tokens: 50_000,
          input_tokens_uncached: 50_000,
          input_tokens_cache_read: 0,
          input_tokens_cache_write: 0,
          output_tokens: 0,
        },
      },
      {
        cursor: "call",
        sequence: 5,
        type: "tool.call.requested",
        createdAt: 5,
        data: { tool_call_id: "call", tool_name: "read", input: { path: "a.ts" } },
      },
      {
        cursor: "result",
        sequence: 6,
        type: "tool.result.received",
        createdAt: 6,
        data: { tool_call_id: "call", output: "ok" },
      },
      { cursor: "wait-created", sequence: 11, type: "wait.created", createdAt: 11, data: { wait_id: "wait" } },
      { cursor: "wait-woken", sequence: 12, type: "wait.woken", createdAt: 12, data: { wait_id: "wait" } },
      { cursor: "wait-timeout", sequence: 13, type: "wait.timed_out", createdAt: 13, data: { wait_id: "wait" } },
      { cursor: "wait-cancel", sequence: 14, type: "wait.cancelled", createdAt: 14, data: { wait_id: "wait" } },
      {
        cursor: "child",
        sequence: 15,
        type: "child_run.spawned",
        createdAt: 15,
        data: { child_execution_id: "child", invocation_id: "missing-call" },
      },
      { cursor: "budget", sequence: 19, type: "program.operation.failed", createdAt: 19, text: "budget" },
      { cursor: "completed", sequence: 20, type: "execution.completed", createdAt: 20 },
      { cursor: "failed", sequence: 21, type: "execution.failed", createdAt: 21, text: "failed" },
      { cursor: "cancelled", sequence: 22, type: "execution.cancelled", createdAt: 22 },
    ]
    let projection = TranscriptProjection.Projection.empty("turn-a", "prompt")
    for (const event of events) {
      projection = TranscriptProjection.Projection.applyEvent(projection, event)
      expect(projection.revision).toBe(event.sequence)
      expect(projection.checkpointCursor).toBe(event.cursor)
      expect(TranscriptProjection.Projection.applyEvent(projection, event)).toEqual(projection)
    }

    expect(
      projection.units.filter((item) => item.content._tag === "Block" && item.content.block._tag === "Error"),
    ).toHaveLength(2)
  })

  it("keeps nested keys, revisions, parents, and deterministic source order without mutating inputs", () => {
    const root = TranscriptProjection.Projection.project("root", "prompt", [
      {
        cursor: "tool",
        sequence: 2,
        type: "tool.call.requested",
        createdAt: 2,
        data: { tool_call_id: "child", tool_name: "task", input: { prompt: "work" } },
      },
    ])
    const child = TranscriptProjection.Projection.project("child", "", [
      { cursor: "answer", sequence: 7, type: "model.output.completed", createdAt: 7, text: "done" },
    ])
    const rootBefore = structuredClone(root)
    const childBefore = structuredClone(child)
    const first = withNestedProjections(root, [{ parentId: "root:child", projection: child }])
    const second = withNestedProjections(root, [{ parentId: "root:child", projection: child }])

    expect(first).toEqual(second)
    expect(root).toEqual(rootBefore)
    expect(child).toEqual(childBefore)
    expect(TranscriptProjection.Projection.finalAssistantOutput(first, "root")).toBeUndefined()
    expect(first.units.map(({ key, revision, parentId, order }) => ({ key, revision, parentId, order }))).toEqual([
      {
        key: "turn:root:user",
        revision: 0,
        parentId: undefined,
        order: unitOrder("turn:root:user", -1),
      },
      {
        key: "tool:root:child",
        revision: 2,
        parentId: undefined,
        order: unitOrder("tool:root:child", 2),
      },
      {
        key: "turn:child:user",
        revision: 0,
        parentId: "root:child",
        order: childOrder(unitOrder("tool:root:child", 2), "child", unitOrder("turn:child:user", -1)),
      },
      {
        key: "assistant:child:%n0",
        revision: 7,
        parentId: "root:child",
        order: childOrder(unitOrder("tool:root:child", 2), "child", unitOrder("assistant:child:%n0", 7)),
      },
    ])
  })

  it("keeps a recovered root completion on the root execution instead of its failed nested child", () => {
    const root = TranscriptProjection.Projection.project("root", "delegate", [
      {
        cursor: "agent",
        sequence: 0,
        type: "tool.call.requested",
        createdAt: 0,
        data: { tool_call_id: "agent", tool_name: "task", input: {} },
      },
    ])
    const failedChild = TranscriptProjection.Projection.project("child", "", [
      { cursor: "failed", sequence: 0, type: "execution.failed", createdAt: 1, text: "child failed" },
    ])
    const flattened = withNestedProjections(root, [{ parentId: "root:agent", projection: failedChild }])
    const completed = TranscriptProjection.Projection.applyEvent(flattened, {
      cursor: "root-done",
      sequence: 1,
      type: "execution.completed",
      createdAt: 2,
    })
    const reloaded = withNestedProjections(completed, [{ parentId: "root:agent", projection: failedChild }])

    expect(reloaded.units.find((unit) => unit.key === "turn:root:user")?.executionOutcome).toEqual({
      status: "complete",
    })
    expect(
      reloaded.units.find((unit) => unit.turnId === "child" && unit.executionOutcome !== undefined)?.executionOutcome,
    ).toEqual({
      status: "failed",
      reason: "child failed",
    })
  })

  it("persists a hidden execution outcome when an execution has no root user unit", () => {
    const root = TranscriptProjection.Projection.project("root", "prompt", [
      { cursor: "answer", sequence: 0, type: "model.output.completed", createdAt: 1, text: "answer" },
    ])
    const projection = TranscriptProjection.Projection.applyEvent(
      { ...root, units: root.units.filter((unit) => unit.content._tag !== "Entry" || unit.content.role !== "user") },
      { cursor: "done", sequence: 1, type: "execution.completed", createdAt: 2 },
    )

    expect(projection.units).toContainEqual(
      expect.objectContaining({
        key: "execution:root:outcome",
        revision: 1,
        executionOutcome: { status: "complete" },
      }),
    )
  })
})
