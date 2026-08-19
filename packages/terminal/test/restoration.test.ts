import { fg } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { initial } from "../src/state/model/terminal-state"
import { canSubmit, update } from "../src/state/reducer/terminal-state-reducer"
import { modePickerContent } from "../src/opentui/surface/opentui-composer-region"
import { modeSelectorLabels } from "../src/presentation/terminal/terminal-mode-selector-layout"
import { animationActive, welcomeContent } from "../src/opentui/surface/opentui-surface-content"
import { welcomeAnimationActive } from "../src/opentui/surface/opentui-welcome-state"
import { Surface } from "../src/opentui/surface/opentui-surface"
import { colors } from "../src/presentation/terminal/terminal-theme"
import { meterGlyphs } from "../src/state/model/terminal-context-meter-glyph"

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
            { key: () => undefined, resize: () => undefined, modeCommit: (selected) => committed.push(selected) },
            { animate: false },
          ),
      ),
      (value) => Effect.sync(() => value.destroy()),
    )
    surface.update({ ...initial("/work", "medium"), width: 24, height: 12, modePicker: { open: true, selected: 1 } })
    yield* Effect.tryPromise(() => setup.renderOnce())
    expect(setup.captureCharFrame().split("\n").slice(0, 4)).toEqual([
      "╭─ Mode ───────────────╮",
      "│ ╌╌╌╌╌━━━╌╌╌╌╌╌╌╌╌╌╌╌ │",
      "│ low  med  high ultra │",
      "│ Balanced default for │",
    ])
    const palette = (
      surface as unknown as {
        readonly palette: {
          readonly screenX: number
          readonly screenY: number
        }
      }
    ).palette
    for (const label of modeSelectorLabels(20, ["low", "medium", "high", "ultra"])) {
      setup.mockMouse.click(palette.screenX + label.start, palette.screenY + 1)
      setup.mockMouse.click(palette.screenX + label.end - 1, palette.screenY + 1)
    }
    yield* Effect.tryPromise(() => setup.renderOnce())
    expect(committed).toEqual([0, 0, 1, 1, 2, 2, 3, 3])
  }).pipe(Effect.scoped),
)

it.effect("renders responsive context tracks and per-cell mode commit wipe colors", () =>
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
            { key: () => undefined, resize: () => undefined, modeCommit: (selected) => committed.push(selected) },
            { animate: false },
          ),
      ),
      (value) => Effect.sync(() => value.destroy()),
    )
    const modeLabel = () =>
      (
        surface as unknown as {
          readonly modeLabel: {
            readonly content: { readonly chunks: ReadonlyArray<ReturnType<ReturnType<typeof fg>>> }
          }
        }
      ).modeLabel.content.chunks
    setup.resize(32, 12)
    surface.update({ ...initial("/work", "high"), width: 32, height: 12, modePicker: { open: true, selected: 1 } })
    yield* Effect.tryPromise(() => setup.renderOnce())
    expect(text(modeLabel())).toContain(`${meterGlyphs.track.repeat(4)} ─ high`)
    const palette = (
      surface as unknown as {
        readonly palette: {
          readonly screenX: number
          readonly screenY: number
        }
      }
    ).palette
    setup.mockMouse.click(
      palette.screenX + modeSelectorLabels(28, ["low", "medium", "high", "ultra"])[2]!.start,
      palette.screenY + 1,
    )
    yield* Effect.tryPromise(() => setup.renderOnce())
    expect(committed).toEqual([2])
    setup.resize(80, 24)
    surface.update({ ...initial("/work", "high"), width: 80, modePicker: { open: true, selected: 1 } })
    expect(text(modeLabel())).toContain(`ctx ${meterGlyphs.track.repeat(8)} ─ high`)

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
    const filled = modeLabel().filter((chunk) => chunk.text === meterGlyphs.fill)
    expect(filled).toHaveLength(4)
    expect(filled.map((chunk) => chunk.fg)).toEqual([
      fg(colors.high)(meterGlyphs.fill).fg,
      fg(colors.high)(meterGlyphs.fill).fg,
      fg(colors.medium)(meterGlyphs.fill).fg,
      fg(colors.medium)(meterGlyphs.fill).fg,
    ])
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
  expect(welcomeAnimationActive({ ...welcome, blocks: [{ _tag: "Notification", title: "hello" }] })).toBe(false)
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
    let surface!: Surface
    surface = new Surface(
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
      const records = (
        surface as unknown as {
          readonly transcriptRecords: ReadonlyMap<
            string,
            {
              readonly renderable: {
                readonly content: { readonly chunks: ReadonlyArray<{ text: string; fg: unknown }> }
              }
            }
          >
        }
      ).transcriptRecords
      const row = [...records.values()].find(({ renderable }) =>
        text(renderable.content.chunks).includes("Auto-compacted"),
      )
      return row?.renderable.content.chunks.map((chunk) => String(chunk.fg)) ?? []
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
    let surface!: Surface
    surface = new Surface(
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
      text(
        (
          surface as unknown as {
            readonly welcomeController: {
              readonly child: { readonly content: { readonly chunks: ReadonlyArray<{ readonly text: string }> } }
            }
          }
        ).welcomeController.child.content.chunks,
      )
    const first = renderedWelcome()
    clock.advance(100)
    const second = renderedWelcome()
    clock.advance(3_200)
    const local = surface as unknown as {
      readonly welcomeController: { readonly phase: number; readonly running: boolean }
    }
    expect(local.welcomeController.phase).toBe(33)
    expect(globalTicks).toBe(0)
    expect(second).not.toBe(first)
    expect(renderedWelcome()).not.toBe(first)
    model = { ...model, entries: [{ role: "user", text: "hello" }] }
    surface.update(model)
    const stoppedAt = local.welcomeController.phase
    expect(local.welcomeController.running).toBe(false)
    clock.advance(1_000)
    expect(local.welcomeController.phase).toBe(stoppedAt)
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
