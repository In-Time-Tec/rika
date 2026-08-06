import { expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"

it("presents canonical Baton tool progress, retries, compaction, and Program logs", () => {
  const projection = TranscriptProjection.Projection.project("turn", "prompt", [
    {
      cursor: "tool",
      sequence: 1,
      type: "tool.call.requested",
      createdAt: 1,
      data: { tool_call_id: "call", tool_name: "bash", input: { command: "build" } },
    },
    {
      cursor: "progress",
      sequence: 2,
      type: "tool.progress",
      createdAt: 2,
      text: "building",
      data: { tool_call_id: "call" },
    },
    {
      cursor: "retry",
      sequence: 3,
      type: "model.retry.scheduled",
      createdAt: 3,
      data: { category: "rate-limit", delay_millis: 250 },
    },
    {
      cursor: "compaction",
      sequence: 4,
      type: "agent.compaction.completed",
      createdAt: 4,
      data: { checkpoint: "checkpoint" },
    },
    {
      cursor: "program",
      sequence: 5,
      type: "program.log",
      createdAt: 5,
      text: "finished",
      data: { operation: "summary", level: "info" },
    },
  ])

  expect(projection.units.find((unit) => unit.key === "tool:turn:call")).toMatchObject({
    content: { block: { status: "running", output: "building" } },
  })
  expect(JSON.stringify(projection.units)).toContain("Retrying model response")
  expect(JSON.stringify(projection.units)).toContain("checkpoint")
  expect(JSON.stringify(projection.units)).toContain("finished")
})

it("folds canonical Baton fan-out lifecycle into one settled notice", () => {
  const projection = TranscriptProjection.Projection.project("turn", "prompt", [
    {
      cursor: "admitted",
      sequence: 1,
      type: "fan_out.admitted",
      createdAt: 1,
      data: { fan_out_id: "batch", member_count: 3, concurrency: 2 },
    },
    {
      cursor: "joined",
      sequence: 2,
      type: "fan_out.joined",
      createdAt: 2,
      data: { fan_out_id: "batch", status: "failed", succeeded: 1, failed: 1, cancelled: 1, abandoned: 0 },
    },
  ])

  expect(projection.units.find((unit) => unit.key === "fan-out:turn:batch")).toMatchObject({
    revision: 2,
    content: {
      block: {
        title: "Child executions settled",
        detail: "1 succeeded, 1 failed, 1 cancelled, 0 abandoned",
      },
    },
  })
  expect(projection.units.filter((unit) => unit.key === "fan-out:turn:batch")).toHaveLength(1)
})
