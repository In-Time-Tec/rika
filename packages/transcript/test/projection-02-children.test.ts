import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import type { SourceEvent } from "../src/schema/transcript-source-event"

describe("Transcript projection", () => {
  it("uses child payload status and keeps one stable child row", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
      {
        cursor: "1",
        sequence: 1,
        type: "child_run.spawned",
        createdAt: 1,
        data: { child_execution_id: "child-1", preset_name: "Oracle" },
      },
      {
        cursor: "2",
        sequence: 2,
        type: "child_run.event",
        createdAt: 2,
        data: { child_execution_id: "child-1", preset_name: "Oracle", status: "failed", error: "no result" },
      },
    ])
    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: "child:turn-a:child-1",
      content: { _tag: "Block", block: { _tag: "ChildAgent", id: "child-1", status: "failed" } },
    })
  })

  it("merges a correlated spawn and child lifecycle into one named tool unit", () => {
    const childId = "execution:turn-a:child:oracle"
    const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: "agent",
          tool_name: "spawn_child_run",
          input: { profile: "oracle", prompt: "Find the projection defect" },
        },
      },
      {
        cursor: "spawned",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { tool_call_id: "agent", child_execution_id: childId },
      },
      {
        cursor: "started",
        sequence: 3,
        type: "child_run.started",
        createdAt: 3,
        data: { child_execution_id: childId, profile: "oracle" },
      },
      {
        cursor: "completed",
        sequence: 4,
        type: "child_run.completed",
        createdAt: 4,
        data: { child_execution_id: childId, profile: "oracle" },
      },
    ])

    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:agent",
      revision: 4,
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

  it("uses a later durable child completion instead of an earlier subagent tool error", () => {
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
        cursor: "completed",
        sequence: 3,
        type: "child_run.completed",
        createdAt: 3,
        data: {
          tool_call_id: "agent",
          child_execution_id: "child:agent",
          profile: "task",
          summary: "The child recovered and returned an answer.",
        },
      },
    ]
    const live = TranscriptProjection.Projection.project("turn-a", "delegate", events)
    const replayed = events.reduce(
      (current, event) => TranscriptProjection.Projection.applyEvent(current, event),
      TranscriptProjection.Projection.empty("turn-a", "delegate"),
    )
    for (const projection of [live, replayed])
      expect(projection.units[1]).toMatchObject({
        key: "tool:turn-a:agent",
        content: {
          _tag: "Block",
          block: {
            _tag: "ToolCall",
            status: "complete",
            detail: "Inspect the projection",
            output: "The child recovered and returned an answer.",
          },
        },
      })
  })

  it("keeps a terminal child result from presenting a failed or cancelled subagent as finished", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
        {
          cursor: `call-${status}`,
          sequence: 1,
          type: "tool.call.requested",
          createdAt: 1,
          data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Inspect the projection" } },
        },
        {
          cursor: `result-${status}`,
          sequence: 2,
          type: "tool.result.received",
          createdAt: 2,
          data: { tool_call_id: "agent", output: { childExecutionId: "child:agent", status, output: [] } },
        },
      ])
      expect(projection.units[1]).toMatchObject({
        content: { _tag: "Block", block: { _tag: "ToolCall", status } },
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
})
