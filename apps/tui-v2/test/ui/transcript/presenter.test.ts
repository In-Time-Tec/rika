import { expect, it } from "@effect/vitest"
import { buildTranscriptGroups, toolPresentation } from "../../../src/ui/transcript/presenter"
import type { TranscriptItem } from "../../../src/client/model"

it("uses the read action and source path instead of words and imports inside source content", () => {
  const item: TranscriptItem = {
    id: "read-source",
    kind: "tool",
    title: "Read apps/tui-v2/src/app.tsx",
    text: 'import { patch } from "./edit.ts"\nconst command = "grep test"',
  }
  const presentation = toolPresentation(item)
  expect(presentation.family).toBe("explore")
  expect(presentation.action).toBe("read")
  expect(presentation.paths[0]).toBe("apps/tui-v2/src/app.tsx")
  expect(presentation.command).toBeUndefined()
})

it("keeps read and shell groups separate and retains command output", () => {
  const groups = buildTranscriptGroups([
    { id: "a", kind: "tool", title: "Read AGENTS.md", text: "Read project instructions" },
    { id: "b", kind: "tool", title: "Read PRODUCT.md", text: "Product direction" },
    { id: "c", kind: "tool", title: "bash", text: "$ bun run typecheck\nPassed" },
  ])
  expect(groups).toHaveLength(2)
  expect(groups[0]?.kind).toBe("tools")
  if (groups[0]?.kind === "tools") expect(groups[0].items).toHaveLength(2)
  expect(groups[1]?.kind).toBe("tools")
  if (groups[1]?.kind === "tools") {
    expect(groups[1].items[0]?.command).toBe("bun run typecheck")
    expect(groups[1].items[0]?.output).toBe("Passed")
  }
})
