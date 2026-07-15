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
})
