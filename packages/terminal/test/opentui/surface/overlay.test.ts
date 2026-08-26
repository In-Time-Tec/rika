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
    expect(modeLabelText()).toBe(" medium ")
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
      expect(modeLabelText()).toBe(` $···· ─ ${mode} `)
      expect(surface.inputBox.borderColor).toEqual(opentui.RGBA.fromIndex(7))
      expect(surface.statusLabel.content).toEqual(
        expect.objectContaining({
          chunks: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(" Sending ") })]),
        }),
      )
    }
    surface.update(
      model({
        mode: "medium",
        busy: false,
        usageCost: { _tag: "Available", usd: 0.0074, unpricedAttempts: 1, includedAttempts: 0 },
      }),
    )
    expect(modeLabelText()).toBe(" $0.007 ─ medium ")
    surface.update(
      model({
        mode: "medium",
        busy: false,
        usageCost: { _tag: "Available", usd: 1.25, unpricedAttempts: 2, includedAttempts: 0 },
      }),
    )
    expect(modeLabelText()).toBe(" $1.25 ─ medium ")
    surface.update(
      model({
        mode: "medium",
        busy: false,
        usageCost: { _tag: "Available", usd: 0.0074, unpricedAttempts: 1, includedAttempts: 0 },
      }),
    )
    expect(modeLabelText()).toBe(" $0.007 ─ medium ")
    surface.update(
      model({
        mode: "medium",
        busy: false,
        usageCost: { _tag: "Available", usd: 1.25, unpricedAttempts: 2, includedAttempts: 0 },
      }),
    )
    expect(modeLabelText()).toBe(" $1.25 ─ medium ")
    surface.update(
      model({
        mode: "medium",
        busy: false,
        fastMode: true,
        usageCost: { _tag: "Available", usd: 5.4449, unpricedAttempts: 0, includedAttempts: 0 },
      }),
    )
    expect(modeLabelText()).toBe(" $5.44 ─ ↯medium ")
    const globalTotalUsd = 12.34
    surface.update(
      model({
        mode: "medium",
        busy: false,
        usageCost: { _tag: "Available", usd: globalTotalUsd, unpricedAttempts: 0, includedAttempts: 0 },
      }),
    )
    expect(modeLabelText()).toBe(" $12.34 ─ medium ")
    surface.update(model({ mode: "medium", usageCost: { _tag: "Included", includedAttempts: 3 } }))
    expect(modeLabelText()).toBe(" Included ─ medium ")
    surface.update(model({ mode: "medium", usageCost: { _tag: "Loading" } }))
    expect(modeLabelText()).toBe(" $···· ─ medium ")
    surface.update(model({ mode: "medium", usageCost: { _tag: "Unavailable" } }))
    expect(modeLabelText()).toBe(" $— ─ medium ")
    surface.update(
      model({
        mode: "medium",
        usageDisplay: "tokens",
        usageTokens: { _tag: "Available", total: 40_100_000, uncountedAttempts: 0 },
      }),
    )
    expect(modeLabelText()).toBe(" 40.1M tok ─ medium ")
    surface.update(
      model({
        mode: "medium",
        usageDisplay: "time",
        usageTime: { _tag: "Available", accumulatedMillis: 103_000 },
      }),
    )
    expect(modeLabelText()).toBe(" ◷ 1m 43s ─ medium ")
    surface.update(model({ mode: "medium", usageDisplay: "time", usageTime: { _tag: "Loading" } }))
    expect(modeLabelText()).toBe(" ◷ ···· ─ medium ")
    surface.update(model({ mode: "medium", usageDisplay: "time", usageTime: { _tag: "Unavailable" } }))
    expect(modeLabelText()).toBe(" ◷ — ─ medium ")

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
it.effect("routes usage-label clicks to the local display toggle", () =>
  Effect.gen(function* () {
    const usageToggle = vi.fn()
    const { surface } = yield* createScoped({ ...handlers(), usageToggle })
    surface.update(model({ usageCost: { _tag: "Available", usd: 1.25, unpricedAttempts: 0, includedAttempts: 0 } }))
    yield* Effect.tryPromise(() => activeSetup.renderOnce())
    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "down", surface.modeLabel.screenX))
    expect(usageToggle).toHaveBeenCalledOnce()
    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "down", surface.modeLabel.screenX + 7))
    expect(usageToggle).toHaveBeenCalledOnce()
  }),
)
it.effect("uses native clock width and pointer hover for the usage label", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    surface.update(
      model({
        mode: "medium",
        usageDisplay: "time",
        usageTime: { _tag: "Available", accumulatedMillis: 103_000 },
      }),
    )
    yield* Effect.tryPromise(() => activeSetup.renderOnce())
    expect(surface.modeLabel.width).toBe(19)
    expect(styledText(surface.modeLabel.content).chunks[0]?.attributes).toBe(0)

    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "over", surface.modeLabel.screenX))
    expect(styledText(surface.modeLabel.content).chunks[0]?.attributes).toBe(1)
    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "move", surface.modeLabel.screenX + 11))
    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "over", surface.modeLabel.screenX))
    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "out"))
  }),
)
it.effect("routes clicks on the usage and mode segments to their own handlers", () =>
  Effect.gen(function* () {
    const usageToggle = vi.fn()
    const modeToggle = vi.fn()
    const { surface } = yield* createScoped({ ...handlers(), usageToggle, modeToggle })
    surface.update(
      model({
        mode: "medium",
        usageDisplay: "time",
        usageTime: { _tag: "Available", accumulatedMillis: 103_000 },
      }),
    )
    yield* Effect.tryPromise(() => activeSetup.renderOnce())

    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "down", surface.modeLabel.screenX))
    expect(usageToggle).toHaveBeenCalledTimes(1)
    expect(modeToggle).toHaveBeenCalledTimes(0)

    surface.modeLabel.processMouseEvent(mouseEvent(surface.modeLabel, "down", surface.modeLabel.screenX + 11))
    expect(modeToggle).toHaveBeenCalledTimes(1)
    expect(usageToggle).toHaveBeenCalledTimes(1)
  }),
)
