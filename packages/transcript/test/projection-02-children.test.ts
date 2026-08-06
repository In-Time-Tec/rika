import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import type { SourceEvent } from "../src/schema/transcript-source-event"

describe("Transcript projection", () => {
  it("merges a correlated spawn and authoritative child outcome into one named tool unit", () => {
    const childId = "execution:turn-a:child:oracle"
    const fold = TranscriptProjection.Fold.makeProjectionFold("turn-a", "delegate")
    for (const event of [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: "agent",
          tool_name: "transfer_to_oracle",
          input: { prompt: "Find the projection defect" },
        },
      },
      {
        cursor: "spawned",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { invocation_id: "agent", child_execution_id: childId },
      },
    ] satisfies ReadonlyArray<SourceEvent>)
      TranscriptProjection.Fold.applyFoldEvent(fold, event)
    TranscriptProjection.Fold.applyChildOutcome(fold, childId, { status: "complete" })
    const projection = TranscriptProjection.Fold.snapshotFoldProjection(fold)

    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:agent",
      revision: 2,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          childId,
          status: "complete",
          detail: "Find the projection defect",
          presentation: { activeLabel: "Oracle exploring", completeLabel: "Oracle has spoken" },
        },
      },
    })
  })

  it("labels a spawn call Subagent working before any child metadata arrives", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "agent", tool_name: "transfer_to_task", input: { prompt: "Inspect the projection" } },
      },
    ])
    const block =
      projection.units[1]?.content._tag === "Block" && projection.units[1].content.block._tag === "ToolCall"
        ? projection.units[1].content.block
        : undefined
    expect(block?.presentation).toMatchObject({
      family: "agent",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    })
    expect(block?.presentation.activeLabel).not.toContain("(task)")
  })

  it("replays a child outcome over an earlier subagent tool error", () => {
    const events: ReadonlyArray<SourceEvent> = [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: "agent",
          tool_name: "spawn_child_run",
          input: { profile: "task", prompt: "Inspect the projection" },
        },
      },
      {
        cursor: "result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "agent", error: "AgentToolError: Model gpt-5.6-luna is not available" },
      },
      {
        cursor: "spawned",
        sequence: 3,
        type: "child_run.spawned",
        createdAt: 3,
        data: { invocation_id: "agent", child_execution_id: "child:agent" },
      },
    ]
    const live = TranscriptProjection.Fold.makeProjectionFold("turn-a", "delegate")
    for (const event of events) TranscriptProjection.Fold.applyFoldEvent(live, event)
    const replayed = TranscriptProjection.Fold.restoreProjectionFold(
      TranscriptProjection.Fold.snapshotFoldProjection(live),
    )
    for (const fold of [live, replayed]) {
      TranscriptProjection.Fold.applyChildOutcome(fold, "child:agent", { status: "complete" })
      const projection = TranscriptProjection.Fold.snapshotFoldProjection(fold)
      expect(projection.units[1]).toMatchObject({
        key: "tool:turn-a:agent",
        content: {
          _tag: "Block",
          block: {
            _tag: "ToolCall",
            status: "complete",
            detail: "Inspect the projection",
          },
        },
      })
    }
  })

  it("treats a completed final assistant response as the child outcome despite a later execution failure", () => {
    const events: ReadonlyArray<SourceEvent> = [
      {
        cursor: "tool",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "read", tool_name: "read" },
      },
      {
        cursor: "tool-error",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "read", error: "file missing" },
      },
      { cursor: "answer", sequence: 3, type: "model.output.completed", createdAt: 3, text: "Usable final response" },
      { cursor: "failed", sequence: 4, type: "execution.failed", createdAt: 4, text: "internal tool failed" },
    ]

    for (const projection of [
      TranscriptProjection.Projection.project("child", "delegate", events),
      events.reduce(
        (current, event) => TranscriptProjection.Projection.applyEvent(current, event),
        TranscriptProjection.Projection.empty("child", "delegate"),
      ),
    ]) {
      expect(projection.units.find((unit) => unit.executionOutcome !== undefined)?.executionOutcome).toEqual({
        status: "complete",
      })
      expect(projection.units).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.objectContaining({ block: expect.objectContaining({ _tag: "Error" }) }),
          }),
        ]),
      )
      expect(projection.units).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.objectContaining({
              block: expect.objectContaining({ _tag: "ToolCall", status: "failed" }),
            }),
          }),
        ]),
      )
    }
  })

  it.each([
    [
      "partial output without completion",
      [{ cursor: "partial", sequence: 3, type: "model.output.delta", createdAt: 3, text: "Partial response" }],
    ],
    [
      "an empty completion after partial output",
      [
        { cursor: "partial", sequence: 3, type: "model.output.delta", createdAt: 3, text: "Partial response" },
        {
          cursor: "empty",
          sequence: 4,
          type: "model.output.completed",
          createdAt: 4,
          text: "",
        },
      ],
    ],
    [
      "a completed response before later tool activity",
      [
        { cursor: "answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "Stale response" },
        {
          cursor: "tool",
          sequence: 2,
          type: "tool.call.requested",
          createdAt: 2,
          data: { tool_call_id: "read", tool_name: "read" },
        },
        {
          cursor: "tool-error",
          sequence: 3,
          type: "tool.result.received",
          createdAt: 3,
          data: { tool_call_id: "read", error: "file missing" },
        },
      ],
    ],
  ] as const)("keeps execution failure after %s", (_name, precedingEvents) => {
    const events: ReadonlyArray<SourceEvent> = [
      ...precedingEvents,
      { cursor: "failed", sequence: 5, type: "execution.failed", createdAt: 5, text: "internal tool failed" },
    ]

    for (const projection of [
      TranscriptProjection.Projection.project("child", "delegate", events),
      events.reduce(
        (current, event) => TranscriptProjection.Projection.applyEvent(current, event),
        TranscriptProjection.Projection.empty("child", "delegate"),
      ),
    ]) {
      expect(projection.units.find((unit) => unit.executionOutcome !== undefined)?.executionOutcome).toEqual({
        status: "failed",
        reason: "internal tool failed",
      })
    }
  })

  it("settles a linked child tool through the child_run lifecycle family", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "work" } },
      },
      {
        cursor: "spawned",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { invocation_id: "agent", child_execution_id: "child-1" },
      },
      {
        cursor: "started",
        sequence: 3,
        type: "child_run.started",
        createdAt: 3,
        data: { invocation_id: "agent", child_execution_id: "child-1", profile: "task" },
      },
      {
        cursor: "failed",
        sequence: 4,
        type: "child_run.failed",
        createdAt: 4,
        data: { invocation_id: "agent", child_execution_id: "child-1", error: "child failed" },
      },
      {
        cursor: "completed",
        sequence: 5,
        type: "child_run.completed",
        createdAt: 5,
        data: { invocation_id: "agent", child_execution_id: "child-1", profile: "task" },
      },
    ])

    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:agent",
      content: { _tag: "Block", block: { _tag: "ToolCall", childId: "child-1", status: "complete" } },
    })
    expect(
      projection.units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "ChildAgent"),
    ).toHaveLength(0)
  })

  it("restores a durable child completion over an earlier subagent tool error", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "work" } },
      },
      {
        cursor: "spawned",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { invocation_id: "agent", child_execution_id: "child-1" },
      },
      {
        cursor: "tool-error",
        sequence: 3,
        type: "tool.result.received",
        createdAt: 3,
        data: { tool_call_id: "agent", error: "AgentToolError: Model gpt-5.6-luna is not available" },
      },
      {
        cursor: "child-completed",
        sequence: 4,
        type: "child_run.completed",
        createdAt: 4,
        data: { invocation_id: "agent", child_execution_id: "child-1", profile: "task" },
      },
    ])

    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:agent",
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "complete" } },
    })
  })

  it("projects a terminal child placeholder from a replayed lifecycle batch", () => {
    const projection = TranscriptProjection.Projection.project("child", "", [
      {
        cursor: "done",
        sequence: 0,
        type: "child_run.completed",
        createdAt: 0,
        data: { invocation_id: "gc", child_execution_id: "grandchild", profile: "task" },
      },
    ])

    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: "child:child:grandchild",
      content: {
        _tag: "Block",
        block: { _tag: "ChildAgent", id: "grandchild", name: "task", status: "complete" },
      },
    })
  })

  it("correlates a spawned child through tool_call_id when invocation_id is absent", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "work" } },
      },
      {
        cursor: "spawned",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { tool_call_id: "agent", child_execution_id: "child-1" },
      },
    ])

    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:agent",
      content: { _tag: "Block", block: { _tag: "ToolCall", childId: "child-1", status: "running" } },
    })
    expect(
      projection.units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "ChildAgent"),
    ).toHaveLength(0)
  })

  it("cancels a linked child tool from its child_run lifecycle event", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "work" } },
      },
      {
        cursor: "spawned",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { invocation_id: "agent", child_execution_id: "child-1" },
      },
      {
        cursor: "cancelled",
        sequence: 3,
        type: "child_run.cancelled",
        createdAt: 3,
        data: { invocation_id: "agent", child_execution_id: "child-1" },
      },
    ])

    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:agent",
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "cancelled" } },
    })
  })
})
