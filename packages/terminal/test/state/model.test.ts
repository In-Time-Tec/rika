import { describe, expect, test } from "vitest"
import { buildTranscript } from "../../src/opentui/rendering/renderer"
import { initial, type Model } from "../../src/state/model"
import { Model as ModelSchema } from "../../src/state/model"
import { Schema } from "effect"
import { readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { transcriptUnitRevision } from "../../src/opentui/rendering/transcript/revision"
import { transcriptUnitId, transcriptUnits } from "../../src/presentation/transcript/row"
import type { TranscriptBlock } from "../../src/state/transcript/model"

const webBlock = {
  _tag: "ToolCall" as const,
  id: "web-1",
  name: "read_web_page",
  input: '{"url":"https://example.com"}',
  status: "complete" as const,
  presentation: {
    family: "direct" as const,
    action: "read-web-page" as const,
    activeLabel: "Reading",
    completeLabel: "Read",
    outputDisplay: "expandable" as const,
  },
  detail: "https://example.com",
  files: [],
  result: { text: "# Heading\n\nSome **bold** text." },
}

const model = (expanded: ReadonlyArray<string>): Model => ({
  ...initial("/workspace", "medium"),
  width: 100,
  blocks: [webBlock],
  entries: [],
  items: [{ _tag: "Block", index: 0, id: "web", turnId: "turn" }],
  expandedRowKeys: expanded,
})

const rendered = (current: Model) =>
  buildTranscript(current)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

describe("web page tool output", () => {
  test("is expandable rather than hidden", () => {
    const collapsed = rendered(model([]))
    expect(collapsed).toContain("Read https://example.com")
    expect(collapsed).not.toContain("Heading")
  })

  test("renders markdown instead of raw source when expanded", () => {
    const output = rendered(model(["tool:web-1"]))
    expect(output).toContain("Heading")
    expect(output).toContain("bold")
    expect(output).not.toContain("**bold**")
    expect(output).not.toContain("# Heading")
  })
})

const toolBlock = (id: string, status: "running" | "complete"): TranscriptBlock => ({
  _tag: "ToolCall",
  id,
  name: "bash",
  input: '{"command":"git status"}',
  status,
  presentation: { family: "direct", action: "shell", activeLabel: "Running", completeLabel: "Ran" },
  detail: "",
  files: [],
})

const unitRevisionOf = (blocks: ReadonlyArray<TranscriptBlock>, expanded: ReadonlySet<string>): string => {
  const current: Model = {
    ...initial("/workspace", "medium"),
    width: 100,
    blocks: [...blocks],
    entries: [],
    items: blocks.map((_, index) => ({ _tag: "Block" as const, index })),
  }
  const unit = transcriptUnits(current).find((candidate) => candidate.kind === "tool")
  if (unit === undefined) throw new Error("expected a tool unit")
  return transcriptUnitRevision(current, unit, transcriptUnitId(current, unit), expanded)
}

describe("typed transcript model", () => {
  test("stores typed transcript blocks and items in the terminal model", () => {
    const base = initial("/workspace", "medium")
    expect(() => Schema.decodeUnknownSync(ModelSchema)({ ...base, blocks: [42] })).toThrow()
    expect(() => Schema.decodeUnknownSync(ModelSchema)({ ...base, items: ["not-an-item"] })).toThrow()
    const typed: Model = {
      ...base,
      blocks: [toolBlock("tool-1", "running")],
      items: [{ _tag: "Block" as const, index: 0 }],
    }
    expect(() => Schema.decodeUnknownSync(ModelSchema)(typed)).not.toThrow()
  })

  test("forbid Schema decoding in terminal render hot paths", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
    const hotPaths = [
      "packages/terminal/src/opentui",
      "packages/terminal/src/presentation/transcript/viewport",
      "packages/terminal/src/presentation/transcript/row.ts",
      "packages/terminal/src/state/activity/model.ts",
      "packages/terminal/src/presentation/transcript/agent-response.ts",
      "packages/terminal/src/presentation/transcript/projection-outcomes.ts",
      "packages/terminal/src/presentation/transcript/tool/detail.ts",
    ]
    const boundaryPaths = [
      "packages/terminal/src/state/transcript/model.ts",
      "packages/terminal/src/state/thread/model.ts",
      "packages/terminal/src/state/reducer/data.ts",
    ]
    for (const boundary of boundaryPaths) {
      expect(hotPaths.some((hot) => boundary === hot || boundary.startsWith(`${hot}/`))).toBe(false)
      expect(readFileSync(path.join(root, boundary), "utf8")).toContain("decodeUnknownSync")
    }
    const decodePattern = /Schema\.(decodeSync|decodeUnknownSync|decodeUnknownOption|decodeUnknownExit|is)\s*\(/g
    const collectFiles = (target: string): Array<string> => {
      const absolute = path.join(root, target)
      if (statSync(absolute).isDirectory()) {
        return readdirSync(absolute, { withFileTypes: true })
          .sort((first, second) => (first.name < second.name ? -1 : 1))
          .flatMap((entry) => collectFiles(path.join(target, entry.name)))
          .filter((file) => file.endsWith(".ts"))
      }
      return [target]
    }
    const violations: Array<string> = []
    for (const target of hotPaths) {
      for (const file of collectFiles(target)) {
        const source = readFileSync(path.join(root, file), "utf8")
        const matches = source.matchAll(decodePattern)
        for (const match of matches) {
          const line = source.slice(0, match.index).split("\n").length
          violations.push(`${file}:${line}: ${match[1]}`)
        }
      }
    }
    violations.sort()
    expect(violations).toEqual([])
  })

  test("uses semantic revisions instead of object identity for transcript cache invalidation", () => {
    const running = toolBlock("tool-1", "running")
    const first = unitRevisionOf([running], new Set())
    expect(unitRevisionOf([running], new Set())).toBe(first)
    expect(unitRevisionOf([{ ...running }], new Set())).toBe(first)
    expect(unitRevisionOf([running], new Set(["tool:tool-1"]))).not.toBe(first)
    expect(unitRevisionOf([{ ...running, status: "complete" }], new Set())).not.toBe(first)
  })
})
