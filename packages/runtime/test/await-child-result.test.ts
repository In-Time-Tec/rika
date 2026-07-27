import { describe, expect, it } from "@effect/vitest"
import { AgentTools } from "@rika/tools"
import type { Execution } from "@relayfx/sdk"
import { resolveChildResult } from "../src/execution-backend"

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

const resolve = (values: ReadonlyArray<EventInput>, reconciled?: "completed" | "failed" | "cancelled") =>
  resolveChildResult({
    childExecutionId: child,
    events: events(values),
    ...(reconciled === undefined ? {} : { reconciled }),
  })

describe("resolveChildResult", () => {
  it("reports no report when a child completes with an empty final model output", () => {
    const result = resolve([...modelTurn(), { type: "model.output.completed" }, { type: "execution.completed" }])
    expect(result._tag).toBe("NoReport")
    expect(result.status).toBe("failed")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.childExecutionId).toBe(child)
    expect(result.reason).toContain("ended before the provider reported why it stopped")
    expect(result.recovery).toBe(AgentTools.noReportRecovery)
  })

  it("reports no report when the only text is a turn-zero announcement before a truncation", () => {
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
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toContain("ended before the provider reported why it stopped")
  })

  it("distinguishes a deliberately silent child from a truncated one", () => {
    const result = resolve([...modelTurn("stop"), { type: "model.output.completed" }, { type: "execution.completed" }])
    expect(result._tag).toBe("NoReport")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toBe("The subagent finished its run without writing a final report.")
  })

  it("does not trust a stale final response replayed by a truncated turn", () => {
    const stale = "I'll investigate the transcript rendering pipeline."
    const result = resolve([
      ...modelTurn("tool-calls"),
      delta("part-a", 0, stale),
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn(),
      { type: "model.output.completed", content: [{ type: "text", text: stale }] },
      { type: "execution.completed", content: [{ type: "text", text: stale }] },
    ])
    expect(result._tag).toBe("NoReport")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toBe(
      "The subagent's final model turn ended before the provider reported why it stopped, so the stream was cut off and no report was produced.",
    )
  })

  it("keeps genuinely streamed partial work from a truncated turn as a failure", () => {
    const result = resolve([
      ...modelTurn("tool-calls"),
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn(),
      delta("part-b", 0, "Here is what I found so far"),
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") throw new Error("expected Failed")
    expect(result.reason).toContain("ended before the provider reported why it stopped")
    expect(result.output).toEqual([{ type: "text", text: "Here is what I found so far" }])
  })

  it("does not remap a failed truncated child to completed", () => {
    const result = resolve([
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn(),
      { type: "model.output.completed", content: [{ type: "text", text: "final answer" }] },
      { type: "execution.failed", data: { message: "stream closed" } },
    ])
    expect(result._tag).toBe("NoReport")
    expect(result.status).toBe("failed")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toBe("Subagent execution failed: stream closed")
  })

  it("does not remap a failed child that Relay classified as a truncated stream", () => {
    const result = resolve([
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn("stop"),
      { type: "model.output.completed", content: [{ type: "text", text: "final answer" }] },
      truncatedAttempt("terminal"),
      { type: "execution.failed", data: { message: "stream closed" } },
    ])
    expect(result._tag).toBe("NoReport")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toBe("Subagent execution failed: stream closed")
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

  it("ignores a retry-scheduled event carrying the truncated-stream category", () => {
    const result = resolve([
      { type: "model.call.started" },
      { type: "model.attempt.started" },
      truncatedAttempt("transient"),
      { type: "model.retry.scheduled", data: { category: "truncated-stream" } },
      { type: "model.attempt.started" },
      { type: "model.usage.reported", data: { finish_reason: "stop" } },
      { type: "model.call.completed" },
      { type: "model.output.completed", content: [{ type: "text", text: "recovered finding" }] },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("Report")
  })

  it("discards the report after a terminal truncation classification", () => {
    const result = resolve([
      ...modelTurn("stop"),
      truncatedAttempt("terminal"),
      { type: "model.output.completed", content: [{ type: "text", text: "tainted finding" }] },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("NoReport")
    if (result._tag !== "NoReport") throw new Error("expected NoReport")
    expect(result.reason).toContain("the stream was cut off")
  })

  it("treats a truncated call failure without a classification as terminal", () => {
    const result = resolve([
      ...modelTurn("stop"),
      { type: "model.call.failed", data: { category: "truncated-stream" } },
      { type: "model.output.completed", content: [{ type: "text", text: "tainted finding" }] },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("NoReport")
  })

  it("treats an attempt failure without a classification as terminal", () => {
    const result = resolve([
      ...modelTurn("stop"),
      truncatedAttempt(),
      { type: "model.output.completed", content: [{ type: "text", text: "tainted finding" }] },
      { type: "execution.completed" },
    ])
    expect(result._tag).toBe("NoReport")
  })

  it("remaps a failed child with a complete post-tool response to a report", () => {
    const result = resolve([
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      ...modelTurn("stop"),
      { type: "model.output.completed", content: [{ type: "text", text: "final answer" }] },
      { type: "execution.failed", data: { message: "late failure" } },
    ])
    expect(result._tag).toBe("Report")
    expect(result.status).toBe("completed")
    if (result._tag !== "Report") throw new Error("expected Report")
    expect(result.output).toEqual([{ type: "text", text: "final answer" }])
  })

  it("recovers streamed output and failure detail when a child fails after finishing its report", () => {
    const result = resolve([
      delta("part-a", 0, "Full "),
      delta("part-a", 1, "report"),
      { type: "model.usage.reported", data: { finish_reason: "stop" } },
      {
        type: "execution.failed",
        data: { message: "OpenAiClient.createResponse: HTTP 400 Stream must be set to true" },
      },
    ])
    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") throw new Error("expected Failed")
    expect(result.reason).toBe(
      "Subagent execution failed: OpenAiClient.createResponse: HTTP 400 Stream must be set to true",
    )
    expect(result.output).toEqual([{ type: "text", text: "Full report" }])
  })

  it("keeps only the final turn's deltas when reconstructing a fallback report", () => {
    const result = resolve([
      delta("part-a", 0, "narration from an early turn"),
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      delta("part-b", 0, "the answer"),
      { type: "execution.failed", data: {} },
    ])
    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") throw new Error("expected Failed")
    expect(result.output).toEqual([{ type: "text", text: "the answer" }])
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

  it("prefers terminal content over recovered deltas", () => {
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

  it("scrubs an unrenderable failure message from a truncated Failed reason", () => {
    const result = resolve([
      ...modelTurn("tool-calls"),
      { type: "tool.call.requested" },
      { type: "tool.result.received" },
      { type: "model.call.started" },
      { type: "model.attempt.started" },
      delta("part-a", 0, "Partial finding"),
      { type: "execution.failed", data: { message: "[object Object]" } },
    ])
    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") throw new Error("expected Failed")
    expect(result.reason).not.toContain("[object Object]")
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

  it("orders recovered deltas by part and delta index", () => {
    const result = resolve([
      delta("part-b", 0, "second"),
      delta("part-a", 1, "one"),
      delta("part-a", 0, "part "),
      { type: "execution.failed", data: {} },
    ])
    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") throw new Error("expected Failed")
    expect(result.reason).toBe("Subagent execution failed")
    expect(result.output).toEqual([{ type: "text", text: "second\n\npart one" }])
  })

  it("classifies a child whose terminal event never arrived from the reconciled execution status", () => {
    const result = resolve([{ type: "model.output.completed", content: [{ type: "text", text: "partial" }] }], "failed")
    expect(result._tag).toBe("Failed")
    if (result._tag !== "Failed") throw new Error("expected Failed")
    expect(result.reason).toContain("final event never reached Rika")
    expect(result.reason).not.toMatch(/relay/i)
    expect(result.output).toEqual([{ type: "text", text: "partial" }])
  })
})
