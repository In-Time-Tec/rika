import { describe, expect, test } from "vitest"
import { buildTranscript } from "../src/opentui/rendering/opentui-renderer"
import { transcriptUnitRevision } from "../src/opentui/rendering/opentui-render-transcript-revision"
import { shellCommandText } from "../src/opentui/rendering/opentui-render-tool-detail"
import { transcriptUnitId, transcriptUnits } from "../src/presentation/transcript/transcript-row"
import { initial, type Model } from "../src/state/model/terminal-state"
import type { TranscriptBlock } from "../src/state/model/terminal-transcript-state"

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

const nested = (input: string): TranscriptBlock => ({
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

  test("changes when the streamed answer entry changes", () => {
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
  test("renders a partially streamed command", () => {
    expect(shellCommandText(nested('{"command":"git sta') as never)).toBe("git sta")
  })

  test("renders a complete command", () => {
    expect(shellCommandText(nested('{"command":"git status"}') as never)).toBe("git status")
  })

  test("stays empty before any argument text arrives", () => {
    expect(shellCommandText(nested('{"comm') as never)).toBe("")
  })
})
