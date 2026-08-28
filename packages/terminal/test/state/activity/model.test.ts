import { describe, expect, test } from "vitest"
import { formatActivity, runningToolsActivity } from "../../../src/state/activity/model"
import { initial, type Model } from "../../../src/state/model"
import type { TranscriptItem } from "../../../src/state/transcript/model"

const cell = (id: string, status: string) => ({
  _tag: "Cell",
  id,
  status,
  visual: "ts",
  source: { text: "await work()", lines: 1, truncated: false },
  output: { stdout: "", stderr: "", droppedBytes: 0, droppedEvents: 0 },
  epoch: 0,
  notices: [],
  calls: [],
  files: [],
})

const card = (id: string, status: string) => ({
  _tag: "SubagentCard",
  id,
  name: "Task",
  prompt: "p",
  promptTruncated: false,
  summary: "",
  status,
  activity: [],
})

type ActivityBlock = ReturnType<typeof cell> | ReturnType<typeof card>

const model = (blocks: ReadonlyArray<ActivityBlock>, items: ReadonlyArray<TranscriptItem>): Model => ({
  ...initial("/work"),
  blocks: [...blocks],
  entries: [],
  items: [...items],
  width: 100,
  expandedRowKeys: [],
})

const block = (index: number, id: string, parentId?: string) =>
  parentId === undefined
    ? ({ _tag: "Block", index, id } satisfies TranscriptItem)
    : ({ _tag: "Block", index, id, parentId } satisfies TranscriptItem)

const activityOf = (blocks: ReadonlyArray<ActivityBlock>, items: ReadonlyArray<TranscriptItem>) =>
  formatActivity(runningToolsActivity(model(blocks, items)))

describe("running subagent activity", () => {
  test("counts a running subagent card", () => {
    expect(activityOf([cell("k", "complete"), card("c", "running")], [block(0, "k"), block(1, "c", "k")])).toBe(
      "Running 1 subagent",
    )
  })

  test("counts each concurrently admitted child once", () => {
    expect(
      activityOf(
        [cell("k", "complete"), card("a", "running"), card("b", "running")],
        [block(0, "k"), block(1, "a", "k"), block(2, "b", "k")],
      ),
    ).toBe("Running 2 subagents")
  })

  test("does not count a queued child as running", () => {
    expect(activityOf([cell("k", "complete"), card("c", "queued")], [block(0, "k"), block(1, "c", "k")])).toBe(
      "Running tools",
    )
  })

  test("leaves a nested child to the subagent that owns it", () => {
    expect(
      activityOf(
        [cell("k", "complete"), card("task", "running"), cell("tk", "running"), card("oracle", "running")],
        [
          block(0, "root-cell-unit"),
          block(1, "task-card-unit", "k"),
          block(2, "task-cell-unit", "task"),
          block(3, "oracle-card-unit", "task"),
        ],
      ),
    ).toBe("Running 1 subagent")
  })

  test("stops counting a card once it settles", () => {
    expect(activityOf([cell("k", "complete"), card("c", "complete")], [block(0, "k"), block(1, "c", "k")])).toBe(
      "Running tools",
    )
  })

  test("still counts a running cell as a tool", () => {
    expect(activityOf([cell("k", "running")], [block(0, "k")])).toBe("Running 1 tool")
  })
})
