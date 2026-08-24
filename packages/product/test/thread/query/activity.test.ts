import { describe, expect, it } from "@effect/vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import type { Unit } from "@rika/transcript/transcript-unit"
import { unitOrder } from "@rika/transcript/transcript-unit-order"
import * as ThreadActivity from "../../../src/thread/query/activity"

const turnId = Turn.TurnId.make("turn-a")
const threadId = Thread.ThreadId.make("thread-a")

const toolUnit = (key: string, output: string | undefined): Unit => ({
  key,
  turnId,
  order: unitOrder(key, 0),
  revision: 0,
  content: {
    _tag: "Block",
    block: {
      _tag: "ToolCall",
      id: key,
      name: "edit",
      input: "{}",
      status: "complete",
      presentation: { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
      detail: "src/a.ts",
      files: [],
      ...(output === undefined ? {} : { output }),
    },
  },
})

const assistantUnit = (text: string): Unit => ({
  key: `assistant:${text}`,
  turnId,
  order: unitOrder(`assistant:${text}`, 1),
  revision: 0,
  content: { _tag: "Entry", role: "assistant", text },
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

  it("counts nothing outside a hunk and separates consecutive change blocks", () => {
    expect(ThreadActivity.editTotalsForPatch(["--- a/a.ts", "+++ b/a.ts", "+stray"].join("\n"))).toEqual({
      added: 0,
      modified: 0,
      removed: 0,
    })
    expect(
      ThreadActivity.editTotalsForPatch(
        ["@@ -1,4 +1,4 @@", "-before", "+after", " context", "-only removed"].join("\n"),
      ),
    ).toEqual({ added: 0, modified: 1, removed: 1 })
  })

  it("reads edit totals from canonical tool output and ignores unrelated units", () => {
    const patch = ["--- a/a", "+++ b/a", "@@ -1 +1 @@", "-before", "+after"].join("\n")
    expect(
      ThreadActivity.editTotals([
        assistantUnit("done"),
        toolUnit("tool-running", undefined),
        toolUnit("tool-plain", JSON.stringify({ text: patch })),
        toolUnit("tool-edited", JSON.stringify({ text: "edited", diff: patch })),
      ]),
    ).toEqual({ added: 0, modified: 1, removed: 0 })
  })

  it("accumulates every projected tool result diff in the turn", () => {
    expect(
      ThreadActivity.editTotals([
        toolUnit("one", JSON.stringify({ diff: ["--- a/a", "+++ b/a", "@@ -0,0 +1 @@", "+added"].join("\n") })),
        toolUnit("two", JSON.stringify({ diff: ["--- a/b", "+++ b/b", "@@ -1 +0,0 @@", "-gone"].join("\n") })),
      ]),
    ).toEqual({ added: 1, modified: 0, removed: 1 })
  })

  it("builds a replaceable terminal projection from the projected semantic model", () => {
    expect(
      ThreadActivity.projectionInput(
        { id: turnId, threadId, status: "completed", updatedAt: 12 },
        [toolUnit("one", JSON.stringify({ diff: ["--- a/a", "+++ b/a", "@@ -0,0 +1 @@", "+added"].join("\n") }))],
        20,
      ),
    ).toEqual({
      turnId,
      threadId,
      complete: true,
      editTotals: { added: 1, modified: 0, removed: 0 },
      lastEventAt: 12,
      now: 20,
    })
  })

  it("reports an unfinished turn as incomplete", () => {
    expect(
      ThreadActivity.projectionInput({ id: turnId, threadId, status: "running", updatedAt: 30 }, [], 40),
    ).toMatchObject({ complete: false, editTotals: { added: 0, modified: 0, removed: 0 }, lastEventAt: 30 })
  })
})
