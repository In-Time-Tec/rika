import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  ToolOperationAttribution,
  ToolOperationLifecycleFrame,
  ToolOperationResponse,
  ToolOperationTerminalOutcome,
} from "../../../src/execution/tool/operation-lifecycle"

const attribution = {
  operationKey: "operation-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  threadId: "thread-1",
  turnId: "turn-1",
  runId: "run-1",
  rootRunId: "run-1",
  toolCallId: "tool-call-1",
  attempt: 1,
}

describe("tool operation lifecycle", () => {
  it("accepts provider-neutral operation responses", () => {
    expect(Schema.is(ToolOperationResponse)({ _tag: "Success", result: { value: "done" } })).toBe(true)
    expect(Schema.is(ToolOperationResponse)({ _tag: "DomainFailure", failure: { message: "failed" } })).toBe(true)
    expect(Schema.is(ToolOperationResponse)({ _tag: "Suspend", token: "approval-1" })).toBe(true)
    expect(Schema.is(ToolOperationResponse)({ _tag: "ProviderFailure", failure: {} })).toBe(false)
  })

  it("owns attribution, frames, and terminal outcomes", () => {
    expect(Schema.is(ToolOperationAttribution)(attribution)).toBe(true)
    expect(
      Schema.is(ToolOperationLifecycleFrame)({
        _tag: "Output",
        attribution,
        cursor: 3,
        stream: "stdout",
        text: "done",
        redacted: true,
        truncated: false,
      }),
    ).toBe(true)
    expect(
      Schema.is(ToolOperationLifecycleFrame)({
        _tag: "Terminal",
        attribution,
        cursor: 4,
        outcome: "completed",
        response: { _tag: "Success", result: { value: "done" } },
      }),
    ).toBe(true)
    expect(Schema.is(ToolOperationTerminalOutcome)("cancelled")).toBe(true)
    expect(Schema.is(ToolOperationTerminalOutcome)("provider-failed")).toBe(false)
  })
})
