import { createTestRenderer } from "@opentui/core/testing"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import { Effect } from "effect"
import { Surface } from "./adapter"
import type { Key } from "./keys"
import * as TranscriptPresenter from "./transcript-presenter"
import * as ViewState from "./view-state"

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
const childTurnId = (child: number) => `child:performance:agent-${child}`

const sourceEvent = (
  cursor: string,
  sequence: number,
  type: string,
  fields: Partial<TranscriptSourceEvent.SourceEvent> = {},
): TranscriptSourceEvent.SourceEvent => ({ cursor, sequence, type, createdAt: sequence, ...fields })

const parentProjection = () =>
  TranscriptProjection.Projection.project("performance", "exercise a large thread", [
    sourceEvent("assistant-0", 0, "model.output.completed", { text: "Running the standard performance workload." }),
    ...Array.from({ length: childRuns }, (_, child) => [
      sourceEvent(`agent-${child}`, 1 + child * 2, "tool.call.requested", {
        data: { tool_call_id: `agent-${child}`, tool_name: "task", input: { prompt: `Task ${child}` } },
      }),
      sourceEvent(`agent-${child}-spawned`, 2 + child * 2, "child_run.spawned", {
        data: { tool_call_id: `agent-${child}`, child_execution_id: childTurnId(child) },
      }),
    ]).flat(),
  ])

const childProjection = (child: number) =>
  TranscriptProjection.Projection.project(childTurnId(child), "", [
    ...Array.from({ length: toolsPerChild }, (_, tool) => [
      sourceEvent(`tool-${child}-${tool}`, tool * 2, "tool.call.requested", {
        data: { tool_call_id: `tool-${child}-${tool}`, tool_name: "read", input: { path: `src/${child}/${tool}.ts` } },
      }),
      sourceEvent(`tool-${child}-${tool}-result`, tool * 2 + 1, "tool.result.received", {
        data: { tool_call_id: `tool-${child}-${tool}`, output: `contents ${child} ${tool}` },
      }),
    ]).flat(),
    sourceEvent(`answer-${child}`, toolsPerChild * 2, "model.output.completed", {
      text: `Child ${child} verified the target module.`,
    }),
  ])

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

const evaluate = Effect.fn("TuiPerformance.evaluate")(function* (options: {
  readonly observe?: (phase: PerformancePhase) => void
}) {
  options.observe?.("started")
  const setup = yield* Effect.promise(() => createTestRenderer({ width: 120, height: 36 }))
  let projections = new Map(
    Array.from({ length: childRuns }, (_, child) => [childTurnId(child), childProjection(child)] as const),
  )
  const base = TranscriptPresenter.applyTurnUnits(
    { ...ViewState.initial("/work", "high"), width: 120, height: 36 },
    parentProjection().units,
  )
  const attached = TranscriptPresenter.attachChildProjections(base, new Set<string>(), projections)
  let attachments = attached.attachments
  let model: ViewState.Model = {
    ...attached.model,
    currentThreadId: "performance",
    currentThreadTitle: "Performance",
    threads: Array.from(
      { length: 100 },
      (_, index): ViewState.ThreadItem => ({
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
    expandedRowKeys: [...TranscriptPresenter.expandableRowIds(attached.model)],
  }
  const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
  return yield* Effect.gen(function* () {
    const initialStartedAt = performance.now()
    surface.update(model)
    yield* Effect.promise(() => setup.renderOnce())
    const initialMilliseconds = performance.now() - initialStartedAt
    for (let sample = 0; sample < warmupInteractions; sample += 1) {
      model = ViewState.update(model, { _tag: "KeyPressed", key: key("t", { ctrl: true }) })
      surface.update(model)
      model = ViewState.update(model, { _tag: "KeyPressed", key: key("return") })
      surface.update(model)
      yield* Effect.promise(() => setup.renderOnce())
    }
    options.observe?.("loaded")
    const pickerOpen: Array<number> = []
    const pickerNavigation: Array<number> = []
    const currentSelection: Array<number> = []
    const scroll: Array<number> = []
    for (let sample = 0; sample < interactionSamples; sample += 1) {
      let startedAt = performance.now()
      model = ViewState.update(model, { _tag: "KeyPressed", key: key("t", { ctrl: true }) })
      surface.update(model)
      yield* Effect.promise(() => setup.renderOnce())
      pickerOpen.push(performance.now() - startedAt)
      startedAt = performance.now()
      model = ViewState.update(model, { _tag: "KeyPressed", key: key("down") })
      model = ViewState.update(model, { _tag: "KeyPressed", key: key("up") })
      surface.update(model)
      yield* Effect.promise(() => setup.renderOnce())
      pickerNavigation.push(performance.now() - startedAt)
      startedAt = performance.now()
      model = ViewState.update(model, { _tag: "KeyPressed", key: key("return") })
      surface.update(model)
      yield* Effect.promise(() => setup.renderOnce())
      currentSelection.push(performance.now() - startedAt)
      startedAt = performance.now()
      model = ViewState.update(model, { _tag: "ScrollMoved", offset: sample % 2 === 0 ? -1 : 1 })
      surface.update(model)
      yield* Effect.promise(() => setup.renderOnce())
      scroll.push(performance.now() - startedAt)
    }
    options.observe?.("interactions-completed")
    const streamUpdates: Array<number> = []
    const renderLatencies: Array<number> = []
    for (let step = 0; step < streamedUpdates; step += 1) {
      const startedAt = performance.now()
      const child = step % childRuns
      const turnId = childTurnId(child)
      const bumped = TranscriptProjection.Projection.applyEvent(
        projections.get(turnId)!,
        sourceEvent(`stream-${child}-${step}`, toolsPerChild * 2 + 1 + step, "model.output.delta", {
          text: ` delta ${step}`,
        }),
      )
      projections = new Map(projections)
      projections.set(turnId, bumped)
      const next = TranscriptPresenter.attachChildProjections(model, new Set<string>(), projections, attachments)
      attachments = next.attachments
      model = next.model as ViewState.Model
      surface.update(model)
      const renderStartedAt = performance.now()
      yield* Effect.promise(() => setup.renderOnce())
      renderLatencies.push(performance.now() - renderStartedAt)
      streamUpdates.push(performance.now() - startedAt)
    }
    options.observe?.("completed")
    const state = surface as unknown as { readonly transcriptChildren: ReadonlyArray<unknown> }
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
      measured("tui.mounted-rows", "count", state.transcriptChildren.length, {
        operator: "lte",
        value: TranscriptPresenter.maxMountedTranscriptRows * 2,
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
