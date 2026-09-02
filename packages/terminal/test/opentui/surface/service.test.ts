import { MouseEvent, RGBA, StyledText, stringToStyledText } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { expect, vi } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { Surface, create } from "../../../src/opentui/surface/service"

let activeSetup: TestRendererSetup
const opentui = {
  RGBA,
  get renderer() {
    return activeSetup.renderer
  },
  get keyHandlers() {
    return { size: activeSetup.renderer.keyInput.listenerCount("keypress") }
  },
  get pasteHandlers() {
    return { size: activeSetup.renderer.keyInput.listenerCount("paste") }
  },
  get resizeHandlers() {
    return { size: activeSetup.renderer.listenerCount("resize") }
  },
  get selectionHandlers() {
    return { size: activeSetup.renderer.listenerCount("selection") }
  },
}

const createScoped = (callbacks: Parameters<typeof create>[0]) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      activeSetup = yield* Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 }))
      return yield* create({
        ...callbacks,
        makeRenderer: () => Effect.succeed(activeSetup.renderer),
      })
    }),
    (created) => Effect.sync(created.releaseTerminal),
  )

const mouseEvent = (
  target: ConstructorParameters<typeof MouseEvent>[0],
  type: "down" | "move" | "over" | "out",
  x = 0,
) =>
  new MouseEvent(target, {
    type,
    x,
    y: 0,
    button: 0,
    modifiers: { shift: false, alt: false, ctrl: false },
  })

const styledText = (content: string | StyledText): StyledText =>
  content instanceof StyledText ? content : stringToStyledText(content)

import {
  _shell,
  _windowUnitToolCall,
  _agentToolBlock,
  handlers,
  _nonEmptyLines,
  model,
  thread,
} from "../../support/surface/service.fixture"
it.effect("clears usage hover when a narrower selector moves away from the pointer", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    surface.update(model())
    yield* Effect.tryPromise(() => activeSetup.renderOnce())
    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "over", surface.modeLabel.screenX))

    surface.update(model({ width: 32 }))
    expect(styledText(surface.modeLabel.content).chunks[0]?.attributes).toBe(0)
  }),
)
it.effect("clears usage hover after layout moves a right-anchored label under a stationary pointer", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    surface.update(model())
    yield* Effect.tryPromise(() => activeSetup.renderOnce())
    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "over", surface.modeLabel.screenX + 1))

    activeSetup.resize(40, 24)
    yield* Effect.tryPromise(() => activeSetup.renderOnce())

    expect(styledText(surface.modeLabel.content).chunks[0]?.attributes).toBe(0)
  }),
)
it.effect("removes its listeners on destroy", () =>
  Effect.gen(function* () {
    const callbacks = handlers()
    const { surface } = yield* createScoped(callbacks)
    const keyCount = opentui.keyHandlers.size
    const pasteCount = opentui.pasteHandlers.size
    const resizeCount = opentui.resizeHandlers.size
    const selectionCount = opentui.selectionHandlers.size

    surface.destroy()

    expect(opentui.keyHandlers.size).toBe(keyCount - 1)
    expect(opentui.pasteHandlers.size).toBe(pasteCount - 1)
    expect(opentui.resizeHandlers.size).toBe(resizeCount - 1)
    expect(opentui.selectionHandlers.size).toBeLessThan(selectionCount)
  }),
)
it.effect("ignores a queued loader tick after destroy", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    const phase = surface.animationDiagnostics().loaderPhase

    surface.destroy()
    opentui.renderer.emit("frame", { deltaTime: 16 })

    expect(surface.animationDiagnostics().loaderPhase).toBe(phase)
  }),
)
it.effect("renders mode picker, filtered palette, sidebar visibility, and notice transitions", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    const paletteText = () =>
      styledText(surface.palette.content)
        .chunks.map(({ text }) => text)
        .join("")
    surface.update(model({ modePicker: { open: true, selected: 2 } }))
    expect(paletteText()).toContain("high")
    expect(paletteText()).toContain("Deep reasoning for hard tasks")
    expect([
      styledText(surface.overlayHintOne.content).chunks[0]?.text,
      styledText(surface.overlayHintTwo.content).chunks[0]?.text,
    ]).toEqual([" esc ", " ↔ turn "])
    surface.update(model({ palette: { open: true, query: "quit", selected: 0 } }))
    expect(paletteText()).toContain("quit")
    surface.update(
      model({
        threads: [thread({ id: "a", title: "A" })],
        threadSidebar: { open: false, focused: false, selected: 0, scrollTop: 0 },
      }),
    )
    expect(surface.sidebar.visible).toBe(false)
    surface.update(model({ entries: [{ role: "assistant", text: "ok" }] }))
    expect(surface.transcriptScroll.content).toBeInstanceOf(Object)
  }),
)
it.effect("create configures the supplied renderer", () =>
  Effect.gen(function* () {
    const callbacks = handlers()
    const result = yield* createScoped(callbacks)

    expect("renderer" in result).toBe(false)
    expect(result.surface).toBeInstanceOf(Surface)
    expect(opentui.renderer.root.getChildren()).toContain(result.surface.main)
  }),
)
it.effect("releases the renderer after construction", () =>
  Effect.gen(function* () {
    const created = yield* createScoped(handlers())
    expect(opentui.renderer.isDestroyed).toBe(false)
    created.releaseTerminal()
    expect(opentui.renderer.isDestroyed).toBe(true)
    created.releaseTerminal()
    expect(opentui.renderer.isDestroyed).toBe(true)
  }),
)
it.effect("requests a forced full repaint after foreign terminal output", () =>
  Effect.gen(function* () {
    const created = yield* createScoped(handlers())
    Reflect.set(opentui.renderer, "forceFullRepaintRequested", false)

    created.redrawTerminal()

    expect(Object.getOwnPropertyDescriptor(opentui.renderer, "forceFullRepaintRequested")?.value).toBe(true)
  }),
)
it.effect("contains callback exceptions and keeps the renderer alive", () =>
  Effect.gen(function* () {
    const key = vi.fn(() => {
      throw new Error("callback failed")
    })
    const warning = vi.fn()
    yield* createScoped({ ...handlers(), key, warning })

    activeSetup.mockInput.pressKey("x")
    yield* Effect.tryPromise(() => activeSetup.renderOnce())

    expect(key).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith("tui.callback.keypress.failed", expect.any(Error))
    expect(opentui.renderer.isDestroyed).toBe(false)
  }),
)
it.effect("releases renderer terminal modes when initialization fails after acquisition", () =>
  Effect.gen(function* () {
    activeSetup = yield* Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 }))
    const error = yield* Effect.flip(
      create({
        key: vi.fn(),
        makeRenderer: () => Effect.succeed(activeSetup.renderer),
        resize: () => {
          throw new Error("resize failed")
        },
      }),
    )

    expect(String(error)).toContain("resize failed")
    expect(opentui.renderer.isDestroyed).toBe(true)
  }),
)
