import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { asFileDiffMetadata, mountPierreDiff } from "../src/pierre-diff"

describe("Pierre diff adapter", () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://localhost:3000", width: 1280, height: 720 })
    if (globalThis.ResizeObserver === undefined) globalThis.ResizeObserver = NoopResizeObserver
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  test("mounts, updates, destroys, and leaves a recyclable container", () => {
    const container = document.createElement("div")
    const renderErrors: Array<string> = []
    document.body.append(container)

    const first = fileDiff("src/first.ts", 1, 1)
    const second = fileDiff("src/second.ts", 2, 0)
    const handle = mountPierreDiff({
      container,
      file_diff: first,
      theme_type: "dark",
      onRenderError: (message) => renderErrors.push(message),
    })

    expect(renderErrors).toEqual([])
    expect(container.childElementCount).toBeGreaterThan(0)
    expect(container.firstElementChild?.tagName).toBe("DIFFS-CONTAINER")

    try {
      handle.update(second)

      expect(renderErrors).toEqual([])
      expect(container.childElementCount).toBeGreaterThan(0)
    } finally {
      handle.destroy()
    }

    expect(container.childElementCount).toBe(0)

    const next = mountPierreDiff({
      container,
      file_diff: first,
      theme_type: "light",
      onRenderError: (message) => renderErrors.push(message),
    })

    try {
      expect(renderErrors).toEqual([])
      expect(container.childElementCount).toBeGreaterThan(0)
    } finally {
      next.destroy()
    }
  })

  test("decodes explicit language hints", () => {
    expect(asFileDiffMetadata({ ...fileDiff("component.view", 1, 0), lang: "tsx" })?.lang).toBe("tsx")
  })
})

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const fileDiff = (name: string, additions: number, deletions: number) => ({
  name,
  type: "change" as const,
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
      hunkContent: [{ type: "change" as const, deletions, deletionLineIndex: 0, additions, additionLineIndex: 0 }],
      splitLineStart: 0,
      splitLineCount: additions + deletions,
      unifiedLineStart: 0,
      unifiedLineCount: additions + deletions,
      noEOFCRDeletions: false,
      noEOFCRAdditions: false,
    },
  ],
})
