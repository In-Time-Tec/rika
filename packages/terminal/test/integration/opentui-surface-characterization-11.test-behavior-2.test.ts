import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { ready } from "../../src/state/model/terminal-loadable-state"
import { update } from "../../src/state/reducer/terminal-state-reducer"
import {
  openTui,
  _streamingShell,
  _giantSubagentModel,
  _collapsedSubagentModel,
} from "./opentui-surface-characterization-11-support"
test("loads the workspace file tree with Opt+T and keeps it separate from changed files", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      let model = update(initial("/work", "high"), {
        _tag: "FilesReplaced",
        files: ["apps/rika/src/main.ts", "packages/terminal/src/opentui/surface/opentui-surface.ts", "README.md"],
      })
      model = update(model, {
        _tag: "ChangedFilesReplaced",
        files: [
          { path: "packages/terminal/src/opentui/surface/opentui-surface.ts", status: "M", added: 4, removed: 1 },
        ],
      })
      const surface = new Surface(setup.renderer, {
        key: (key) => {
          model = update(model, { _tag: "KeyPressed", key })
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        setup.mockInput.pressKey("t", { meta: true })
        yield* openTui(() => setup.flush())
        expect((model as Model & { readonly workspaceFilesOpen: boolean }).workspaceFilesOpen).toBe(true)
        expect(model.changedFilesOpen).toBe(false)
        const workspaceFrame = setup.captureCharFrame()
        expect(workspaceFrame).toContain("Files (3)")
        expect(workspaceFrame).toContain("apps/")
        expect(workspaceFrame).toContain("README.md")

        setup.mockInput.pressKey("s", { meta: true })
        yield* openTui(() => setup.flush())
        expect((model as Model & { readonly workspaceFilesOpen: boolean }).workspaceFilesOpen).toBe(false)
        expect(model.changedFilesOpen).toBe(true)
        const changedFrame = setup.captureCharFrame()
        expect(changedFrame).toContain("Changed files (1)")
        expect(changedFrame).toContain("opentui-")
        expect(changedFrame).toContain("+4 -1")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("renders and scrolls nested changed files within the bordered sidebar", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      const opened: Array<string> = []
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        openPath: ({ path }) => opened.push(path),
        resize: () => undefined,
      })
      const changedFiles = Array.from({ length: 30 }, (_, index) => ({
        path: `apps/rika/src/features/feature-${String(index).padStart(2, "0")}.ts`,
        status: "M",
        added: index + 1,
        removed: index,
      }))
      try {
        surface.update({
          ...initial("/work", "high"),
          width: 100,
          height: 24,
          entries: [{ role: "assistant", text: "answer" }],
          changedFilesOpen: true,
          changedFiles: ready(changedFiles),
        })
        yield* openTui(() => setup.renderOnce())
        yield* Effect.sleep("0 millis")
        yield* openTui(() => setup.renderOnce())
        const initialFrame = setup.captureCharFrame()
        expect(initialFrame).toContain("Changed files (30)")
        expect(initialFrame).toContain("apps/")
        expect(initialFrame).toContain("  rika/")
        expect(initialFrame).toContain("feature-00.ts")
        expect(initialFrame).not.toContain("feature-29.ts")
        yield* openTui(() => setup.mockMouse.click(72, 5))
        expect(opened).toEqual(["apps/rika/src/features/feature-00.ts"])
        surface.changedFilesBox.scrollTo(surface.changedFilesBox.scrollHeight - surface.changedFilesBox.viewport.height)
        yield* openTui(() => setup.renderOnce())
        const scrolledFrame = setup.captureCharFrame()
        const sidebarLeft = surface.changedFilesBox.x
        expect(scrolledFrame).toContain("feature-29.ts +30 -29")
        expect(scrolledFrame.split("\n")[0]?.slice(sidebarLeft).startsWith("╭")).toBe(true)
        expect(scrolledFrame.split("\n")[23]?.slice(sidebarLeft).startsWith("╰")).toBe(true)
        expect(scrolledFrame.split("\n")[23]?.slice(0, sidebarLeft).startsWith("╰")).toBe(true)
        yield* openTui(() => setup.mockMouse.click(72, 22))
        expect(opened).toEqual(["apps/rika/src/features/feature-00.ts", "apps/rika/src/features/feature-29.ts"])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
