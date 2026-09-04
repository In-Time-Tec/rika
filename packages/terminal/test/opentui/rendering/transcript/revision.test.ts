import { describe, expect, test } from "vitest"
import { buildTranscript } from "../../../../src/opentui/rendering/renderer"
import { buildTentativeTranscriptUnitBundles } from "../../../../src/opentui/surface/transcript/rendering-models"
import {
  transcriptUnitRevision,
  type TranscriptUnitCacheEntry,
} from "../../../../src/opentui/rendering/transcript/revision"
import { shellCommandText } from "../../../../src/opentui/rendering/tool/detail"
import { transcriptUnitId, transcriptUnits } from "../../../../src/presentation/transcript/row"
import { initial, type Model } from "../../../../src/state/model"
import type { TranscriptBlock } from "../../../../src/state/transcript/model"

const card: TranscriptBlock = {
  _tag: "SubagentCard",
  id: "subagent-local",
  name: "Review",
  prompt: "Review correctness",
  promptTruncated: false,
  summary: "",
  status: "running",
  activity: [],
}

const nested = (input: string): Extract<TranscriptBlock, { _tag: "ToolCall" }> => ({
  _tag: "ToolCall",
  id: "nested-shell",
  name: "bash",
  input,
  status: "running",
  presentation: { family: "direct", action: "shell", activeLabel: "Running", completeLabel: "Ran" },
  detail: "",
  files: [],
})

const model = (nestedInput: string, answer: string): Model => ({
  ...initial("/workspace", "medium"),
  width: 100,
  blocks: [card, nested(nestedInput)],
  entries: [{ role: "assistant", text: answer, turnId: "turn" }],
  items: [
    { _tag: "Block", index: 0, id: "card", turnId: "turn" },
    { _tag: "Block", index: 1, id: "nested", turnId: "turn", parentId: "subagent-local" },
    { _tag: "Entry", index: 0, id: "response", turnId: "turn", parentId: "subagent-local" },
  ],
  expandedRowKeys: ["subagent:subagent-local"],
})

const subagentRevision = (current: Model): string => {
  const unit = transcriptUnits(current).find((candidate) => candidate.kind === "subagent")
  if (unit === undefined) throw new Error("expected a subagent unit")
  const key = transcriptUnitId(current, unit)
  return transcriptUnitRevision(current, unit, key, new Set(current.expandedRowKeys))
}

describe("subagent unit revision", () => {
  test("changes when a nested child block streams", () => {
    const before = model('{"command":"ls"}', "working")
    const after = { ...before, blocks: [card, nested('{"command":"ls -la"}')] }
    expect(subagentRevision(after)).not.toBe(subagentRevision(before))
  })

  test("changes when a running SubagentCard answer streams", () => {
    const before = model('{"command":"ls"}', "working")
    const after = { ...before, entries: [{ role: "assistant" as const, text: "done", turnId: "turn" }] }
    expect(subagentRevision(after)).not.toBe(subagentRevision(before))
  })

  test("is stable when nothing changed", () => {
    const current = model('{"command":"ls"}', "working")
    expect(subagentRevision(current)).toBe(subagentRevision(current))
  })

  test("renders queued subagents without animation and invalidates the row when they start", () => {
    const running = model('{"command":"ls"}', "")
    const queued = { ...running, blocks: [{ ...card, status: "queued" as const }, running.blocks[1]!] }
    const rendered = buildTranscript(queued)
      .styled.chunks.map((chunk) => chunk.text)
      .join("")

    expect(rendered).toContain("◷ Review queued")
    expect(subagentRevision(queued)).not.toBe(subagentRevision(running))
  })

  test("renders a complete long final response instead of only its suffix", () => {
    const response = `BEGIN_LONG_RESPONSE\n${"complete paragraph. ".repeat(700)}\nEND_LONG_RESPONSE`
    const current = model('{"command":"ls"}', response)
    const settled = { ...current, blocks: [{ ...card, status: "complete" as const }, current.blocks[1]!] }
    const rendered = buildTranscript(settled)
      .styled.chunks.map((chunk) => chunk.text)
      .join("")
    expect(response.length).toBeGreaterThan(8_192)
    expect(rendered).toContain("BEGIN_LONG_RESPONSE")
    expect(rendered).toContain("END_LONG_RESPONSE")
  })
})

describe("shell command text", () => {
  test("does not parse an incomplete command payload", () => {
    expect(shellCommandText(nested('{"command":"git sta'))).toBe("")
  })

  test("renders a complete command", () => {
    expect(shellCommandText(nested('{"command":"git status"}'))).toBe("git status")
  })

  test("stays empty before any argument text arrives", () => {
    expect(shellCommandText(nested('{"comm'))).toBe("")
  })
})

describe("subagent group revision (defect #359)", () => {
  const counts = (overrides: Record<string, number> = {}) => ({
    total: 2,
    queued: 0,
    running: 0,
    waiting: 0,
    cancelling: 0,
    complete: 0,
    failed: 0,
    cancelled: 0,
    ...overrides,
  })
  const groupModel = (): Model => {
    const group: TranscriptBlock = {
      _tag: "SubagentGroup",
      id: "group",
      name: "2 agents",
      status: "running",
      settled: false,
      memberIds: ["one", "two"],
      counts: counts({ running: 1, complete: 1 }),
    }
    const one: TranscriptBlock = {
      _tag: "SubagentCard",
      id: "one",
      name: "Oracle",
      prompt: "Review the design",
      promptTruncated: false,
      summary: "",
      status: "running",
      activity: [],
    }
    const two: TranscriptBlock = {
      _tag: "SubagentCard",
      id: "two",
      name: "Task",
      prompt: "Run the tests",
      promptTruncated: false,
      summary: "",
      status: "complete",
      activity: [],
    }
    return {
      ...initial("/workspace", "medium"),
      width: 100,
      blocks: [group, one, two],
      entries: [{ role: "assistant", text: "partial answer", turnId: "turn" }],
      items: [
        { _tag: "Block", index: 0, id: "group", turnId: "turn" },
        { _tag: "Block", index: 1, id: "one", turnId: "turn", parentId: "group" },
        { _tag: "Entry", index: 0, id: "one-answer", turnId: "turn", parentId: "one" },
        { _tag: "Block", index: 2, id: "two", turnId: "turn", parentId: "group" },
      ],
      expandedRowKeys: ["subagent-group:group"],
    }
  }
  const groupRevision = (current: Model): string => {
    const unit = transcriptUnits(current).find((candidate) => candidate.kind === "subagent-group")
    if (unit === undefined) throw new Error("expected a subagent-group unit")
    return transcriptUnitRevision(current, unit, transcriptUnitId(current, unit), new Set(current.expandedRowKeys))
  }

  test("changes the group render revision when only counts change", () => {
    const current = groupModel()
    const before = groupRevision(current)
    const group = current.blocks[0]
    if (group?._tag !== "SubagentGroup") throw new Error("expected a SubagentGroup block")
    group.counts = counts({ complete: 2 })
    expect(groupRevision(current)).not.toBe(before)
  })

  test("changes the group render revision when one child status changes", () => {
    const current = groupModel()
    const before = groupRevision(current)
    const one = current.blocks[1]
    if (one?._tag !== "SubagentCard") throw new Error("expected a SubagentCard block")
    one.status = "waiting"
    expect(groupRevision(current)).not.toBe(before)
  })

  test("renders tentative and durable reasoning with the same normalized rows", () => {
    const source = `**Inspecting repository state**
The first logical line.
The second logical line.
- Validate the reducer.
- Validate the renderer.

| Area | Result |
|---|---|
| State | valid |

\`\`\`ts
const marker = "*inside code*"
\`\`\``
    const durable: Model = {
      ...initial("/workspace", "medium"),
      width: 80,
      blocks: [{ _tag: "Reasoning", id: "reasoning-canonical", text: source }],
      items: [{ _tag: "Block", index: 0, id: "reasoning-canonical", turnId: "turn" }],
    }
    const durableRows = buildTranscript(durable)
      .styled.chunks.map((chunk) => chunk.text)
      .join("")
      .split("\n")
    let cached: TranscriptUnitCacheEntry | undefined
    for (let end = 1; end <= source.length; end += 1)
      cached = buildTentativeTranscriptUnitBundles({
        key: "block:tentative:reasoning",
        text: source.slice(0, end),
        width: 76,
        tone: "reasoning",
        revision: `r${end}`,
        cached,
      })
    const tentativeRows = (cached?.bundles ?? [])
      .flatMap((bundle) => bundle.descriptors)
      .map((descriptor) => descriptor.content.chunks.map((chunk) => chunk.text).join(""))
      .join("\n")
      .split("\n")
    const normalized = (rows: ReadonlyArray<string>): ReadonlyArray<string> => {
      let start = 0
      let end = rows.length
      while (start < end && (rows[start] ?? "").trim().length === 0) start += 1
      while (end > start && (rows[end - 1] ?? "").trim().length === 0) end -= 1
      return rows.slice(start, end)
    }
    expect(normalized(tentativeRows)).toEqual(normalized(durableRows))
  })
})
