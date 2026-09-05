import { fg } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { initial, type Model } from "../../../../src/state/model"
import { canSubmit, update } from "../../../../src/state/reducer/model"
import { modePickerContent } from "../../../../src/opentui/surface/composer/region"
import { modeSelectorLabels } from "../../../../src/presentation/terminal/mode-selector-layout"
import { animationActive, welcomeContent } from "../../../../src/opentui/surface/content"
import { welcomeAnimationActive } from "../../../../src/opentui/surface/welcome/state"
import { Surface } from "../../../../src/opentui/surface/service"
import { colors, modeColor } from "../../../../src/presentation/terminal/theme"
import { meterGlyphs, muncherGlyphs } from "../../../../src/state/context/glyph"
import { toOpenColor } from "../../../../src/opentui/rendering/text-adapter"

const key = (name: string) => ({
  name,
  sequence: name === "return" ? "\r" : name,
  ctrl: false,
  alt: false,
  meta: false,
  shift: false,
  eventType: "press" as const,
})

const text = (chunks: ReadonlyArray<{ readonly text: string }>) => chunks.map((chunk) => chunk.text).join("")

test("mode selection is ViewState-owned with eased keyboard turns and a draining commit animation", () => {
  let model = update(initial("/work", "medium"), { _tag: "ModeSelectorOpened" })
  expect(model.modePicker).toMatchObject({ open: true, selected: 1 })
  model = update(model, { _tag: "KeyPressed", key: key("right") })
  expect(model.modePicker).toMatchObject({ selected: 2, turnTick: 0 })
  expect(text(modePickerContent(model, 54).chunks)).toContain("╾")
  model = update(model, { _tag: "AnimationTicked" })
  expect(model.modePicker.turnTick).toBe(1)
  model = update(model, { _tag: "ModeCommitted" })
  expect(model.mode).toBe("high")
  expect(model.modePicker.open).toBe(false)
  expect(model.modeCommit).toMatchObject({ from: "medium", to: "high", tick: 0 })
  for (let index = 0; index < 12; index += 1) model = update(model, { _tag: "AnimationTicked" })
  expect(model.modeCommit).toBeUndefined()
})

test("renders the compact mode dial with all four visually distinct notch labels", () => {
  const content = text(
    modePickerContent({ ...initial("/work", "medium"), height: 12, modePicker: { open: true, selected: 1 } }, 20)
      .chunks,
  )
  expect(content.split("\n").slice(0, 2)).toEqual(["╌╌╌╌╌━━━╌╌╌╌╌╌╌╌╌╌╌╌", "low  med  high ultra"])
})

it.effect("renders and targets every compact mode notch on a real 24x12 surface", () =>
  Effect.gen(function* () {
    const setup = yield* Effect.acquireRelease(
      Effect.tryPromise(() => createTestRenderer({ width: 24, height: 12 })),
      (value) => Effect.sync(() => value.renderer.destroy()),
    )
    const committed: Array<number> = []
    const surface = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Surface(
            setup.renderer,
            {
              key: () => undefined,
              resize: () => undefined,
              modeCommit: (selected) => committed.push(selected),
            },
            { animate: false },
          ),
      ),
      (value) => Effect.sync(() => value.destroy()),
    )
    surface.update({
      ...initial("/work", "medium"),
      width: 24,
      height: 12,
      modePicker: { open: true, selected: 1 },
    })
    yield* Effect.tryPromise(() => setup.renderOnce())
    expect(setup.captureCharFrame().split("\n").slice(0, 4)).toEqual([
      "╭─ Mode ───────────────╮",
      "│ ╌╌╌╌╌━━━╌╌╌╌╌╌╌╌╌╌╌╌ │",
      "│ low  med  high ultra │",
      "│ Balanced default for │",
    ])
    const palette = surface.palette
    for (const label of modeSelectorLabels(20, ["low", "medium", "high", "ultra"])) {
      void setup.mockMouse.click(palette.screenX + label.start, palette.screenY + 1)
      void setup.mockMouse.click(palette.screenX + label.end - 1, palette.screenY + 1)
    }
    yield* Effect.tryPromise(() => setup.renderOnce())
    expect(committed).toEqual([0, 0, 1, 1, 2, 2, 3, 3])
  }).pipe(Effect.scoped),
)

it.effect("renders responsive context meters and per-cell mode commit wipe colors", () =>
  Effect.gen(function* () {
    const setup = yield* Effect.acquireRelease(
      Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 })),
      (value) => Effect.sync(() => value.renderer.destroy()),
    )
    const committed: Array<number> = []
    const surface = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Surface(
            setup.renderer,
            {
              key: () => undefined,
              resize: () => undefined,
              modeCommit: (selected) => committed.push(selected),
            },
            { animate: false },
          ),
      ),
      (value) => Effect.sync(() => value.destroy()),
    )
    const modeLabel = () => surface.modeLabel.content.chunks
    setup.resize(32, 12)
    surface.update({
      ...initial("/work", "high"),
      width: 32,
      height: 12,
      modePicker: { open: true, selected: 1 },
    })
    yield* Effect.tryPromise(() => setup.renderOnce())
    expect(text(modeLabel())).toContain(`${muncherGlyphs.open}${meterGlyphs.pellet.repeat(3)} 0% ─ high`)
    const palette = surface.palette
    void setup.mockMouse.click(
      palette.screenX + modeSelectorLabels(28, ["low", "medium", "high", "ultra"])[2]!.start,
      palette.screenY + 1,
    )
    yield* Effect.tryPromise(() => setup.renderOnce())
    expect(committed).toEqual([2])
    setup.resize(80, 24)
    surface.update({
      ...initial("/work", "high"),
      width: 80,
      modePicker: { open: true, selected: 1 },
    })
    expect(text(modeLabel())).toContain(`ctx ${muncherGlyphs.open}${meterGlyphs.pellet.repeat(7)} 0% ─ high`)

    surface.update({
      ...initial("/work", "high"),
      currentThreadId: "thread",
      contextUsage: {
        _tag: "Available",
        inputTokens: 50,
        inputCacheRead: 25,
        inputTotal: 50,
        contextWindow: 100,
        reserveTokens: 0,
      },
      modeCommit: { from: "medium", to: "high", tick: 2 },
    })
    const utilized = modeLabel().filter(
      (chunk) =>
        chunk.text === meterGlyphs.fill || chunk.text === muncherGlyphs.open || chunk.text === muncherGlyphs.closed,
    )
    expect(utilized).toHaveLength(4)
    expect(utilized.map((chunk) => chunk.fg)).toEqual([
      fg(colors.high)(meterGlyphs.fill).fg,
      fg(colors.high)(meterGlyphs.fill).fg,
      fg(colors.medium)(meterGlyphs.fill).fg,
      fg(colors.medium)(meterGlyphs.fill).fg,
    ])
  }).pipe(Effect.scoped),
)

it.effect("keeps the Pac-Man context meter visible and freezes it when the agent becomes idle", () =>
  Effect.gen(function* () {
    const setup = yield* Effect.acquireRelease(
      Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 })),
      (value) => Effect.sync(() => value.renderer.destroy()),
    )
    const surface = yield* Effect.acquireRelease(
      Effect.sync(
        () => new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate: false }),
      ),
      (value) => Effect.sync(() => value.destroy()),
    )
    const contextUsage = {
      _tag: "Available" as const,
      inputTokens: 50,
      inputCacheRead: 25,
      inputTotal: 50,
      contextWindow: 100,
      reserveTokens: 0,
    }
    let model: Model = {
      ...initial("/work", "high"),
      currentThreadId: "thread",
      busy: true,
      activity: { _tag: "Streaming" as const, bytes: 20 },
      contextUsage,
      contextDetailsOpen: true,
    }
    model = update(model, { _tag: "AnimationTicked" })
    surface.update(model)
    expect(text(surface.modeLabel.content.chunks)).toContain(muncherGlyphs.closed)
    expect(text(surface.palette.content.chunks)).toContain(muncherGlyphs.closed)

    model = update({ ...model, busy: false, activity: undefined }, { _tag: "AnimationTicked" })
    surface.update(model)
    expect(text(surface.modeLabel.content.chunks)).toContain(muncherGlyphs.closed)
    expect(text(surface.palette.content.chunks)).toContain(muncherGlyphs.closed)
    expect(text(surface.modeLabel.content.chunks)).toContain(meterGlyphs.pellet)
    expect(text(surface.palette.content.chunks)).toContain(meterGlyphs.pellet)

    model = update({ ...model, busy: true, activity: { _tag: "Waiting" } }, { _tag: "AnimationTicked" })
    surface.update(model)
    expect(text(surface.modeLabel.content.chunks)).toContain(muncherGlyphs.open)
    expect(text(surface.palette.content.chunks)).toContain(muncherGlyphs.open)
  }).pipe(Effect.scoped),
)

it.effect("colors the Orb composer cutout with every selected mode", () =>
  Effect.gen(function* () {
    const setup = yield* Effect.acquireRelease(
      Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 })),
      (value) => Effect.sync(() => value.renderer.destroy()),
    )
    const surface = yield* Effect.acquireRelease(
      Effect.sync(
        () => new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate: false }),
      ),
      (value) => Effect.sync(() => value.destroy()),
    )
    for (const mode of ["low", "medium", "high", "ultra"] as const) {
      surface.update({
        ...initial("/work", mode),
        connection: { connectivity: "connected", target: "orb", participants: 1 },
      })
      expect(surface.inputBox.title).toBe(" Orb ")
      expect(surface.inputBox.titleColor).toEqual(toOpenColor(modeColor(mode)))
    }
  }).pipe(Effect.scoped),
)

test("retains the authoritative root context reading while a following turn waits", () => {
  const contextUsage = {
    _tag: "Available" as const,
    inputTokens: 20_000,
    inputCacheRead: 5_000,
    inputTotal: 20_000,
    contextWindow: 272_000,
    reserveTokens: 13_600,
  }
  const selected = { ...initial("/work"), currentThreadId: "thread", contextUsage }
  const waiting = update(selected, { _tag: "TurnStarted", turnId: "turn-2", prompt: "continue" })
  expect(waiting.contextUsage).toEqual(contextUsage)
  expect(waiting.activity).toEqual({ _tag: "Waiting" })
})

test("drains threshold flashes and compaction vacuum ticks only on animation ticks", () => {
  const before = {
    ...initial("/work", "high"),
    activity: { _tag: "Compacting" as const },
    contextUsage: {
      _tag: "Available" as const,
      inputCacheRead: 0,
      inputTokens: 80,
      inputTotal: 80,
      contextWindow: 110,
      reserveTokens: 10,
    },
  }
  const compacted = {
    _tag: "Available" as const,
    inputTokens: 20,
    inputCacheRead: 0,
    inputTotal: 20,
    contextWindow: 110,
    reserveTokens: 10,
  }
  let model = update(before, { _tag: "ContextUsageReplaced", contextUsage: compacted })
  expect(model.contextAnimation).toMatchObject({ compactFromPercent: 80, compactTick: 0 })
  for (let index = 0; index < 17; index += 1) model = update(model, { _tag: "AnimationTicked" })
  expect(model.contextAnimation.compactTick).toBeUndefined()
  const threshold = {
    _tag: "Available" as const,
    inputTokens: 76,
    inputCacheRead: 0,
    inputTotal: 76,
    contextWindow: 110,
    reserveTokens: 10,
  }
  model = update(
    { ...before, activity: undefined, contextUsage: { ...before.contextUsage, inputTokens: 70 } },
    { _tag: "ContextUsageReplaced", contextUsage: threshold },
  )
  expect(model.contextAnimation.flashTicks).toBe(2)
  model = update(model, { _tag: "ComposerReplaced", text: "does not drain" })
  expect(model.contextAnimation.flashTicks).toBe(2)
  model = update(update(model, { _tag: "AnimationTicked" }), { _tag: "AnimationTicked" })
  expect(model.contextAnimation.flashTicks).toBe(0)
})

test("keeps a typed draft intact and blocks submission while a thread is loading", () => {
  let model = update(initial("/work"), { _tag: "ComposerReplaced", text: "keep this draft" })
  model = update(model, { _tag: "ThreadOpenRequested" })
  expect(canSubmit(model)).toBe(false)
  const afterEnter = update(model, { _tag: "KeyPressed", key: key("return") })
  expect(afterEnter.input).toBe("keep this draft")
  expect(afterEnter.history).toEqual([])
  expect(canSubmit(update(afterEnter, { _tag: "ThreadOpenCompleted" }))).toBe(true)
})

test("keeps the welcome orb cadence independent from global ViewState animation", () => {
  const welcome = { ...initial("/work", "high"), animationTick: 7 }
  expect(welcomeAnimationActive(welcome)).toBe(true)
  expect(animationActive(welcome)).toBe(false)
  expect(text(welcomeContent(120, 30, 0, "high").chunks)).not.toBe(text(welcomeContent(120, 30, 1, "high").chunks))
  expect(welcomeAnimationActive({ ...welcome, entries: [{ role: "user", text: "hello" }] })).toBe(false)
  expect(welcomeAnimationActive({ ...welcome, blocks: [{ _tag: "Notification", title: "hello", detail: "" }] })).toBe(
    false,
  )
  expect(welcomeAnimationActive({ ...welcome, height: 12 })).toBe(false)
})

it.effect("owns and drains the completed-compaction rainbow cadence after settlement", () =>
  Effect.gen(function* () {
    const clock = new ManualClock()
    const setup = yield* Effect.acquireRelease(
      Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24, clock })),
      (value) => Effect.sync(() => value.renderer.destroy()),
    )
    const block = { _tag: "Compaction" as const, summary: "", status: "complete" as const }
    let model = update(
      {
        ...initial("/work", "high"),
        entries: [{ role: "user" as const, text: "compact" }],
        blocks: [block],
        items: [{ _tag: "Block" as const, index: 0, id: "compaction", turnId: "turn" }],
      },
      { _tag: "CompactionChanged", status: "complete" },
    )
    let ticks = 0
    const surface = new Surface(
      setup.renderer,
      {
        key: () => undefined,
        resize: () => undefined,
        animationTick: () => {
          ticks += 1
          model = update(model, { _tag: "AnimationTicked" })
          surface.update(model)
        },
      },
      { clock },
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => surface.destroy()))
    surface.update(model)
    yield* Effect.tryPromise(() => setup.renderOnce())
    const rainbowColors = () => {
      const row = surface
        .transcriptDiagnostics()
        .rows.find((renderable) => text(renderable.content.chunks).includes("Auto-compacted"))
      return row?.content.chunks.map((chunk) => String(chunk.fg)) ?? []
    }
    const first = rainbowColors()
    clock.advance(100)
    expect(rainbowColors()).not.toEqual(first)
    clock.advance(1_300)
    expect(ticks).toBe(14)
    expect(model.compactionShimmer).toBeUndefined()
    clock.advance(1_000)
    expect(ticks).toBe(14)
  }).pipe(Effect.scoped),
)

it.effect("owns a continuous welcome cadence and stops it when transcript content mounts", () =>
  Effect.gen(function* () {
    const clock = new ManualClock()
    const setup = yield* Effect.acquireRelease(
      Effect.tryPromise(() => createTestRenderer({ width: 120, height: 30, clock })),
      (value) => Effect.sync(() => value.renderer.destroy()),
    )
    let model = { ...initial("/work", "high"), width: 120, height: 30 }
    let globalTicks = 0
    const surface = new Surface(
      setup.renderer,
      {
        key: () => undefined,
        resize: () => undefined,
        animationTick: () => {
          globalTicks += 1
        },
      },
      { clock },
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => surface.destroy()))
    surface.update(model)
    yield* Effect.tryPromise(() => setup.renderOnce())
    const renderedWelcome = () =>
      text(welcomeContent(model.width, model.height, surface.animationDiagnostics().welcomePhase, model.mode).chunks)
    const first = renderedWelcome()
    clock.advance(100)
    const second = renderedWelcome()
    clock.advance(3_200)
    expect(surface.animationDiagnostics().welcomePhase).toBe(33)
    expect(globalTicks).toBe(0)
    expect(second).not.toBe(first)
    expect(renderedWelcome()).not.toBe(first)
    model = { ...model, entries: [{ role: "user", text: "hello" }] }
    surface.update(model)
    const stoppedAt = surface.animationDiagnostics().welcomePhase
    expect(surface.animationDiagnostics().welcomeRunning).toBe(false)
    clock.advance(1_000)
    expect(surface.animationDiagnostics().welcomePhase).toBe(stoppedAt)
    expect(globalTicks).toBe(0)
  }).pipe(Effect.scoped),
)

test("places the welcome orb and copy at the v0.1.7 anchors with mode-colored intensity tiers", () => {
  const medium = welcomeContent(120, 30, 0, "medium")
  const high = welcomeContent(120, 30, 0, "high")
  const mediumText = text(medium.chunks)
  expect(mediumText).toContain("Welcome to Rika")
  const copyLine = mediumText.split("\n").find((line) => line.includes("Welcome to Rika"))!
  expect(copyLine.indexOf("Welcome to Rika") - copyLine.search(/[·:•●]/u)).toBeLessThan(60)
  const mediumColors = new Set(
    medium.chunks.filter((chunk) => /[·:•●]/u.test(chunk.text)).map((chunk) => String(chunk.fg)),
  )
  const highColors = new Set(high.chunks.filter((chunk) => /[·:•●]/u.test(chunk.text)).map((chunk) => String(chunk.fg)))
  expect(mediumColors.size).toBeGreaterThan(2)
  expect(highColors).not.toEqual(mediumColors)
})
