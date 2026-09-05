import { expect, test } from "vitest"
import { initial, type Model } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"
import { buildTranscript } from "../../../src/opentui/rendering/renderer"

const agentTree = (): Model => ({
  ...initial("/work", "medium"),
  entries: [{ role: "assistant", text: "EXPLICIT_CHILD_ANSWER" }],
  blocks: [
    {
      _tag: "SubagentGroup",
      id: "group",
      name: "Reviewers",
      status: "running",
      settled: false,
      memberIds: ["parent"],
      counts: { total: 1, queued: 0, running: 1, waiting: 0, cancelling: 0, complete: 0, failed: 0, cancelled: 0 },
    },
    {
      _tag: "SubagentCard",
      id: "parent",
      name: "Task",
      prompt: "Review",
      promptTruncated: false,
      summary: "",
      status: "running",
      activity: [],
    },
    {
      _tag: "SubagentCard",
      id: "child",
      name: "Oracle",
      prompt: "Inspect",
      promptTruncated: false,
      summary: "",
      status: "complete",
      activity: [],
    },
  ],
  items: [
    { _tag: "Block", index: 0, id: "group" },
    { _tag: "Block", index: 1, id: "parent", parentId: "group" },
    { _tag: "Block", index: 2, id: "child", parentId: "parent" },
    { _tag: "Entry", index: 0, id: "answer", parentId: "child" },
  ],
})
const rendered = (model: Model) =>
  buildTranscript(model)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")
const settle = (model: Model): Model => ({
  ...model,
  blocks: model.blocks.map((block) => {
    if (block._tag === "SubagentGroup")
      return { ...block, status: "complete", settled: true, counts: { ...block.counts, running: 0, complete: 1 } }
    if (block._tag === "SubagentCard") return { ...block, status: "complete" }
    return block
  }),
})

test("keeps an explicitly opened completed child visible when every auto-expanded ancestor settles", () => {
  const before = agentTree()
  expect(rendered(before)).not.toContain("EXPLICIT_CHILD_ANSWER")
  const opened = update(before, { _tag: "DetailToggled", id: "subagent:child" })
  expect(rendered(opened)).toContain("EXPLICIT_CHILD_ANSWER")
  const settled = update(settle(opened), { _tag: "AnimationTicked" })
  expect(rendered(settled)).toContain("EXPLICIT_CHILD_ANSWER")
  expect(settled.expandedRowKeys).toEqual(
    expect.arrayContaining(["subagent-group:group", "subagent:parent", "subagent:child"]),
  )
  const collapsed = update(settled, { _tag: "DetailToggled", id: "subagent-group:group" })
  expect(rendered(update(collapsed, { _tag: "AnimationTicked" }))).not.toContain("EXPLICIT_CHILD_ANSWER")
  expect(rendered(update(collapsed, { _tag: "DetailToggled", id: "subagent-group:group" }))).toContain(
    "EXPLICIT_CHILD_ANSWER",
  )
})

test("still auto-collapses settled ancestors without an explicit expansion", () => {
  const settled = settle(agentTree())
  expect(settled.expandedRowKeys).toEqual([])
  expect(rendered(settled)).not.toContain("Oracle")
})

test("a single toggle collapses an auto-expanded nested agent and stays collapsed across updates", () => {
  const collapsed = update(agentTree(), { _tag: "DetailToggled", id: "subagent:parent" })
  expect(collapsed.explicitlyCollapsedRowKeys).toContain("subagent:parent")
  expect(rendered(update(collapsed, { _tag: "AnimationTicked" }))).not.toContain("Oracle")
})
