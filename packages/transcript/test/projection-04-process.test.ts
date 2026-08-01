import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import type { SourceEvent } from "../src/schema/transcript-source-event"

describe("Transcript projection", () => {
  it("settles each process wait while the parent command owns process liveness", () => {
    const events: ReadonlyArray<SourceEvent> = [
      {
        cursor: "bash",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "bash-1", tool_name: "bash", input: { command: "bun test" } },
      },
      {
        cursor: "shell-result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: {
          tool_call_id: "bash-1",
          output: { text: "initial", processId: "process-1", running: true, stdout: "initial\n" },
        },
      },
      {
        cursor: "wait-1",
        sequence: 3,
        type: "tool.call.requested",
        createdAt: 3,
        data: {
          tool_call_id: "wait-1",
          tool_name: "shell_command_status",
          input: { processId: "process-1" },
        },
      },
      {
        cursor: "wait-result-1",
        sequence: 4,
        type: "tool.result.received",
        createdAt: 4,
        data: {
          tool_call_id: "wait-1",
          output: { text: "middle\n", processId: "process-1", running: true, stdout: "middle\n" },
        },
      },
      {
        cursor: "wait-2",
        sequence: 5,
        type: "tool.call.requested",
        createdAt: 5,
        data: {
          tool_call_id: "wait-2",
          tool_name: "shell_command_status",
          input: { processId: "process-1" },
        },
      },
      {
        cursor: "wait-result-2",
        sequence: 6,
        type: "tool.result.received",
        createdAt: 6,
        data: {
          tool_call_id: "wait-2",
          output: { text: "final\n", processId: "process-1", running: false, exitCode: 0, stdout: "final\n" },
        },
      },
      {
        cursor: "wait-3",
        sequence: 7,
        type: "tool.call.requested",
        createdAt: 7,
        data: {
          tool_call_id: "wait-3",
          tool_name: "shell_command_status",
          input: { processId: "process-1" },
        },
      },
      {
        cursor: "wait-result-3",
        sequence: 8,
        type: "tool.result.received",
        createdAt: 8,
        data: {
          tool_call_id: "wait-3",
          output: { text: "stale", processId: "process-1", running: true, stdout: "stale" },
        },
      },
    ]
    const interim = TranscriptProjection.Projection.project("turn-a", "run tests", events.slice(0, 4))
    const projection = TranscriptProjection.Projection.project("turn-a", "run tests", events)

    expect(interim.units[1]).toMatchObject({
      revision: 4,
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "running", output: "initial\nmiddle\n" } },
    })
    expect(interim.units[2]).toMatchObject({
      revision: 4,
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "complete", output: "middle\n" } },
    })
    expect(TranscriptProjection.Projection.hasRunningBlocks(interim)).toBe(true)
    expect(projection.units).toHaveLength(5)
    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:bash-1",
      revision: 6,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          status: "complete",
          output: "initial\nmiddle\nfinal\n",
          process: { processId: "process-1", running: false, exitCode: 0, stdout: "initial\n" },
        },
      },
    })
    expect(projection.units[2]).toMatchObject({
      key: "tool:turn-a:wait-1",
      revision: 4,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          status: "complete",
          output: "middle\n",
          parentId: "turn-a:bash-1",
          detail: "bun test",
          process: { processId: "process-1", running: true, stdout: "middle\n" },
          presentation: { activeLabel: "Waiting for", completeLabel: "Waited for" },
        },
      },
    })
    expect(projection.units[3]).toMatchObject({
      key: "tool:turn-a:wait-2",
      revision: 6,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          status: "complete",
          output: "final\n",
          parentId: "turn-a:bash-1",
          detail: "bun test",
          process: { processId: "process-1", running: false, exitCode: 0, stdout: "final\n" },
          presentation: { activeLabel: "Waiting for", completeLabel: "Waited for" },
        },
      },
    })
    expect(projection.units[4]).toMatchObject({
      key: "tool:turn-a:wait-3",
      revision: 8,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          status: "complete",
          output: "stale",
          parentId: "turn-a:bash-1",
          process: { processId: "process-1", running: true, stdout: "stale" },
        },
      },
    })
    expect(TranscriptProjection.Projection.hasRunningBlocks(projection)).toBe(false)
    expect(
      events.reduce(
        (current, event) => TranscriptProjection.Projection.applyEvent(current, event),
        TranscriptProjection.Projection.empty("turn-a", "run tests"),
      ),
    ).toEqual(projection)
    expect(TranscriptProjection.Projection.applyEvent(projection, events.at(-1)!)).toEqual(projection)
  })

  it("separates process failure from status-call failure", () => {
    const running: ReadonlyArray<SourceEvent> = [
      {
        cursor: "bash",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "bash-1", tool_name: "bash", input: { command: "bun test" } },
      },
      {
        cursor: "bash-result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "bash-1", output: { text: "", processId: "process-1", running: true } },
      },
      {
        cursor: "wait",
        sequence: 3,
        type: "tool.call.requested",
        createdAt: 3,
        data: {
          tool_call_id: "wait-1",
          tool_name: "shell_command_status",
          input: { processId: "process-1" },
        },
      },
    ]
    const failed = TranscriptProjection.Projection.project("turn-a", "run tests", [
      ...running,
      {
        cursor: "failed",
        sequence: 4,
        type: "tool.result.received",
        createdAt: 4,
        data: {
          tool_call_id: "wait-1",
          output: { text: "failed", processId: "process-1", running: false, exitCode: 7 },
        },
      },
    ])
    const statusError = TranscriptProjection.Projection.project("turn-a", "run tests", [
      ...running,
      {
        cursor: "status-error",
        sequence: 4,
        type: "tool.result.received",
        createdAt: 4,
        data: {
          tool_call_id: "wait-1",
          output: { _tag: "ToolError", message: "Unknown process id: process-1" },
        },
      },
    ])

    expect(failed.units[1]).toMatchObject({
      revision: 4,
      content: {
        _tag: "Block",
        block: { _tag: "ToolCall", status: "failed", process: { running: false, exitCode: 7 } },
      },
    })
    expect(failed.units[2]).toMatchObject({
      content: {
        _tag: "Block",
        block: { _tag: "ToolCall", status: "failed", process: { running: false, exitCode: 7 } },
      },
    })
    expect(TranscriptProjection.Projection.hasRunningBlocks(failed)).toBe(false)
    expect(statusError.units[1]).toMatchObject({
      revision: 2,
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "running" } },
    })
    expect(statusError.units[2]).toMatchObject({
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "failed" } },
    })
    expect(TranscriptProjection.Projection.hasRunningBlocks(statusError)).toBe(true)
  })

  it("bounds folded process output while retaining the newest status chunk", () => {
    const initial = "a".repeat(30_000)
    const latest = `${"b".repeat(30_000)}TAIL`
    const projection = TranscriptProjection.Projection.project("turn-a", "run tests", [
      {
        cursor: "bash",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "bash-1", tool_name: "bash", input: { command: "bun test" } },
      },
      {
        cursor: "bash-result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: {
          tool_call_id: "bash-1",
          output: { text: initial, processId: "process-1", running: true, stdout: initial },
        },
      },
      {
        cursor: "wait",
        sequence: 3,
        type: "tool.call.requested",
        createdAt: 3,
        data: {
          tool_call_id: "wait-1",
          tool_name: "shell_command_status",
          input: { processId: "process-1" },
        },
      },
      {
        cursor: "wait-result",
        sequence: 4,
        type: "tool.result.received",
        createdAt: 4,
        data: {
          tool_call_id: "wait-1",
          output: {
            text: latest,
            processId: "process-1",
            running: true,
            stdout: latest,
            truncated: true,
          },
        },
      },
    ])
    const parent = projection.units[1]?.content

    expect(parent).toMatchObject({
      _tag: "Block",
      block: { _tag: "ToolCall", status: "running", process: { running: true, truncated: true } },
    })
    if (parent?._tag !== "Block" || parent.block._tag !== "ToolCall") return
    expect(parent.block.output).toHaveLength(40_000)
    expect(parent.block.output).toBe(`${initial}${latest}`.slice(-40_000))
    expect(parent.block.output?.endsWith("TAIL")).toBe(true)
  })
})
