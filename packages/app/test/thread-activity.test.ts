import { describe, expect, it } from "@effect/vitest"
import * as Thread from "@rika/persistence/thread"
import * as ThreadActivity from "../src/thread-activity"

const event = (overrides: Partial<import("@rika/runtime/contract").Event> = {}) => ({
  cursor: "cursor-1",
  sequence: 1,
  type: "workspace.diff",
  createdAt: 10,
  ...overrides,
})

describe("thread activity projection", () => {
  it("pairs replacement lines and preserves unmatched additions and removals", () => {
    expect(
      ThreadActivity.editTotalsForPatch(
        [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1,4 +1,5 @@",
          "-old one",
          "-old two",
          "+new one",
          "+new two",
          "+new three",
          " context",
          "-removed",
        ].join("\n"),
      ),
    ).toEqual({ added: 1, modified: 2, removed: 1 })
  })

  it("prefers explicit diff events over embedded tool-result copies", () => {
    const patch = ["--- a/a", "+++ b/a", "@@ -1 +1 @@", "-before", "+after"].join("\n")
    expect(
      ThreadActivity.editTotals([
        event({ text: patch }),
        event({
          cursor: "cursor-2",
          sequence: 2,
          type: "tool.result.received",
          data: { output: { diff: patch } },
        }),
      ]),
    ).toEqual({ added: 0, modified: 1, removed: 0 })
  })

  it("builds a replaceable terminal projection from the full result", () => {
    const projected = ThreadActivity.projectionInput(
      Thread.ThreadId.make("thread-a"),
      {
        turnId: "turn-a",
        status: "completed",
        events: [
          event({
            text: ["--- a/a", "+++ b/a", "@@ -0,0 +1 @@", "+added"].join("\n"),
            createdAt: 12,
          }),
        ],
      },
      20,
    )
    expect(projected).toMatchObject({
      turnId: "turn-a",
      threadId: "thread-a",
      projectedCursor: "cursor-1",
      complete: true,
      editTotals: { added: 1, modified: 0, removed: 0 },
      lastEventAt: 12,
      now: 20,
    })
  })

  it("projects the highest event sequence when replay delivery is out of order", () => {
    expect(
      ThreadActivity.projectionInput(
        Thread.ThreadId.make("thread-a"),
        {
          turnId: "turn-a",
          status: "running",
          events: [
            event({ cursor: "cursor-3", sequence: 3, createdAt: 12 }),
            event({ cursor: "cursor-1", sequence: 1, createdAt: 20 }),
            event({ cursor: "cursor-2", sequence: 2, createdAt: 16 }),
          ],
        },
        30,
      ),
    ).toMatchObject({ projectedCursor: "cursor-3", complete: false, lastEventAt: 20 })
  })

  it("returns only a completed Agent response after the latest tool request", () => {
    expect(
      ThreadActivity.finalAssistantOutput([
        event({ sequence: 1, type: "model.output.delta", text: "partial" }),
        event({ sequence: 2, type: "model.output.completed", text: "stale" }),
        event({ sequence: 3, type: "tool.call.requested" }),
        event({ sequence: 4, type: "model.output.delta", text: "new partial" }),
        event({ sequence: 5, type: "execution.failed" }),
      ]),
    ).toBeUndefined()
    expect(
      ThreadActivity.finalAssistantOutput([
        event({ sequence: 1, type: "tool.call.requested" }),
        event({ sequence: 2, type: "model.output.completed", content: [{ type: "text", text: "proven final" }] }),
        event({ sequence: 3, type: "execution.completed" }),
      ]),
    ).toBe("proven final")
  })
})
