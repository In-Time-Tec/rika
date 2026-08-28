import { describe, expect, test } from "vitest"
import { isExpandableBody, toolBody } from "../../../../src/presentation/transcript/tool/body"
import type { TranscriptBlock } from "../../../../src/state/transcript/model"

const call = (
  overrides: Partial<Extract<TranscriptBlock, { _tag: "ToolCall" }>> & {
    readonly action: string
  },
): Extract<TranscriptBlock, { _tag: "ToolCall" }> => {
  const { action, ...rest } = overrides
  const toolCall: Extract<TranscriptBlock, { _tag: "ToolCall" }> = {
    _tag: "ToolCall",
    id: "tool-1",
    name: "tool",
    input: "{}",
    status: "complete",
    presentation: { family: "direct", action, activeLabel: "Running", completeLabel: "Ran" },
    detail: "",
    files: [],
    ...rest,
  }
  return toolCall
}

describe("tool body contract", () => {
  test("a tool with no output has no body and is not expandable", () => {
    const body = toolBody(call({ action: "shell" }))
    expect(body._tag).toBe("None")
    expect(isExpandableBody(body)).toBe(false)
  })

  test("a typed read result renders its text directly", () => {
    const body = toolBody(
      call({ action: "read", input: '{"path":"src/a.ts"}', result: { text: "100: const a = 1\n101: const b = 2" } }),
    )
    expect(body).toEqual({ _tag: "Text", text: "100: const a = 1\n101: const b = 2" })
  })

  test("a web page decodes to Markdown", () => {
    const body = toolBody(call({ action: "read-web-page", result: { text: "# Title" } }))
    expect(body).toMatchObject({ _tag: "Markdown", source: "# Title" })
  })

  test("a file edit decodes to a Patch", () => {
    const body = toolBody(
      call({
        action: "edit",
        files: [
          {
            key: "tool-1:0",
            path: "src/a.ts",
            kind: "update",
            patch: "@@ -1 +1 @@",
            additions: 1,
            deletions: 1,
            preview: false,
            status: "complete",
          },
        ],
      }),
    )
    expect(body).toMatchObject({ _tag: "Patch", path: "src/a.ts" })
  })

  test("anything else with output decodes to Text and is expandable", () => {
    const body = toolBody(call({ action: "shell", result: { text: "hello" } }))
    expect(body).toMatchObject({ _tag: "Text", text: "hello" })
    expect(isExpandableBody(body)).toBe(true)
  })
})
