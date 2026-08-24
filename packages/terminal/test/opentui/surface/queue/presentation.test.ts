import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../../../src/opentui/surface/service"
import { colors } from "../../../../src/presentation/terminal/theme"
import { initial, type Model } from "../../../../src/state/model"
import { update } from "../../../../src/state/reducer/model"
import {
  openTui,
  _insertText,
  styledTextValue,
  _streamingShell,
  _giantSubagentModel,
  _collapsedSubagentModel,
} from "./presentation.fixture"
test("renders a subagent tool tree and expands each child independently", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 32 }))
      const presentation = {
        agent: {
          family: "agent" as const,
          action: "oracle",
          activeLabel: "Oracle exploring",
          completeLabel: "Oracle has spoken",
        },
        explore: {
          family: "explore" as const,
          action: "read",
          activeLabel: "Exploring",
          completeLabel: "Explored",
          counter: "file" as const,
        },
        shell: {
          family: "shell" as const,
          action: "command",
          activeLabel: "Running",
          completeLabel: "Ran",
        },
      }
      let model: Model = {
        ...initial("/work", "high"),
        width: 80,
        height: 32,
        entries: [
          {
            role: "assistant",
            text: "## Review complete\n\n**No defects found.**",
            turnId: "child:oracle",
          },
        ],
        blocks: [
          {
            _tag: "ToolCall",
            id: "oracle-parent",
            name: "oracle",
            input: '{"prompt":"Review the code"}',
            status: "complete",
            presentation: presentation.agent,
            detail: "Review the code",
            childId: "child:oracle",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-read",
            name: "read",
            input: '{"path":"src/a.ts","offset":2,"limit":3}',
            output: "read child output",
            status: "complete",
            presentation: presentation.explore,
            detail: "src/a.ts L2-4",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-agent",
            name: "task",
            input: '{"prompt":"Explore packages"}',
            status: "complete",
            presentation: {
              family: "agent",
              action: "task",
              activeLabel: "Subagent working",
              completeLabel: "Subagent finished",
            },
            detail:
              "Read-only explore packages/configuration, extensions, and tools. Report concise public responsibilities with source-file evidence.",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-shell",
            name: "bash",
            input: '{"command":"bun test"}',
            output: "shell child output",
            status: "complete",
            presentation: presentation.shell,
            detail: "bun test",
            files: [],
          },
        ],
        items: [
          { _tag: "Block", index: 0, id: "tool:oracle-parent", turnId: "turn" },
          { _tag: "Block", index: 1, id: "tool:child-read", turnId: "child:oracle", parentId: "oracle-parent" },
          { _tag: "Block", index: 2, id: "tool:child-agent", turnId: "child:oracle", parentId: "oracle-parent" },
          { _tag: "Block", index: 3, id: "tool:child-shell", turnId: "child:oracle", parentId: "oracle-parent" },
          {
            _tag: "Entry",
            index: 0,
            id: "assistant:child:oracle:0",
            turnId: "child:oracle",
            parentId: "oracle-parent",
          },
        ],
        expandedRowKeys: ["tool:oracle-parent"],
      }
      const opened: Array<{ readonly path: string; readonly line?: number; readonly column?: number }> = []
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        openPath: (target) => opened.push(target),
        clickToggle: (unit) => {
          model = update(model, { _tag: "DetailToggled", id: unit })
          surface.update(model)
        },
        resize: () => undefined,
      })
      const records = () =>
        (
          surface as unknown as {
            readonly transcriptRecords: ReadonlyMap<
              string,
              {
                readonly renderable: {
                  readonly content: {
                    readonly chunks: ReadonlyArray<{
                      readonly text: string
                      readonly fg?: { readonly equals: (other: unknown) => boolean }
                    }>
                  }
                  readonly screenX: number
                  readonly screenY: number
                }
              }
            >
          }
        ).transcriptRecords
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        const collapsed = setup.captureCharFrame()
        expect(collapsed).toContain("Oracle has spoken ▾")
        expect(collapsed).toContain("Review the code")
        expect(collapsed).toContain("├ ✓ Read src/a.ts L2-4 ▸")
        expect(collapsed).toContain("├ ✓ Subagent finished ▸")
        expect(collapsed).toContain("├ ✓ $ bun test ▸")
        expect(collapsed).toContain("Review complete")
        expect(collapsed).toContain("No defects found.")
        expect(collapsed).not.toContain("##")
        expect(collapsed).not.toContain("**")
        expect(collapsed).not.toContain("read child output")
        expect(collapsed).not.toContain("shell child output")
        const oracleChunks = records().get("tool:oracle-parent:header")!.renderable.content.chunks
        expect(oracleChunks.find((chunk) => chunk.text.includes("Oracle"))!.fg?.equals(colors.text)).toBe(true)
        expect(oracleChunks.find((chunk) => chunk.text === " has spoken")!.fg?.equals(colors.muted)).toBe(true)
        const readChunks = records().get("tool:child-read:header")!.renderable.content.chunks
        expect(readChunks.find((chunk) => chunk.text.includes("Read"))!.fg?.equals(colors.text)).toBe(true)
        expect(readChunks.find((chunk) => chunk.text === " src/a.ts L2-4")!.fg?.equals(colors.muted)).toBe(true)
        const collapsedLines = collapsed.split("\n")
        const shellRow = collapsedLines.findIndex((line) => line.includes("$ bun test"))
        const responseRow = collapsedLines.findIndex((line) => line.includes("Review complete"))
        expect(responseRow).toBe(shellRow + 3)
        expect(collapsedLines[shellRow + 1]!.trim()).toBe("│")
        expect(collapsedLines[shellRow + 2]!.trim()).toBe("│")
        expect(collapsedLines[responseRow]!.indexOf("Review complete")).toBe(
          collapsedLines[shellRow]!.indexOf("$ bun test"),
        )

        const agent = records().get("tool:child-agent:header")!.renderable
        const agentLines = styledTextValue(agent.content).split("\n")
        expect(agentLines).toHaveLength(1)
        const markerLine = agentLines[0]!
        yield* openTui(() =>
          setup.mockMouse.click(agent.screenX + markerLine.indexOf("▸"), agent.screenY + agentLines.length - 1),
        )
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-agent")

        const agentBody = records().get("tool:child-agent:body")!.renderable
        yield* openTui(() =>
          setup.mockMouse.drag(agentBody.screenX, agentBody.screenY, agentBody.screenX + 24, agentBody.screenY),
        )
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getSelection()?.getSelectedText()).toContain("Read-only explore")
        model = update(model, { _tag: "DetailToggled", id: "tool:oracle-parent" })
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).not.toContain("tool:oracle-parent")
        expect(setup.captureCharFrame()).not.toContain("Read-only explore")
        expect(setup.renderer.getSelection()).toBeNull()
        model = update(model, { _tag: "DetailToggled", id: "tool:oracle-parent" })
        surface.update(model)
        yield* openTui(() => setup.flush())

        const read = records().get("tool:child-read:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(read.screenX + 4, read.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-read")
        expect(setup.captureCharFrame()).toContain("read child output")
        expect(setup.captureCharFrame()).not.toContain("shell child output")

        yield* openTui(() => setup.mockMouse.click(read.screenX + 12, read.screenY))
        expect(opened).toEqual([{ path: "src/a.ts", line: 3, column: 1 }])
        expect(model.expandedRowKeys).toContain("tool:child-read")

        const shell = records().get("tool:child-shell:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(shell.screenX + 4, shell.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-shell")
        expect(setup.captureCharFrame()).toContain("shell child output")

        const expandedRead = records().get("tool:child-read:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(expandedRead.screenX + 4, expandedRead.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).not.toContain("tool:child-read")
        expect(setup.captureCharFrame()).not.toContain("read child output")
        expect(setup.captureCharFrame()).toContain("shell child output")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("drags the composer top border through OpenTUI mouse routing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const pointers: Array<string> = []
      ;(setup.renderer as unknown as { realStdoutWrite?: undefined }).realStdoutWrite = undefined
      setup.renderer.setMousePointer = (style) => pointers.push(style)
      let model = initial("/work", "high")
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        composerResize: (height) => {
          model = update(model, { _tag: "ComposerHeightChanged", height })
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(surface.inputBox.height).toBe(5)
        expect(model.input).toBe("")
        yield* openTui(() => setup.mockMouse.moveTo(20, surface.inputBox.y))
        expect(pointers.at(-1)).toBe("move")
        yield* openTui(() => setup.mockMouse.drag(20, surface.inputBox.y, 20, surface.inputBox.y - 4))
        yield* openTui(() => setup.renderOnce())
        expect(model.composerHeight).toBe(9)
        expect(surface.inputBox.height).toBe(9)
        yield* openTui(() => setup.mockMouse.moveTo(20, surface.inputBox.y + 1))
        expect(pointers.at(-1)).toBe("default")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
