import { MouseEvent, RGBA, StyledText, stringToStyledText } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { expect, vi } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { renderTranscriptStyled } from "../../../src/opentui/rendering/renderer"
import { create } from "../../../src/opentui/surface/service"
import { type Mode } from "../../../src/state/model"

let activeSetup: TestRendererSetup
const opentui = {
  RGBA,
  get renderer() {
    return activeSetup.renderer
  },
  get frameHandlers() {
    return activeSetup.renderer.listeners("frame")
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
      return yield* create({ ...callbacks, makeRenderer: () => Effect.succeed(activeSetup.renderer) })
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
} from "../../support/surface/service.fixture"
it.effect("renders welcome, entries, modes, activity, cursor, and palette", () =>
  Effect.gen(function* () {
    const callbacks = handlers()
    const { surface } = yield* createScoped(callbacks)

    const inputText = () => surface.composerEditor.plainText

    const modeLabelText = () =>
      styledText(surface.modeLabel.content)
        .chunks.map(({ text }) => text)
        .join("")

    surface.update(model({ input: "abcd", cursor: 2 }))
    expect(surface.transcriptScroll.content).toBeInstanceOf(Object)
    expect(inputText()).toBe("abcd")
    expect(surface.inputBox.title).toBe("")
    expect(modeLabelText()).toBe(" ctx ᗧ······· 0% ─ medium ")
    expect(surface.inputBox.borderColor).toEqual(opentui.RGBA.fromIndex(7))
    expect(surface.inputBox.bottomTitle).toBe("")
    expect(surface.workspaceLabel.content).toEqual(
      expect.objectContaining({ chunks: [expect.objectContaining({ text: " /workspace " })] }),
    )
    expect(surface.palette.visible).toBe(false)

    surface.update(model({ width: 40, input: "one\ntwo\nthree", cursor: 13 }))
    yield* Effect.tryPromise(() => activeSetup.renderOnce())
    expect(surface.inputBox.height).toBe(5)
    expect(inputText()).toBe("one\ntwo\nthree")
    expect(surface.inputBox.bottomTitle).toBe("")

    surface.update(model({ input: "one\ntwo\nthree\nfour", cursor: 18 }))
    yield* Effect.tryPromise(() => activeSetup.renderOnce())
    expect(surface.inputBox.height).toBe(6)
    expect(inputText()).toBe("one\ntwo\nthree\nfour")

    surface.update(
      model({
        input: `a${String.fromCharCode(0xe000)}b`,
        cursor: 2,
        pastedText: [
          {
            type: "text",
            token: String.fromCharCode(0xe000),
            value: "many\nlines",
            label: "[Pasted text #1 +2 lines]",
          },
        ],
      }),
    )
    expect(inputText()).toBe("a[Pasted text #1 +2 lines]b")

    const modeColors: ReadonlyArray<readonly [Mode, string]> = [
      ["low", "#d2a25c"],
      ["medium", "#58a6ff"],
      ["high", "#3fb950"],
      ["ultra", "#ae77ff"],
    ]
    for (const [mode] of modeColors) {
      surface.update(model({ mode, busy: true, activity: { _tag: "Sending" } }))
      expect(surface.inputBox.title).toBe("")
      expect(modeLabelText()).toBe(` ctx ᗧ······· 0% ─ ${mode} `)
      expect(surface.inputBox.borderColor).toEqual(opentui.RGBA.fromIndex(7))
      expect(surface.statusLabel.content).toEqual(
        expect.objectContaining({
          chunks: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(" Sending ") })]),
        }),
      )
    }

    surface.update(
      model({
        entries: [
          { role: "user", text: "question" },
          { role: "assistant", text: "answer" },
          { role: "notice", text: "problem" },
        ],
        paletteOpen: true,
      }),
    )
    expect(surface.transcriptScroll.content).toBeInstanceOf(Object)
    expect(
      renderTranscriptStyled(
        model({
          entries: [
            { role: "user", text: "question" },
            { role: "assistant", text: "answer" },
            { role: "notice", text: "problem" },
          ],
        }),
      )
        .chunks.map(({ text }) => text)
        .join("")
        .replace(/^\n+/, ""),
    ).toBe("┃ question\n\nanswer\n\n! problem")
    expect(surface.palette.visible).toBe(true)
    expect(surface.paletteBox.visible).toBe(true)
    expect(surface.paletteBox.title).toBe(" Command Palette ")
    const paletteText = styledText(surface.palette.content)
      .chunks.map(({ text }) => text)
      .join("")
    expect(paletteText).toContain("thread")
    expect(paletteText).toContain("change mode")
    expect(paletteText).toContain("toggle fast mode")
    expect(paletteText).toContain("quit")
    expect(paletteText).not.toContain("run prompt")
    expect(paletteText).not.toContain("show context and cost")
    expect(paletteText).not.toContain("review workspace changes")
    expect(paletteText).not.toContain("changed files")
    expect(opentui.renderer.getSchedulerState().hasScheduledRender).toBe(true)
  }),
)
it.effect("routes context-meter clicks to the context overlay", () =>
  Effect.gen(function* () {
    const contextToggle = vi.fn()
    const { surface } = yield* createScoped({ ...handlers(), contextToggle })
    surface.update(model())
    yield* Effect.tryPromise(() => activeSetup.renderOnce())
    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "down", surface.modeLabel.screenX))
    expect(contextToggle).toHaveBeenCalledOnce()
    surface.modeLabel.processMouseEvent(
      mouseEvent(surface.modeLabel, "down", surface.modeLabel.screenX + surface.modeLabel.width - 1),
    )
    expect(contextToggle).toHaveBeenCalledOnce()
  }),
)
it.effect("uses pointer hover for the context meter", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    surface.update(model({ mode: "medium" }))
    yield* Effect.tryPromise(() => activeSetup.renderOnce())
    expect(surface.modeLabel.width).toBe(26)
    expect(styledText(surface.modeLabel.content).chunks[0]?.attributes).toBe(0)

    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "over", surface.modeLabel.screenX))
    expect(styledText(surface.modeLabel.content).chunks[0]?.attributes).toBe(1)
    surface.modeLabel.processMouseEvent(
      mouseEvent(surface.modeLabel, "move", surface.modeLabel.screenX + surface.modeLabel.width - 1),
    )
    expect(styledText(surface.modeLabel.content).chunks[0]?.attributes).toBe(0)
    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "out"))
  }),
)
it.effect("routes clicks on the context and mode segments to their own handlers", () =>
  Effect.gen(function* () {
    const contextToggle = vi.fn()
    const modeToggle = vi.fn()
    const { surface } = yield* createScoped({ ...handlers(), contextToggle, modeToggle })
    surface.update(model({ mode: "medium" }))
    yield* Effect.tryPromise(() => activeSetup.renderOnce())

    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "down", surface.modeLabel.screenX))
    expect(contextToggle).toHaveBeenCalledTimes(1)
    expect(modeToggle).toHaveBeenCalledTimes(0)

    surface.modeLabel.processMouseEvent(
      mouseEvent(surface.modeLabel, "down", surface.modeLabel.screenX + surface.modeLabel.width - 1),
    )
    expect(modeToggle).toHaveBeenCalledTimes(1)
    expect(contextToggle).toHaveBeenCalledTimes(1)
  }),
)

it.effect("keeps context details static under paging and mouse-wheel input", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    const entries = Array.from({ length: 80 }, (_, index) => ({
      role: "assistant" as const,
      text: `answer ${index}`,
      turnId: `turn-${index}`,
    }))
    const items = entries.map((_, index) => ({
      _tag: "Entry" as const,
      index,
      id: `assistant:turn-${index}:0`,
      turnId: `turn-${index}`,
    }))
    surface.update(
      model({
        entries,
        items,
        currentThreadId: "thread",
        contextDetailsOpen: true,
        contextUsage: {
          _tag: "Available",
          inputTokens: 20,
          inputCacheRead: 5,
          inputTotal: 20,
          contextWindow: 100,
          reserveTokens: 10,
        },
      }),
    )
    yield* Effect.tryPromise(() => activeSetup.flush())
    surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
    yield* Effect.tryPromise(() => activeSetup.flush())
    const before = surface.transcriptScroll.scrollTop
    expect(before).toBeGreaterThan(0)

    for (const key of ["\u001b[5~", "\u001b[6~", "\u001b[H", "\u001b[F"]) {
      activeSetup.mockInput.pressKey(key)
      yield* Effect.tryPromise(() => activeSetup.flush())
      expect(surface.transcriptScroll.scrollTop).toBe(before)
      expect(surface.paletteBox.visible).toBe(true)
    }

    for (const direction of ["up", "down"] as const) {
      yield* Effect.tryPromise(() =>
        activeSetup.mockMouse.scroll(
          surface.transcriptScroll.screenX + 1,
          surface.transcriptScroll.screenY + 1,
          direction,
          { delayMs: 0 },
        ),
      )
      yield* Effect.tryPromise(() => activeSetup.flush())
      expect(surface.transcriptScroll.scrollTop).toBe(before)
      expect(surface.paletteBox.visible).toBe(true)
    }
  }),
)
