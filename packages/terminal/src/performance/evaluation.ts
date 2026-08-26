import { createTestRenderer } from "@opentui/core/testing"
import type { Unit } from "@rika/transcript/transcript-unit"
import { unitOrder } from "@rika/transcript/transcript-unit-order"
import { Clock, Effect } from "effect"
import { Surface } from "../opentui/surface/service"
import type { Key } from "../presentation/terminal/keymap"
import { projectUnits as applyTurnUnits } from "../presentation/transcript/projection"
import { expandableRowIds } from "../presentation/transcript/row"
import { maxMountedTranscriptRows } from "../presentation/transcript/window"
import { initial, type Model } from "../state/model"
import { update } from "../state/reducer/model"
import type { ThreadItem } from "../state/thread/model"

export interface PerformanceMetric {
  readonly id: string
  readonly unit: "milliseconds" | "mebibytes" | "count" | "percent"
  readonly value?: number
  readonly target?: { readonly operator: "lte" | "gte" | "eq"; readonly value: number }
  readonly status: "measured" | "unsupported"
  readonly pass?: boolean
  readonly reason?: string
}

export type PerformancePhase = "started" | "loaded" | "interactions-completed" | "completed"

export interface PerformanceEvaluation {
  readonly evidence: "opentui-test-renderer"
  readonly workload: {
    readonly transcriptItems: number
    readonly childRuns: number
    readonly toolsPerChild: number
    readonly streamedUpdates: number
    readonly warmupInteractions: number
    readonly interactionSamples: number
  }
  readonly metrics: ReadonlyArray<PerformanceMetric>
}

const childRuns = 834
const toolsPerChild = 4
const streamedUpdates = 100
const warmupInteractions = 100
const interactionSamples = 100
const childTurnId = (child: number) => `subagent-performance-${child}`
const toolPresentation = {
  family: "explore" as const,
  action: "read",
  activeLabel: "Reading",
  completeLabel: "Read",
  outputDisplay: "expandable" as const,
}
const semanticUnit = (key: string, index: number, content: Unit["content"], parentId?: string, revision = 0): Unit => {
  if (parentId === undefined) return { key, turnId: "performance", order: unitOrder(key, index), revision, content }
  return { key, turnId: "performance", order: unitOrder(key, index), revision, parentId, content }
}
const childUnits = (child: number): ReadonlyArray<Unit> => {
  const id = childTurnId(child)
  const cardKey = `subagent:performance:${child}`
  return [
    semanticUnit(cardKey, child * (toolsPerChild + 2) + 1, {
      _tag: "Block",
      block: {
        _tag: "SubagentCard",
        id,
        name: `Task ${child}`,
        prompt: `Task ${child}`,
        promptTruncated: false,
        summary: `Child ${child} verified the target module.`,
        status: "complete",
        activity: [],
      },
    }),
    ...Array.from({ length: toolsPerChild }, (_, tool) =>
      semanticUnit(
        `tool:performance:${child}:${tool}`,
        child * (toolsPerChild + 2) + tool + 2,
        {
          _tag: "Block",
          block: {
            _tag: "ToolCall",
            id: `performance:${child}:${tool}`,
            name: "read",
            input: JSON.stringify({ path: `src/${child}/${tool}.ts` }),
            status: "complete",
            presentation: toolPresentation,
            detail: `src/${child}/${tool}.ts`,
            output: `contents ${child} ${tool}`,
            files: [],
          },
        },
        id,
      ),
    ),
    semanticUnit(
      `assistant:performance:${child}`,
      child * (toolsPerChild + 2) + toolsPerChild + 2,
      { _tag: "Entry", role: "assistant", text: `Child ${child} verified the target module.` },
      id,
    ),
  ]
}
const parentProjection = () => ({
  units: [
    semanticUnit("assistant:performance:intro", 0, {
      _tag: "Entry",
      role: "assistant",
      text: "Running the standard performance workload.",
    }),
    ...Array.from({ length: childRuns }, (_, child) => childUnits(child)).flat(),
  ],
})

const key = (name: string, options: Partial<Key> = {}): Key => ({
  name,
  ctrl: options.ctrl ?? false,
  alt: options.alt ?? false,
  meta: options.meta ?? false,
  shift: options.shift ?? false,
  sequence: options.sequence ?? "",
  eventType: options.eventType ?? "press",
})

const percentile = (samples: ReadonlyArray<number>, ratio: number): number => {
  const sorted = [...samples].toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

const targetPasses = (target: NonNullable<PerformanceMetric["target"]>, value: number): boolean => {
  if (target.operator === "lte") return value <= target.value
  if (target.operator === "gte") return value >= target.value
  return value === target.value
}

const measured = (
  id: string,
  unit: PerformanceMetric["unit"],
  value: number,
  target?: PerformanceMetric["target"],
): PerformanceMetric =>
  target === undefined
    ? { id, unit, value, status: "measured" }
    : { id, unit, value, target, status: "measured", pass: targetPasses(target, value) }

const elapsedMilliseconds = (startedAt: bigint, finishedAt: bigint): number =>
  Number(finishedAt - startedAt) / 1_000_000
const renderOnce = (render: Awaited<ReturnType<typeof createTestRenderer>>["renderOnce"]) =>
  Effect.tryPromise(render).pipe(Effect.orDie)

const evaluate = Effect.fn("TuiPerformance.evaluate")(function* (options: {
  readonly observe?: (phase: PerformancePhase) => void
}) {
  options.observe?.("started")
  const setup = yield* Effect.tryPromise(() => createTestRenderer({ width: 120, height: 36 })).pipe(Effect.orDie)
  const base = applyTurnUnits({ ...initial("/work", "high"), width: 120, height: 36 }, parentProjection().units)
  let model: Model = {
    ...base,
    currentThreadId: "performance",
    currentThreadTitle: "Performance",
    threads: Array.from(
      { length: 100 },
      (_, index): ThreadItem => ({
        id: index === 0 ? "performance" : `thread-${index}`,
        title: index === 0 ? "Performance" : `Thread ${index}`,
        workspace: "/work",
        pinned: false,
        archived: false,
        status: "idle",
        unread: false,
        lastActivityAt: 100 - index,
      }),
    ),
    expandedRowKeys: [...expandableRowIds(base)],
  }
  const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
  return yield* Effect.gen(function* () {
    const initialStartedAt = yield* Clock.currentTimeNanos
    surface.update(model)
    yield* renderOnce(setup.renderOnce)
    const initialMilliseconds = elapsedMilliseconds(initialStartedAt, yield* Clock.currentTimeNanos)
    for (let sample = 0; sample < warmupInteractions; sample += 1) {
      model = update(model, { _tag: "KeyPressed", key: key("t", { ctrl: true }) })
      surface.update(model)
      model = update(model, { _tag: "KeyPressed", key: key("return") })
      surface.update(model)
      yield* renderOnce(setup.renderOnce)
    }
    options.observe?.("loaded")
    const pickerOpen: Array<number> = []
    const pickerNavigation: Array<number> = []
    const currentSelection: Array<number> = []
    const scroll: Array<number> = []
    for (let sample = 0; sample < interactionSamples; sample += 1) {
      let startedAt = yield* Clock.currentTimeNanos
      model = update(model, { _tag: "KeyPressed", key: key("t", { ctrl: true }) })
      surface.update(model)
      yield* renderOnce(setup.renderOnce)
      pickerOpen.push(elapsedMilliseconds(startedAt, yield* Clock.currentTimeNanos))
      startedAt = yield* Clock.currentTimeNanos
      model = update(model, { _tag: "KeyPressed", key: key("down") })
      model = update(model, { _tag: "KeyPressed", key: key("up") })
      surface.update(model)
      yield* renderOnce(setup.renderOnce)
      pickerNavigation.push(elapsedMilliseconds(startedAt, yield* Clock.currentTimeNanos))
      startedAt = yield* Clock.currentTimeNanos
      model = update(model, { _tag: "KeyPressed", key: key("return") })
      surface.update(model)
      yield* renderOnce(setup.renderOnce)
      currentSelection.push(elapsedMilliseconds(startedAt, yield* Clock.currentTimeNanos))
      startedAt = yield* Clock.currentTimeNanos
      model = update(model, { _tag: "ScrollMoved", offset: sample % 2 === 0 ? -1 : 1 })
      surface.update(model)
      yield* renderOnce(setup.renderOnce)
      scroll.push(elapsedMilliseconds(startedAt, yield* Clock.currentTimeNanos))
    }
    options.observe?.("interactions-completed")
    const streamUpdates: Array<number> = []
    const renderLatencies: Array<number> = []
    for (let step = 0; step < streamedUpdates; step += 1) {
      const startedAt = yield* Clock.currentTimeNanos
      const child = step % childRuns
      const id = childTurnId(child)
      const unitKey = `assistant:performance:${child}`
      model = applyTurnUnits(model, [
        semanticUnit(
          unitKey,
          child * (toolsPerChild + 2) + toolsPerChild + 2,
          { _tag: "Entry", role: "assistant", text: `Child ${child} verified the target module. delta ${step}` },
          id,
          step + 1,
        ),
      ])
      surface.update(model)
      const renderStartedAt = yield* Clock.currentTimeNanos
      yield* renderOnce(setup.renderOnce)
      const renderedAt = yield* Clock.currentTimeNanos
      renderLatencies.push(elapsedMilliseconds(renderStartedAt, renderedAt))
      streamUpdates.push(elapsedMilliseconds(startedAt, renderedAt))
    }
    options.observe?.("completed")
    const mountedTranscriptRows = surface.mountedTranscriptRowCount()
    const metrics: Array<PerformanceMetric> = [
      measured("tui.initial-render", "milliseconds", initialMilliseconds, { operator: "lte", value: 150 }),
      measured("tui.picker-open.p95", "milliseconds", percentile(pickerOpen, 0.95), { operator: "lte", value: 25 }),
      measured("tui.picker-navigation.p95", "milliseconds", percentile(pickerNavigation, 0.95), {
        operator: "lte",
        value: 12,
      }),
      measured("tui.current-thread-selection.p95", "milliseconds", percentile(currentSelection, 0.95), {
        operator: "lte",
        value: 16,
      }),
      measured("tui.scroll.p95", "milliseconds", percentile(scroll, 0.95), { operator: "lte", value: 12 }),
      measured("tui.stream-update.p50", "milliseconds", percentile(streamUpdates, 0.5)),
      measured("tui.stream-update.p95", "milliseconds", percentile(streamUpdates, 0.95), {
        operator: "lte",
        value: 25,
      }),
      measured("tui.stream-update.p99", "milliseconds", percentile(streamUpdates, 0.99), {
        operator: "lte",
        value: 16,
      }),
      measured("tui.render.p95", "milliseconds", percentile(renderLatencies, 0.95), {
        operator: "lte",
        value: 16.7,
      }),
      measured("tui.mounted-rows", "count", mountedTranscriptRows, {
        operator: "lte",
        value: maxMountedTranscriptRows * 2,
      }),
    ]
    return {
      evidence: "opentui-test-renderer",
      workload: {
        transcriptItems: model.items.length,
        childRuns,
        toolsPerChild,
        streamedUpdates,
        warmupInteractions,
        interactionSamples,
      },
      metrics,
    } satisfies PerformanceEvaluation
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        surface.destroy()
        setup.renderer.destroy()
      }),
    ),
  )
})

export const performanceEvaluation = (options: { readonly observe?: (phase: PerformancePhase) => void } = {}) =>
  evaluate(options)
