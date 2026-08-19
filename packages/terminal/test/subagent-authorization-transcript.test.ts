import { describe, expect, test } from "vitest"
import { buildTranscript } from "../src/opentui/rendering/opentui-renderer"
import { expandableRowIds, transcriptUnitId, transcriptUnits } from "../src/presentation/transcript/transcript-row"
import { initial, type Model } from "../src/state/model/terminal-state"
import { update } from "../src/state/reducer/terminal-state-reducer"
import type { Key } from "../src/presentation/terminal/terminal-keymap"

const rendered = (model: Model) =>
  buildTranscript(model)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")
const key = (name: string): Key => ({
  name,
  sequence: name,
  ctrl: false,
  alt: false,
  meta: false,
  shift: false,
  eventType: "press",
})

const model = (): Model => ({
  ...initial("/workspace", "medium"),
  width: 100,
  blocks: [
    {
      _tag: "SubagentCard",
      id: "subagent-local",
      name: "Review",
      prompt: "Review correctness",
      promptTruncated: false,
      summary: "",
      status: "running",
      activity: [],
    },
    {
      _tag: "ToolCall",
      id: "nested-read",
      name: "read",
      input: "{}",
      status: "running",
      presentation: { family: "direct", action: "read", activeLabel: "Reading", completeLabel: "Read" },
      detail: "src/index.ts",
      files: [],
    },
    {
      _tag: "AuthorizationCard",
      id: "authorization-local",
      operation: "write",
      capability: "workspace",
      input: '{"path":"src/index.ts"}',
      inputTruncated: false,
      status: "pending",
    },
  ],
  entries: [{ role: "assistant", text: "Checking this now", turnId: "turn" }],
  items: [
    { _tag: "Block", index: 0, id: "card", turnId: "turn" },
    { _tag: "Block", index: 1, id: "nested", turnId: "turn", parentId: "subagent-local" },
    { _tag: "Entry", index: 0, id: "response", turnId: "turn", parentId: "subagent-local" },
    { _tag: "Block", index: 2, id: "authorization", turnId: "turn" },
  ],
})

describe("semantic subagent and authorization transcript rows", () => {
  test("a running subagent is expandable with nested tools and live output", () => {
    const collapsed = model()
    const subagent = transcriptUnits(collapsed).find((unit) => unit.kind === "subagent")
    expect(subagent).toMatchObject({ kind: "subagent", children: [{ blocks: [1] }] })
    expect(expandableRowIds(collapsed)).toContain("subagent:subagent-local")
    const expanded = { ...collapsed, expandedRowKeys: [transcriptUnitId(collapsed, subagent!)] }
    const output = rendered(expanded)
    expect(output).toContain("Review correctness")
    expect(output).toContain("src/index.ts")
    expect(output).toContain("Checking this now")
  })

  test("renders a nested subagent card on its parent's recursive timeline", () => {
    const base = model()
    const nested: Model = {
      ...base,
      blocks: [
        ...base.blocks,
        {
          _tag: "SubagentCard",
          id: "nested-subagent",
          name: "Nested survey",
          prompt: "Inspect the nested boundary",
          promptTruncated: false,
          summary: "",
          status: "queued",
          activity: [],
        },
      ],
      items: [
        ...base.items,
        {
          _tag: "Block",
          index: base.blocks.length,
          id: "nested-subagent-unit",
          turnId: "turn",
          parentId: "subagent-local",
        },
      ],
      expandedRowKeys: ["subagent:subagent-local"],
    }
    const parent = transcriptUnits(nested).find((unit) => unit.kind === "subagent")
    expect(parent).toMatchObject({
      kind: "subagent",
      children: [{ kind: "tool" }, { kind: "subagent", block: 3, children: [] }],
    })
    expect(expandableRowIds(nested)).toContain("subagent:nested-subagent")
    expect(rendered(nested)).toContain("◷ Nested survey queued")
  })

  test("only a selected pending authorization with an empty composer offers typed controls", () => {
    const collapsed = model()
    const collapsedOutput = rendered(collapsed)
    expect(collapsedOutput).not.toContain("authorization-local")
    expect(collapsedOutput).not.toContain("[a] Approve")

    const selected = { ...collapsed, detailSelection: "block:authorization" }
    expect(rendered(selected)).toContain("[a] Approve   [d] Deny")
    expect(update(selected, { _tag: "KeyPressed", key: key("a") }).pendingAction).toEqual({
      _tag: "ApproveAuthorization",
      turnId: "turn",
      authorizationId: "authorization-local",
    })
    expect(update(selected, { _tag: "KeyPressed", key: key("d") }).pendingAction).toEqual({
      _tag: "DenyAuthorization",
      turnId: "turn",
      authorizationId: "authorization-local",
    })

    const composing = { ...selected, input: "draft", cursor: 5 }
    expect(rendered(composing)).not.toContain("[a] Approve")
    expect(update(composing, { _tag: "KeyPressed", key: key("a") }).pendingAction).toBeUndefined()
    const settled: Model = {
      ...selected,
      blocks: [
        selected.blocks[0],
        selected.blocks[1],
        {
          _tag: "AuthorizationCard",
          id: "authorization-local",
          operation: "write",
          capability: "workspace",
          input: '{"path":"src/index.ts"}',
          inputTruncated: false,
          status: "approved",
        },
      ],
    }
    expect(rendered(settled)).not.toContain("[a] Approve")
  })
})
