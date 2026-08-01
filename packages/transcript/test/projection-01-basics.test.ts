import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import type { SourceEvent } from "../src/schema/transcript-source-event"

describe("Transcript projection", () => {
  it("collapses a long output stream into stable semantic units", () => {
    const events = Array.from(
      { length: 600 },
      (_, index): SourceEvent => ({
        cursor: `cursor-${index}`,
        sequence: index,
        type: "model.output.delta",
        createdAt: index,
        text: `line ${index}\n`,
      }),
    )
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", events)

    expect(projection.units).toHaveLength(2)
    expect(projection.units[0]).toMatchObject({ key: "turn:turn-a:user", content: { role: "user", text: "prompt" } })
    expect(projection.units[1]).toMatchObject({ content: { role: "assistant" } })
    expect(projection.units[1]?.content._tag).toBe("Entry")
    expect(projection.units[1]?.content._tag === "Entry" ? projection.units[1].content.text : "").toContain("line 599")
    expect(projection.checkpointCursor).toBe("cursor-599")
    expect(projection.revision).toBe(599)
  })

  it("preserves prose and activity order while reconciling tool results", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      { cursor: "0", sequence: 0, type: "model.input.prepared", createdAt: 0 },
      { cursor: "1", sequence: 1, type: "model.output.delta", createdAt: 1, text: "first" },
      { cursor: "1b", sequence: 2, type: "model.output.completed", createdAt: 2, text: "first" },
      {
        cursor: "2",
        sequence: 3,
        type: "tool.call.requested",
        createdAt: 3,
        data: { tool_call_id: "call", tool_name: "read", input: "a" },
      },
      {
        cursor: "3",
        sequence: 4,
        type: "tool.result.received",
        createdAt: 4,
        data: { tool_call_id: "call", output: "ok" },
      },
      { cursor: "4", sequence: 5, type: "model.input.prepared", createdAt: 5 },
      { cursor: "5", sequence: 6, type: "model.output.delta", createdAt: 6, text: "final" },
      { cursor: "6", sequence: 7, type: "model.output.completed", createdAt: 7, text: "final" },
      { cursor: "7", sequence: 8, type: "execution.completed", createdAt: 8 },
    ])

    expect(projection.units.map((unit) => unit.content._tag)).toEqual(["Entry", "Entry", "Block", "Entry"])
    expect(projection.units.find((unit) => unit.key === "turn:turn-a:user")).toMatchObject({
      executionOutcome: { status: "complete" },
    })
    expect(projection.units[2]).toMatchObject({
      key: "tool:turn-a:call",
      revision: 4,
      content: { _tag: "Block", block: { _tag: "ToolCall", output: "ok", status: "complete" } },
    })
    expect(projection.units[3]).toMatchObject({ content: { _tag: "Entry", text: "final" } })
    expect(
      projection.units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "user"),
    ).toHaveLength(1)
    expect(TranscriptProjection.Projection.finalAssistantOutput(projection, "turn-a")).toBe("final")
  })

  it("does not treat assistant text before the last root tool as the final output", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      { cursor: "answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "not final" },
      {
        cursor: "tool",
        sequence: 2,
        type: "tool.call.requested",
        createdAt: 2,
        data: { tool_call_id: "read", tool_name: "read", input: { path: "a.ts" } },
      },
      {
        cursor: "result",
        sequence: 3,
        type: "tool.result.received",
        createdAt: 3,
        data: { tool_call_id: "read", output: { text: "contents" } },
      },
      { cursor: "complete", sequence: 4, type: "execution.completed", createdAt: 4 },
    ])

    expect(TranscriptProjection.Projection.finalAssistantOutput(projection, "turn-a")).toBeUndefined()
  })

  it("does not treat an unfinished assistant stream as the final output", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      { cursor: "partial", sequence: 1, type: "model.output.delta", createdAt: 1, text: "partial" },
    ])

    expect(TranscriptProjection.Projection.finalAssistantOutput(projection, "turn-a")).toBeUndefined()
  })

  it("keeps a delegation card running when its result is a spawned subagent handle", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      { cursor: "0", sequence: 0, type: "model.input.prepared", createdAt: 0 },
      {
        cursor: "1",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "call", tool_name: "task", input: { prompt: "Explore." } },
      },
      {
        cursor: "2",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: {
          tool_call_id: "call",
          output: {
            _tag: "Spawned",
            childExecutionId: "child:execution%3Aturn-a:call",
            status: "running",
            next: "Call await_subagents.",
          },
        },
      },
    ])

    const unit = projection.units.find((candidate) => candidate.key === "tool:turn-a:call")
    const block = unit?.content._tag === "Block" ? unit.content.block : undefined
    expect(block?._tag).toBe("ToolCall")
    expect(block?._tag === "ToolCall" ? block.status : undefined).toBe("running")
    expect(block?._tag === "ToolCall" ? (block.output ?? "") : "").not.toContain("Spawned")
  })

  it("does not replay the execution-wide completion text into the final assistant phase", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      { cursor: "0", sequence: 0, type: "model.input.prepared", createdAt: 0 },
      { cursor: "1", sequence: 1, type: "model.output.delta", createdAt: 1, text: "first" },
      {
        cursor: "2",
        sequence: 2,
        type: "tool.call.requested",
        createdAt: 2,
        data: { tool_call_id: "read", tool_name: "read", input: { path: "a.ts" } },
      },
      {
        cursor: "3",
        sequence: 3,
        type: "tool.result.received",
        createdAt: 3,
        data: { tool_call_id: "read", output: { text: "contents" } },
      },
      { cursor: "4", sequence: 4, type: "model.output.delta", createdAt: 4, text: "final" },
      {
        cursor: "5",
        sequence: 5,
        type: "model.output.completed",
        createdAt: 5,
        text: "firstfinal",
        data: { model_output: "firstfinal" },
      },
    ])
    expect(
      projection.units.flatMap((unit) =>
        unit.content._tag === "Entry" && unit.content.role === "assistant" ? [unit.content.text] : [],
      ),
    ).toEqual(["first", "final"])
  })

  it("projects completed unified diffs from any tool result", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "change files", [
      {
        cursor: "1",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "change-1", tool_name: "bash", input: { command: "make changes" } },
      },
      {
        cursor: "2",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: {
          tool_call_id: "change-1",
          output: {
            text: "changed 2 files",
            diff:
              "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n\n" +
              "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+hello",
          },
        },
      },
    ])
    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:change-1",
      content: {
        _tag: "Block",
        block: {
          status: "complete",
          files: [
            { path: "src/a.ts", preview: false },
            { path: "src/b.ts", preview: false },
          ],
        },
      },
    })
  })
})
