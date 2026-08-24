import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { update } from "../../src/state/reducer/terminal-state-reducer"
import {
  openTui,
  _insertText,
  _streamingShell,
  thread,
  _giantSubagentModel,
  _collapsedSubagentModel,
} from "./opentui-surface-characterization-13-support"
test("keeps malformed thread titles on one styled picker row", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 140, height: 30 }))
      const base = { ...initial("/work", "high"), width: 140, height: 30 }
      const model: Model = {
        ...base,
        threads: [
          thread({ id: "broken", title: "# Finish the release\n\nYou are finishing\ttoday\u001b" }),
          thread({ id: "following", title: "Following thread" }),
        ],
        threadSwitcher: { ...base.threadSwitcher, open: true },
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const rows = setup.captureCharFrame().split("\n")
        const selectedRow = rows.findIndex((row) => row.includes("# Finish the release"))
        const followingRow = rows.findIndex((row) => row.includes("Following thread"))
        expect(selectedRow).toBeGreaterThanOrEqual(0)
        expect(followingRow).toBe(selectedRow + 1)
        expect(rows[selectedRow]).toContain("\\n\\nYou are finishing\\ttoday\\u{1b}")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("keeps every overlay above the composer at 50x12", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 50, height: 12 }))
      let model: Model = { ...initial("/work", "high"), width: 50, height: 12 }
      model = update(model, { _tag: "FilesReplaced", files: ["src/main.ts"] })
      model = update(model, {
        _tag: "ThreadsReplaced",
        threads: [thread({ id: "thread-2", title: "Release notes", workspace: "/two" })],
      })
      const base = model
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      const capture = Effect.fn("capture")(function* (next: Model, title: string, content: string, composerRow = 7) {
        model = next
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        const rows = frame.split("\n")
        expect(frame).toContain(title)
        expect(frame).toContain(content)
        expect(rows[composerRow]?.startsWith("╭")).toBe(true)
        expect(rows[11]?.startsWith("╰")).toBe(true)
      })
      try {
        yield* capture(
          { ...base, paletteOpen: true, palette: { ...base.palette, open: true } },
          "Command Palette",
          "new in Orb",
        )
        yield* capture({ ...base, modePicker: { ...base.modePicker, open: true } }, "↔ turn ── esc", "Fast, low-cost")
        yield* capture({ ...base, shortcutsOpen: true }, "command palette", "Ctrl+O", 4)
        yield* capture({ ...base, filePicker: { ...base.filePicker, open: true } }, "@src", "@src")
        yield* capture(
          { ...base, threadSwitcher: { ...base.threadSwitcher, open: true, kind: "mention" } },
          "Mention Thread",
          "Release notes",
        )
        yield* capture(
          { ...base, threadSwitcher: { ...base.threadSwitcher, open: true } },
          "Switch Thread",
          "Release notes",
        )
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
