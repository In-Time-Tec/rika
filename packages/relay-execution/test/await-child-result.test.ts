import * as AgentOutcomes from "@rika/coding-tools/agent-tool-contract"
import { describe, expect, it } from "@effect/vitest"
import type { Execution } from "@relayfx/sdk"
import { resolveChildResult } from "../src/relay/execution/execution-backend"

type EventInput = Record<string, unknown>

const child = "child:execution%3Aparent:call-1"

const events = (values: ReadonlyArray<EventInput>): ReadonlyArray<Execution.ExecutionEvent> =>
  values.map((value, index) => ({ sequence: index, ...value }) as unknown as Execution.ExecutionEvent)

const delta = (partId: string, index: number, text: string): EventInput => ({
  type: "model.output.delta",
  data: { delta: text, delta_index: index, part_id: partId },
})

const modelTurn = (finishReason?: string): ReadonlyArray<EventInput> => [
  { type: "model.call.started" },
  { type: "model.attempt.started" },
  ...(finishReason === undefined ? [] : [{ type: "model.usage.reported", data: { finish_reason: finishReason } }]),
  { type: "model.call.completed" },
]

const truncatedAttempt = (classification?: string): EventInput => ({
  type: "model.attempt.failed",
  data: { category: "truncated-stream", ...(classification === undefined ? {} : { classification }) },
})

const silentReason = "The subagent finished its run without writing a final report."

const resolve = (values: ReadonlyArray<EventInput>, reconciled?: "completed" | "failed" | "cancelled") =>
  resolveChildResult({
    childExecutionId: child,
    events: events(values),
    ...(reconciled === undefined ? {} : { reconciled }),
  })

describe("resolveChildResult", () => {
  it("reports a completed status when a child completes with an empty final model output", () => {
    const result = resolve([...modelTurn(), { type: "model.output.completed" }, { type: "execution.completed" }])
    expect(result._tag).toBe("NoReport")
    expect(result.status).toBe("completed")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.childExecutionId).toBe(child)
    expect(result.reason).toBe(silentReason)
    expect(result.recovery).toBe(AgentOutcomes.AgentContract.noReportRecovery)
  })

  it("treats a silent child the same whether or not the provider reported a finish reason", () => {
    const result = resolve([...modelTurn("stop"), { type: "model.output.completed" }, { type: "execution.completed" }])
    expect(result._tag).toBe("NoReport")
    expect(result.status).toBe("completed")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toBe(silentReason)
  })

  it("does not treat a turn-zero announcement outside the durable text contract as a report", () => {
    const result = resolve([
      ...modelTurn("tool-calls"),
      delta("part-a", 0, "I'll investigate the transcript rendering pipeline."),
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn(),
      { type: "model.output.completed", data: { model_output: "I'll investigate the transcript rendering pipeline." } },
      { type: "execution.completed", data: { model_output: "I'll investigate the transcript rendering pipeline." } },
    ])
    expect(result._tag).toBe("NoReport")
    expect(result.status).toBe("completed")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toBe(silentReason)
  })

  it("rejects mid-turn narration that a later model call superseded", () => {
    const result = resolve([
      ...modelTurn("tool-calls"),
      { type: "model.output.completed", content: [{ type: "text", text: "I'll start by reading the code." }] },
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn("stop"),
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("NoReport")
    expect(result.status).toBe("completed")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toBe(silentReason)
  })

  it("keeps a completed child's final report when the provider never reported a finish reason", () => {
    const result = resolve([
      ...modelTurn("tool-calls"),
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn(),
      { type: "model.output.completed", content: [{ type: "text", text: "The finding" }] },
      { type: "execution.completed", content: [{ type: "text", text: "The finding" }] },
    ])
    expect(result._tag).toBe("Report")
    if (result._tag !== "Report") throw new Error("expected Report")
    expect(result.output).toEqual([{ type: "text", text: "The finding" }])
  })

  it("keeps a report that lands after a trailing failed tool result", () => {
    const result = resolve([
      ...modelTurn("stop"),
      { type: "model.cycle.completed", content: [{ type: "text", text: "The finding" }] },
      { type: "tool.result.received", data: { tool_call_id: "late", error: "tool failed after the report" } },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("Report")
    expect(result.status).toBe("completed")
    if (result._tag !== "Report") throw new Error("expected Report")
    expect(result.output).toEqual([{ type: "text", text: "The finding" }])
  })

  it("synthesizes a text part from a cycle that carries only durable data text", () => {
    const result = resolve([
      ...modelTurn("stop"),
      { type: "model.cycle.completed", data: { text: "Durable text only" } },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("Report")
    if (result._tag !== "Report") throw new Error("expected Report")
    expect(result.output).toEqual([{ type: "text", text: "Durable text only" }])
  })

  it("ignores streamed deltas when a child completes without a durable final report", () => {
    const result = resolve([
      ...modelTurn("tool-calls"),
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn(),
      delta("part-b", 0, "Here is what I found so far"),
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("NoReport")
    expect(result.status).toBe("completed")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toBe(silentReason)
  })

  it("keeps a failed child failed and attaches its final response", () => {
    const result = resolve([
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn(),
      { type: "model.output.completed", content: [{ type: "text", text: "final answer" }] },
      { type: "execution.failed", data: { message: "stream closed" } },
    ])
    expect(result._tag).toBe("Failed")
    expect(result.status).toBe("failed")
    if (result._tag !== "Failed") throw new Error("expected Failed")
    expect(result.reason).toBe("Subagent execution failed: stream closed")
    expect(result.output).toEqual([{ type: "text", text: "final answer" }])
  })

  it("keeps a failed child failed even when an attempt was classified as a truncated stream", () => {
    const result = resolve([
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn("stop"),
      { type: "model.output.completed", content: [{ type: "text", text: "final answer" }] },
      truncatedAttempt("terminal"),
      { type: "execution.failed", data: { message: "stream closed" } },
    ])
    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") throw new Error("expected Failed")
    expect(result.reason).toBe("Subagent execution failed: stream closed")
    expect(result.output).toEqual([{ type: "text", text: "final answer" }])
  })

  it("keeps the report when a proxy truncation was followed by a recovered final call", () => {
    const result = resolve([
      { type: "model.call.started" },
      { type: "model.call.failed", data: { category: "truncated-stream" } },
      ...modelTurn("stop"),
      { type: "model.output.completed", content: [{ type: "text", text: "recovered finding" }] },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("Report")
    if (result._tag !== "Report") throw new Error("expected Report")
    expect(result.output).toEqual([{ type: "text", text: "recovered finding" }])
  })

  it("keeps the report when an earlier transient truncation was retried and recovered", () => {
    const result = resolve([
      { type: "model.call.started" },
      { type: "model.attempt.started" },
      truncatedAttempt("transient"),
      { type: "model.attempt.started" },
      { type: "model.usage.reported", data: { finish_reason: "tool-calls" } },
      { type: "model.call.completed" },
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn("stop"),
      { type: "model.output.completed", content: [{ type: "text", text: "recovered finding" }] },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("Report")
    if (result._tag !== "Report") throw new Error("expected Report")
    expect(result.output).toEqual([{ type: "text", text: "recovered finding" }])
  })

  it("keeps the report when the final call recovers from a transient truncation", () => {
    const result = resolve([
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      { type: "model.call.started" },
      { type: "model.attempt.started" },
      truncatedAttempt("transient"),
      { type: "model.attempt.started" },
      { type: "model.usage.reported", data: { finish_reason: "stop" } },
      { type: "model.call.completed" },
      { type: "model.output.completed", content: [{ type: "text", text: "recovered finding" }] },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("Report")
  })

  it("keeps a completed child's report after a terminal truncation classification", () => {
    const result = resolve([
      ...modelTurn("stop"),
      truncatedAttempt("terminal"),
      { type: "model.output.completed", content: [{ type: "text", text: "the finding" }] },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("Report")
    if (result._tag !== "Report") throw new Error("expected Report")
    expect(result.output).toEqual([{ type: "text", text: "the finding" }])
  })

  it("keeps a completed child's report when a truncated call failure carries no classification", () => {
    const result = resolve([
      ...modelTurn("stop"),
      { type: "model.call.failed", data: { category: "truncated-stream" } },
      { type: "model.output.completed", content: [{ type: "text", text: "the finding" }] },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("Report")
    if (result._tag !== "Report") throw new Error("expected Report")
    expect(result.output).toEqual([{ type: "text", text: "the finding" }])
  })

  it("keeps a completed child's report when a truncated attempt failure carries no classification", () => {
    const result = resolve([
      ...modelTurn("stop"),
      truncatedAttempt(),
      { type: "model.output.completed", content: [{ type: "text", text: "the finding" }] },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("Report")
  })

  it("surfaces a failed child as failed with its post-tool response attached", () => {
    const result = resolve([
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn("stop"),
      { type: "model.output.completed", content: [{ type: "text", text: "final answer" }] },
      { type: "execution.failed", data: { message: "late failure" } },
    ])
    expect(result._tag).toBe("Failed")
    expect(result.status).toBe("failed")
    if (result._tag !== "Failed") throw new Error("expected Failed")
    expect(result.reason).toBe("Subagent execution failed: late failure")
    expect(result.output).toEqual([{ type: "text", text: "final answer" }])
  })

  it("ignores streamed deltas when a child fails without a durable report", () => {
    const result = resolve([
      delta("part-a", 0, "Full "),
      delta("part-a", 1, "report"),
      { type: "model.usage.reported", data: { finish_reason: "stop" } },
      {
        type: "execution.failed",
        data: { message: "OpenAiClient.createResponse: HTTP 400 Stream must be set to true" },
      },
    ])
    expect(result._tag).toBe("NoReport")
    expect(result.status).toBe("failed")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toBe(
      "Subagent execution failed: OpenAiClient.createResponse: HTTP 400 Stream must be set to true",
    )
  })

  it("keeps completed output untouched when model.output.completed exists", () => {
    const result = resolve([
      delta("part-a", 0, "ignored"),
      { type: "model.output.completed", content: [{ type: "text", text: "final" }] },
      { type: "execution.completed", content: [] },
    ])
    expect(result._tag).toBe("Report")
    if (result._tag !== "Report") throw new Error("expected Report")
    expect(result.output).toEqual([{ type: "text", text: "final" }])
  })

  it("uses terminal content when no model event carries the report", () => {
    const result = resolve([
      delta("part-a", 0, "draft"),
      { type: "execution.completed", content: [{ type: "text", text: "terminal" }] },
    ])
    expect(result._tag).toBe("Report")
    if (result._tag !== "Report") throw new Error("expected Report")
    expect(result.output).toEqual([{ type: "text", text: "terminal" }])
  })

  it("keeps terminal failure content as the recovered output", () => {
    const result = resolve([
      delta("part-a", 0, "draft"),
      { type: "execution.failed", content: [{ type: "text", text: "boom" }], data: { message: "boom" } },
    ])
    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") throw new Error("expected Failed")
    expect(result.reason).toBe("Subagent execution failed: boom")
    expect(result.output).toEqual([{ type: "text", text: "boom" }])
  })

  it("scrubs an unrenderable failure message from a NoReport reason", () => {
    const result = resolve([
      ...modelTurn("stop"),
      { type: "model.output.completed" },
      { type: "execution.failed", data: { message: "[object Object]" } },
    ])
    expect(result._tag).toBe("NoReport")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).not.toContain("[object Object]")
    expect(result.reason).toBe("Subagent execution failed")
  })

  it("scrubs an unrenderable failure message when only deltas were streamed", () => {
    const result = resolve([
      ...modelTurn("tool-calls"),
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      { type: "model.call.started" },
      { type: "model.attempt.started" },
      delta("part-a", 0, "Partial finding"),
      { type: "execution.failed", data: { message: "[object Object]" } },
    ])
    expect(result._tag).toBe("NoReport")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).not.toContain("[object Object]")
    expect(result.reason).toBe("Subagent execution failed")
  })

  it("scrubs an unrenderable cancellation message", () => {
    const result = resolve([
      ...modelTurn("stop"),
      { type: "model.output.completed" },
      { type: "execution.cancelled", data: { message: "[object Object]" } },
    ])
    expect(result._tag).toBe("Cancelled")
    if (result._tag !== "Cancelled") throw new Error("expected Cancelled")
    expect(result.reason).not.toContain("[object Object]")
    expect(result.reason).toBe("Subagent execution was cancelled")
  })

  it("keeps the context-overflow explanation in a child failure reason", () => {
    const result = resolve([
      ...modelTurn("stop"),
      { type: "model.output.completed" },
      {
        type: "execution.failed",
        data: { message: "[object Object]", details: { failure_classification: "context-overflow" } },
      },
    ])
    expect(result._tag).toBe("NoReport")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toContain("Automatic compaction")
    expect(result.reason).not.toContain("[object Object]")
  })

  it("reports cancellation with empty stream output", () => {
    const result = resolve([{ type: "execution.cancelled", data: {} }])
    expect(result._tag).toBe("Cancelled")
    expect(result.status).toBe("cancelled")
    if (result._tag !== "Cancelled") throw new Error("expected Cancelled")
    expect(result.reason).toBe("Subagent execution was cancelled")
    expect(result.output).toEqual([])
  })

  it("keeps cancellation authoritative after a completed final response", () => {
    const result = resolve([
      { type: "model.output.completed", content: [{ type: "text", text: "Completed response" }] },
      { type: "execution.cancelled", data: { message: "cancelled" } },
    ])
    expect(result._tag).toBe("Cancelled")
    if (result._tag !== "Cancelled") throw new Error("expected Cancelled")
    expect(result.reason).toBe("Subagent execution was cancelled: cancelled")
    expect(result.output).toEqual([{ type: "text", text: "Completed response" }])
  })

  it("does not recover a stale final response before later tool activity", () => {
    const result = resolve([
      { type: "model.output.completed", content: [{ type: "text", text: "Stale response" }] },
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      { type: "execution.failed", data: { message: "internal tool failed" } },
    ])
    expect(result._tag).toBe("NoReport")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toBe("Subagent execution failed: internal tool failed")
  })

  it("classifies a child whose terminal event never arrived from the reconciled execution status", () => {
    const result = resolve([{ type: "model.output.completed", content: [{ type: "text", text: "partial" }] }], "failed")
    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") throw new Error("expected Failed")
    expect(result.reason).toContain("final event never reached Rika")
    expect(result.reason).not.toMatch(/relay/i)
    expect(result.output).toEqual([{ type: "text", text: "partial" }])
  })

  it("reports no report for an unreconciled child with no durable output", () => {
    const result = resolve([...modelTurn("stop"), { type: "model.output.completed" }])
    expect(result._tag).toBe("NoReport")
    expect(result.status).toBe("failed")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toContain("final event never reached Rika")
  })
})
