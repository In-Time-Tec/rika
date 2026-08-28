import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../../src/opentui/surface/service"
import { colors } from "../../../src/presentation/terminal/theme"
import { initial, type Model } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"
import { openTui, _insertText, _giantSubagentModel, _collapsedSubagentModel } from "./window.fixture"
test("toggles expandable transcript headers without selecting them and keeps bodies selectable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = {
        ...initial("/work", "high"),
        input: "draft remains editable",
        cursor: "draft remains editable".length,
        blocks: [
          {
            _tag: "ToolCall",
            id: "shell-selection",
            name: "bash",
            input: '{"command":"printf transcript-output"}',
            status: "complete",
            presentation: {
              family: "shell",
              action: "shell",
              activeLabel: "Running",
              completeLabel: "Ran",
            },
            detail: "printf transcript-output",
            result: { text: "transcript-output" },
            files: [],
          },
        ],
        items: [{ _tag: "Block", index: 0, id: "shell-selection", turnId: "turn-selection" }],
      }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        clickToggle: (unit) => {
          model = update(model, { _tag: "DetailToggled", id: unit })
          surface.update(model)
        },
        resize: () => undefined,
      })
      const records = () => {
        const diagnostics = surface.transcriptDiagnostics()
        return new Map(diagnostics.keys.map((key, index) => [key, { renderable: diagnostics.rows[index]! }]))
      }
      const commandIsBlue = () =>
        records()
          .get("tool:shell-selection:header")!
          .renderable.content.chunks.some(
            (chunk) => chunk.text.includes("printf transcript-output") && chunk.fg?.equals(colors.blue) === true,
          )
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(commandIsBlue()).toBe(false)
        const header = records().get("tool:shell-selection:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(header.screenX + 2, header.screenY))
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(model.expandedRowKeys).toContain("tool:shell-selection")
        expect(model.detailSelection).toBeUndefined()
        expect(commandIsBlue()).toBe(false)
        expect(setup.renderer.getSelection()).toBeNull()

        const body = records().get("tool:shell-selection:body")!.renderable
        yield* openTui(() => setup.mockMouse.drag(body.screenX, body.screenY, body.screenX + 20, body.screenY))
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(setup.renderer.getSelection()?.getSelectedText()).toContain("transcript-output")
        setup.renderer.clearSelection()

        const expandedHeader = records().get("tool:shell-selection:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(expandedHeader.screenX + 2, expandedHeader.screenY))
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(model.expandedRowKeys).not.toContain("tool:shell-selection")
        expect(commandIsBlue()).toBe(false)
        expect(setup.renderer.getSelection()).toBeNull()

        model = update(model, {
          _tag: "KeyPressed",
          key: {
            name: "tab",
            ctrl: false,
            alt: false,
            meta: false,
            shift: false,
            sequence: "",
            eventType: "press",
          },
        })
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(model.detailSelection).toBe("tool:shell-selection")
        expect(commandIsBlue()).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
