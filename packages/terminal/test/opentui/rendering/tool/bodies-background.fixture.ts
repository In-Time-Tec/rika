import { expect, test } from "vitest"
import { initial } from "../../../../src/state/model"
import { _streamingShell } from "./detail.fixture"
import { fg, type TextChunk } from "@opentui/core"
import { createToolBodyRenderer } from "../../../../src/opentui/rendering/tool/bodies"
import { shellMetadata, type ToolUnit } from "../../../../src/opentui/rendering/tool/detail"
import { rowStatusIcon } from "../../../../src/opentui/rendering/window"
import { colors } from "../../../../src/presentation/terminal/theme"

const command = (status: ToolUnit["block"]["status"], background: boolean): ToolUnit => ({
  kind: "shell",
  index: 0,
  block: {
    ..._streamingShell("job", "output"),
    result: { text: "output" },
    status,
    process: { command: "printf job", background, workdir: "/work" },
  },
})

const render = (units: ReadonlyArray<ToolUnit>, selected: boolean, expanded: boolean) => {
  const chunks: Array<TextChunk> = []
  const renderer = createToolBodyRenderer({
    model: initial("/work"),
    spinnerFrame: "S",
    append: (chunk) => {
      chunks.push(chunk)
    },
    appendAll: (text) => {
      chunks.push(...text.chunks)
    },
    line: () =>
      chunks
        .map((chunk) => chunk.text)
        .join("")
        .split("\n").length - 1,
    mark: () => chunks.length,
    disclose: () => undefined,
    nestedRanges: [],
    rowExpanded: () => expanded,
    rowExplicitlyCollapsed: () => false,
    highlight: (text) => {
      chunks.push(fg(colors.blue)(text))
    },
    statusIcon: (status) => fg(colors.blue)(rowStatusIcon(status, "S")),
  })
  renderer.renderShellBody(units, selected, expanded)
  return chunks.map((chunk) => chunk.text).join("")
}

export const backgroundCommandTests = () => {
  for (const selected of [false, true]) {
    test(`distinguishes foreground and background commands and restores terminal icons (selected ${selected})`, () => {
      expect(render([command("running", false)], selected, false)).toContain("S $ printf job")
      const background = render([command("running", true)], selected, false)
      expect(background).toContain("⇢ $ printf job")
      expect(background).not.toContain("detached")
      for (const [status, icon] of [
        ["complete", "✓"],
        ["failed", "✕"],
        ["cancelled", "⊘"],
      ] as const) {
        const terminal = render([command(status, true)], selected, true)
        expect(terminal).toContain(`${icon} $ printf job`)
        expect(terminal).not.toContain("⇢")
      }
    })

    test(`renders background group headers and children without foreground spinners (selected ${selected})`, () => {
      const group = render([command("running", true), command("running", true)], selected, true)
      expect(group).toContain("⇢ Running 2 background commands")
      expect(group.match(/⇢ \$/g)).toHaveLength(2)
      const mixed = render([command("running", true), command("running", false)], selected, true)
      expect(mixed).toContain("S Running 2 commands")
      expect(mixed).toContain("⇢ $ printf job")
      expect(mixed).toContain("S $ printf job")
    })
  }

  test("shell metadata retains cwd and script without a detached subtext row", () => {
    const unit = command("running", true)
    expect(shellMetadata({ ...unit.block, process: { ...unit.block.process, command: "echo one\necho two" } })).toEqual(
      ["cwd /work", "script"],
    )
  })
}
