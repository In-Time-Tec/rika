import { describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import type { Common } from "@rika/schema"

const requestedLanguages: Array<string> = []

void mock.module("@pierre/diffs", () => ({
  getFiletypeFromFileName: () => "markdown",
  getSharedHighlighter: async (options: { readonly langs: ReadonlyArray<string> }) => {
    requestedLanguages.push(options.langs[0] ?? "")
    return {}
  },
  renderDiffWithHighlighter: () => ({ code: { additionLines: [], deletionLines: [] } }),
}))

const { DiffRenderCache } = await import("../src/diff-renderer")

describe("TUI diff renderer", () => {
  test("uses explicit Pierre diff language hints", async () => {
    const cache = new DiffRenderCache()

    await Effect.runPromise(cache.ensure({ ...fileDiff("component.view", 1, 0), lang: "tsx" }))

    expect(requestedLanguages).toEqual(["tsx"])
  })
})

const fileDiff = (name: string, additions: number, deletions: number): Record<string, Common.JsonValue> => ({
  name,
  type: "change",
  splitLineCount: additions + deletions,
  unifiedLineCount: additions + deletions,
  isPartial: false,
  deletionLines: Array.from({ length: deletions }, (_, index) => `before ${index}`),
  additionLines: Array.from({ length: additions }, (_, index) => `after ${index}`),
  hunks: [
    {
      collapsedBefore: 0,
      additionStart: 1,
      additionCount: additions,
      additionLines: additions,
      additionLineIndex: 0,
      deletionStart: 1,
      deletionCount: deletions,
      deletionLines: deletions,
      deletionLineIndex: 0,
      hunkContent: [{ type: "change", deletions, deletionLineIndex: 0, additions, additionLineIndex: 0 }],
      splitLineStart: 0,
      splitLineCount: additions + deletions,
      unifiedLineStart: 0,
      unifiedLineCount: additions + deletions,
      noEOFCRDeletions: false,
      noEOFCRAdditions: false,
    },
  ],
})
