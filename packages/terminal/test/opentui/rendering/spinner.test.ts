import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../../src/opentui/surface/service"
import { spinnerInterval } from "../../../src/opentui/rendering/spinner"
import { initial, type Model } from "../../../src/state/model"
import type { TranscriptBlock } from "../../../src/state/transcript/model"
import { openTui, styledTextValue } from "./window.fixture"

const settled = (): Model => ({
  ...initial("/work", "high"),
  width: 120,
  height: 40,
  entries: [{ role: "assistant", text: "settled answer", turnId: "turn-1" }],
})

const welcoming = (): Model => ({ ...settled(), entries: [], blocks: [], items: [] })

const runningTool = (): Model => {
  const block: Extract<TranscriptBlock, { _tag: "ToolCall" }> = {
    _tag: "ToolCall",
    id: "selected-tool",
    name: "bash",
    input: '{"command":"sleep 5"}',
    status: "running",
    presentation: {
      family: "shell",
      action: "command",
      activeLabel: "Running",
      completeLabel: "Ran",
    },
    detail: "sleep 5",
    result: { text: "working" },
    files: [],
  }
  return {
    ...settled(),
    entries: [],
    blocks: [block],
    items: [{ _tag: "Block", index: 0, id: "selected-tool", turnId: "turn-1" }],
    detailSelection: "tool:selected-tool",
    expandedRowKeys: ["tool:selected-tool"],
  }
}

const runningCell = (): Model => {
  const block: Extract<TranscriptBlock, { _tag: "Cell" }> = {
    _tag: "Cell",
    id: "selected-cell",
    status: "running",
    visual: "ts",
    source: { text: "await work()\nreturn 42", lines: 2 },
    output: { stdout: "", stderr: "" },
    epoch: 0,
    notices: [],
    calls: [],
    files: [],
  }
  return {
    ...settled(),
    entries: [],
    blocks: [block],
    items: [{ _tag: "Block", index: 0, id: "selected-cell", turnId: "turn-1" }],
    detailSelection: "cell:selected-cell",
    expandedRowKeys: ["cell:selected-cell"],
  }
}

const streamingSubagent = (status: "running" | "complete" | "failed" = "running"): Model => ({
  ...settled(),
  entries: [{ role: "assistant", text: "partial child answer", turnId: "turn-1" }],
  blocks: [
    {
      _tag: "SubagentCard",
      id: "streaming-subagent",
      name: "Task",
      prompt: "Inspect the spinner",
      promptTruncated: false,
      summary: "",
      status,
      activity: [],
    },
  ],
  items: [
    { _tag: "Block", index: 0, id: "streaming-subagent", turnId: "turn-1" },
    { _tag: "Entry", index: 0, id: "partial-answer", turnId: "turn-1", parentId: "streaming-subagent" },
  ],
  expandedRowKeys: ["subagent:streaming-subagent"],
})

const nestedStreamingSubagent = (): Model => ({
  ...settled(),
  entries: [{ role: "assistant", text: "partial nested answer", turnId: "turn-1" }],
  blocks: [
    {
      _tag: "SubagentCard",
      id: "parent-subagent",
      name: "Task",
      prompt: "Delegate",
      promptTruncated: false,
      summary: "",
      status: "running",
      activity: [],
    },
    {
      _tag: "SubagentCard",
      id: "nested-subagent",
      name: "Oracle",
      prompt: "Inspect deeply",
      promptTruncated: false,
      summary: "",
      status: "running",
      activity: [],
    },
  ],
  items: [
    { _tag: "Block", index: 0, id: "parent-subagent", turnId: "turn-1" },
    { _tag: "Block", index: 1, id: "nested-subagent", turnId: "turn-1", parentId: "parent-subagent" },
    { _tag: "Entry", index: 0, id: "nested-answer", turnId: "turn-1", parentId: "nested-subagent" },
  ],
  expandedRowKeys: ["subagent:parent-subagent", "subagent:nested-subagent"],
})

interface AnimationProbe {
  readonly surface: Surface
  readonly animationClock: ManualClock
  readonly animationRenders: () => number
}

const withSurface = <A>(model: Model, use: (probe: AnimationProbe) => A) =>
  Effect.gen(function* () {
    const rendererClock = new ManualClock()
    const animationClock = new ManualClock()
    const setup = yield* openTui(() =>
      createTestRenderer({ width: model.width, height: model.height, clock: rendererClock }),
    )
    const surface = new Surface(
      setup.renderer,
      { key: () => undefined, resize: () => undefined },
      { clock: animationClock },
    )
    try {
      surface.update(model)
      const renderer = setup.renderer
      const request = renderer.requestRender.bind(renderer)
      let renders = 0
      renderer.requestRender = () => {
        renders += 1
        request()
      }
      return use({ surface, animationClock, animationRenders: () => renders })
    } finally {
      surface.destroy()
      setup.renderer.destroy()
    }
  })

const transcriptRow = (surface: Surface, key: string) => {
  const diagnostics = surface.transcriptDiagnostics()
  const index = diagnostics.keys.indexOf(key)
  const row = diagnostics.rows[index]
  if (row === undefined) throw new Error(`Missing transcript row ${key}`)
  return row
}

const expectSpinnerAdvance = (surface: Surface, animationClock: ManualClock, key: string, stableKey?: string) => {
  const row = transcriptRow(surface, key)
  const before = styledTextValue(row.content)
  const stableContent = stableKey === undefined ? undefined : transcriptRow(surface, stableKey).content
  animationClock.advance(spinnerInterval)
  expect(transcriptRow(surface, key)).toBe(row)
  expect(styledTextValue(row.content)).not.toBe(before)
  if (stableKey !== undefined) expect(transcriptRow(surface, stableKey).content).toBe(stableContent)
}

test("runs no animation timer and requests no frame while the surface is settled and idle", () =>
  Effect.runPromise(
    withSurface(settled(), ({ surface, animationClock, animationRenders }) => {
      const before = surface.animationDiagnostics()
      expect(before.loaderRunning).toBe(false)
      expect(before.welcomeRunning).toBe(false)
      animationClock.advance(spinnerInterval * 1_000)
      const after = surface.animationDiagnostics()
      expect(after.loaderRunning).toBe(false)
      expect(after.welcomeRunning).toBe(false)
      expect(after.loaderPhase).toBe(before.loaderPhase)
      expect(after.welcomePhase).toBe(before.welcomePhase)
      expect(animationRenders()).toBe(0)
    }),
  ))

test("advances loader frames only while the model is animating and stops when it settles", () =>
  Effect.runPromise(
    withSurface(settled(), ({ surface, animationClock, animationRenders }) => {
      surface.update({ ...settled(), busy: true })
      expect(surface.animationDiagnostics().loaderRunning).toBe(true)

      animationClock.advance(spinnerInterval * 10)
      const busy = surface.animationDiagnostics()
      expect(busy.loaderPhase).toBe(10)
      expect(animationRenders()).toBeGreaterThan(0)

      surface.update(settled())
      expect(surface.animationDiagnostics().loaderRunning).toBe(false)
      const settledRenders = animationRenders()
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().loaderPhase).toBe(busy.loaderPhase)
      expect(animationRenders()).toBe(settledRenders)
    }),
  ))

test.each([
  ["selected expanded tool", runningTool(), "tool:selected-tool:header", "tool:selected-tool:body"],
  ["selected expanded cell", runningCell(), "cell:selected-cell:header", undefined],
])("updates the spinner inside a styled %s header without replacing its rows", (_label, model, key, bodyKey) =>
  Effect.runPromise(
    withSurface(model, ({ surface, animationClock }) => {
      expect(surface.animationDiagnostics().loaderRunning).toBe(true)
      expectSpinnerAdvance(surface, animationClock, key, bodyKey)
    }),
  ),
)

test("keeps a streaming subagent spinner active after the root turn becomes idle until terminal status", () =>
  Effect.runPromise(
    withSurface(streamingSubagent(), ({ surface, animationClock }) => {
      expect(surface.animationDiagnostics().loaderRunning).toBe(true)
      expectSpinnerAdvance(surface, animationClock, "subagent:streaming-subagent:header")

      surface.update(streamingSubagent("failed"))
      expect(styledTextValue(transcriptRow(surface, "subagent:streaming-subagent:header").content)).toContain("✕")
      expect(surface.animationDiagnostics().loaderRunning).toBe(false)

      surface.update(streamingSubagent("complete"))
      expect(styledTextValue(transcriptRow(surface, "subagent:streaming-subagent:header").content)).toContain("✓")
      expect(surface.animationDiagnostics().loaderRunning).toBe(false)
    }),
  ))

test("keeps a nested streaming subagent spinner active", () =>
  Effect.runPromise(
    withSurface(nestedStreamingSubagent(), ({ surface, animationClock }) => {
      expectSpinnerAdvance(surface, animationClock, "subagent:nested-subagent:header")
    }),
  ))

test("stops the welcome orb timer once the transcript is no longer empty", () =>
  Effect.runPromise(
    withSurface(welcoming(), ({ surface, animationClock, animationRenders }) => {
      expect(surface.animationDiagnostics().welcomeRunning).toBe(true)
      animationClock.advance(spinnerInterval * 10)
      const welcomePhase = surface.animationDiagnostics().welcomePhase
      expect(welcomePhase).toBe(10)

      surface.update(settled())
      expect(surface.animationDiagnostics().welcomeRunning).toBe(false)
      const settledRenders = animationRenders()
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().welcomePhase).toBe(welcomePhase)
      expect(animationRenders()).toBe(settledRenders)
    }),
  ))

test("releases every animation timer on destroy", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const rendererClock = new ManualClock()
      const animationClock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 40, clock: rendererClock }))
      const surface = new Surface(
        setup.renderer,
        { key: () => undefined, resize: () => undefined },
        { clock: animationClock },
      )
      surface.update({ ...welcoming(), busy: true })
      expect(surface.animationDiagnostics().loaderRunning).toBe(true)
      expect(surface.animationDiagnostics().welcomeRunning).toBe(true)

      surface.destroy()
      const released = surface.animationDiagnostics()
      expect(released.loaderRunning).toBe(false)
      expect(released.welcomeRunning).toBe(false)
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().loaderPhase).toBe(released.loaderPhase)
      expect(surface.animationDiagnostics().welcomePhase).toBe(released.welcomePhase)
      setup.renderer.destroy()
    }),
  ))

test("continues the welcome orb after its former intro cutoff", () =>
  Effect.runPromise(
    withSurface(welcoming(), ({ surface, animationClock, animationRenders }) => {
      expect(surface.animationDiagnostics().welcomeRunning).toBe(true)
      animationClock.advance(spinnerInterval * 150)
      const afterCutoff = surface.animationDiagnostics()
      expect(afterCutoff.welcomeRunning).toBe(true)
      expect(afterCutoff.welcomePhase).toBe(150)
      const renders = animationRenders()
      animationClock.advance(spinnerInterval * 10)
      expect(surface.animationDiagnostics().welcomePhase).toBe(160)
      expect(animationRenders()).toBeGreaterThan(renders)
    }),
  ))

test("keeps one welcome timer across ordinary model updates", () =>
  Effect.runPromise(
    withSurface(welcoming(), ({ surface, animationClock, animationRenders }) => {
      animationClock.advance(spinnerInterval * 150)
      expect(surface.animationDiagnostics().welcomeRunning).toBe(true)
      const beforeUpdate = surface.animationDiagnostics()

      surface.update({ ...welcoming(), input: "typing", cursor: 6 })
      expect(surface.animationDiagnostics().welcomeRunning).toBe(true)
      const renders = animationRenders()
      animationClock.advance(spinnerInterval * 10)
      expect(surface.animationDiagnostics().welcomePhase).toBe(beforeUpdate.welcomePhase + 10)
      expect(animationRenders()).toBeGreaterThan(renders)
    }),
  ))

const goaling = (startedAtMillis = 0): Model => ({
  ...settled(),
  goal: { objective: "land R4", status: "active", startedAtMillis },
})

test("runs no goal timer and requests no frame while no goal exists", () =>
  Effect.runPromise(
    withSurface(settled(), ({ surface, animationClock, animationRenders }) => {
      const before = surface.animationDiagnostics()
      expect(before.goalRunning).toBe(false)
      animationClock.advance(spinnerInterval * 1_000)
      const after = surface.animationDiagnostics()
      expect(after.goalRunning).toBe(false)
      expect(after.goalPhase).toBe(before.goalPhase)
      expect(animationRenders()).toBe(0)
    }),
  ))

test("animates the goal icon only while a goal is active and freezes the moment it completes", () =>
  Effect.runPromise(
    withSurface(settled(), ({ surface, animationClock, animationRenders }) => {
      surface.update(goaling())
      expect(surface.animationDiagnostics().goalRunning).toBe(true)

      animationClock.advance(spinnerInterval * 10)
      const active = surface.animationDiagnostics()
      expect(active.goalPhase).toBe(10)
      expect(animationRenders()).toBeGreaterThan(0)

      surface.update({ ...goaling(), goal: { objective: "land R4", status: "complete", startedAtMillis: 0 } })
      expect(surface.animationDiagnostics().goalRunning).toBe(false)
      const completedRenders = animationRenders()
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().goalPhase).toBe(active.goalPhase)
      expect(animationRenders()).toBe(completedRenders)
    }),
  ))

test("keeps the goal timer stopped for a paused goal that is still present in the model", () =>
  Effect.runPromise(
    withSurface(settled(), ({ surface, animationClock, animationRenders }) => {
      surface.update({ ...goaling(), goal: { objective: "bounded", status: "paused", startedAtMillis: 0 } })
      expect(surface.animationDiagnostics().goalRunning).toBe(false)
      const pausedRenders = animationRenders()
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().goalPhase).toBe(0)
      expect(animationRenders()).toBe(pausedRenders)
    }),
  ))

test("releases the goal timer on destroy", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const rendererClock = new ManualClock()
      const animationClock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 40, clock: rendererClock }))
      const surface = new Surface(
        setup.renderer,
        { key: () => undefined, resize: () => undefined },
        { clock: animationClock },
      )
      surface.update(goaling())
      expect(surface.animationDiagnostics().goalRunning).toBe(true)

      surface.destroy()
      const released = surface.animationDiagnostics()
      expect(released.goalRunning).toBe(false)
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().goalPhase).toBe(released.goalPhase)
      setup.renderer.destroy()
    }),
  ))
