import { CliRenderEvents } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { Unit } from "@rika/transcript/transcript-unit"
import { unitOrder } from "@rika/transcript/transcript-unit-order"
import { Clock, Effect } from "effect"
import { Surface } from "../opentui/surface/service"
import {
  resetTranscriptRenderableDiagnostics,
  transcriptRenderableDiagnostics,
} from "../opentui/surface/transcript/renderables"
import { markdownRendererDiagnostics, resetMarkdownRendererDiagnostics } from "../presentation/markdown/renderer"
import {
  projectUnits,
  resetTranscriptProjectionDiagnostics,
  transcriptProjectionDiagnostics,
} from "../presentation/transcript/projection"
import { initial, type Model } from "../state/model"

export interface TerminalBenchmarkMetric {
  readonly scenario: "markdown-stream" | "tool-output" | "transcript-scroll" | "composer-paste" | "resize-storm"
  readonly events: number
  readonly latencyP50Ms: number
  readonly latencyP95Ms: number
  readonly latencyMaxMs: number
  readonly sustainedFps: number
  readonly cpuMs: number
  readonly heapGrowthMb: number
  readonly retainedHeapBytesPerEvent: number
  readonly renderablesCreated: number
  readonly renderablesDestroyed: number
  readonly markdownLexerInvocations: number
  readonly transcriptBytesCopiedPerEvent: number
  readonly fullTranscriptCopiesPerEvent: number
}

export interface TerminalBenchmarkResult {
  readonly renderer: "opentui-test-renderer"
  readonly metrics: ReadonlyArray<TerminalBenchmarkMetric>
  readonly idle: {
    readonly loaderRunning: boolean
    readonly welcomeRunning: boolean
    readonly frames: number
    readonly observedMs: number
    readonly cpuMs: number
  }
}

type TestRendererSetup = Awaited<ReturnType<typeof createTestRenderer>>

interface SurfaceRuntime {
  readonly setup: TestRendererSetup
  readonly surface: Surface
}

type RecordAction = (action: Effect.Effect<void>) => Effect.Effect<void>

const elapsedMilliseconds = (startedAt: bigint, finishedAt: bigint): number =>
  Number(finishedAt - startedAt) / 1_000_000

const percentile = (samples: ReadonlyArray<number>, ratio: number): number => {
  const sorted = samples.toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

const memory = () => {
  Bun.gc(true)
  return process.memoryUsage().heapUsed
}

const assistantUnit = (key: string, text: string, revision: number, index = 0): Unit => ({
  key,
  turnId: "benchmark",
  order: unitOrder(key, index),
  revision,
  content: { _tag: "Entry", role: "assistant", text },
})

const userUnit = (key: string, text: string, index: number): Unit => ({
  key,
  turnId: `benchmark-${index}`,
  order: unitOrder(key, index),
  revision: 0,
  content: { _tag: "Entry", role: "user", text },
})

const toolUnit = (index: number): Unit => ({
  key: `tool:benchmark:${index}`,
  turnId: "benchmark",
  order: unitOrder(`tool:benchmark:${index}`, index),
  revision: 0,
  content: {
    _tag: "Block",
    block: {
      _tag: "ToolCall",
      id: `benchmark-${index}`,
      name: "read",
      input: JSON.stringify({ path: `src/file-${index}.ts` }),
      status: "complete",
      presentation: {
        family: "explore",
        action: "read",
        activeLabel: "Reading",
        completeLabel: "Read",
        outputDisplay: "expandable",
      },
      detail: `src/file-${index}.ts`,
      result: { text: `${String(index).padStart(2, "0")}:${"x".repeat(20 * 1_024 - 3)}` },
      files: [],
    },
  },
})

const markdownAnswer = (): string => {
  const block = [
    "## Streaming benchmark",
    "",
    "- Incremental Markdown keeps settled blocks stable.",
    "- Only the open tail changes while tokens arrive.",
    "",
    "```ts",
    "const frame = update(surface)",
    "```",
    "",
    "| Metric | Goal |",
    "|---|---|",
    "| p95 | 8 ms |",
    "",
  ].join("\n")
  return block.repeat(Math.ceil((40 * 1_024) / block.length)).slice(0, 40 * 1_024)
}

const resetDiagnostics = () => {
  resetMarkdownRendererDiagnostics()
  resetTranscriptProjectionDiagnostics()
  resetTranscriptRenderableDiagnostics()
}

const metric = (
  scenario: TerminalBenchmarkMetric["scenario"],
  samples: ReadonlyArray<number>,
  wallMs: number,
  cpu: NodeJS.CpuUsage,
  heapBefore: number,
  heapAfter: number,
): TerminalBenchmarkMetric => {
  const projection = transcriptProjectionDiagnostics()
  const renderables = transcriptRenderableDiagnostics()
  const markdown = markdownRendererDiagnostics()
  const events = samples.length
  const heapGrowth = Math.max(0, heapAfter - heapBefore)
  return {
    scenario,
    events,
    latencyP50Ms: percentile(samples, 0.5),
    latencyP95Ms: percentile(samples, 0.95),
    latencyMaxMs: Math.max(0, ...samples),
    sustainedFps: wallMs <= 0 ? 0 : (events * 1_000) / wallMs,
    cpuMs: (cpu.user + cpu.system) / 1_000,
    heapGrowthMb: heapGrowth / 1_048_576,
    retainedHeapBytesPerEvent: events === 0 ? 0 : heapGrowth / events,
    renderablesCreated: renderables.created,
    renderablesDestroyed: renderables.destroyed,
    markdownLexerInvocations: markdown.lexerInvocations,
    transcriptBytesCopiedPerEvent: events === 0 ? 0 : projection.copiedTranscriptBytes / events,
    fullTranscriptCopiesPerEvent: events === 0 ? 0 : projection.fullTranscriptArrayCopies / events,
  }
}

const renderOnce = (render: TestRendererSetup["renderOnce"]) => Effect.tryPromise(render).pipe(Effect.orDie)

const makeTestRenderer = (width: number, height: number) =>
  Effect.tryPromise(() => createTestRenderer({ width, height })).pipe(Effect.orDie)

const surfaceSetup = Effect.fn("TerminalBenchmark.surfaceSetup")(function* (
  width: number,
  height: number,
  animate: boolean,
) {
  const setup = yield* makeTestRenderer(width, height)
  const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate })
  return { setup, surface }
})

const destroySurface = (runtime: SurfaceRuntime): void => {
  runtime.surface.destroy()
  runtime.setup.renderer.destroy()
}

const withSurface = <Value, Error, Requirements>(
  width: number,
  height: number,
  animate: boolean,
  use: (runtime: SurfaceRuntime) => Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error, Requirements> =>
  Effect.acquireUseRelease(surfaceSetup(width, height, animate), use, (runtime) =>
    Effect.sync(() => destroySurface(runtime)),
  )

const measuredScenario = Effect.fn("TerminalBenchmark.measuredScenario")(function* (
  scenario: TerminalBenchmarkMetric["scenario"],
  run: (record: RecordAction) => Effect.Effect<void>,
) {
  resetDiagnostics()
  const heapBefore = memory()
  const cpuBefore = process.cpuUsage()
  const wallStarted = yield* Clock.currentTimeNanos
  const samples: Array<number> = []
  const record = Effect.fn("TerminalBenchmark.record")(function* (action: Effect.Effect<void>) {
    const started = yield* Clock.currentTimeNanos
    yield* action
    samples.push(elapsedMilliseconds(started, yield* Clock.currentTimeNanos))
  })
  yield* run(record)
  const wallMs = elapsedMilliseconds(wallStarted, yield* Clock.currentTimeNanos)
  const cpu = process.cpuUsage(cpuBefore)
  const heapAfter = memory()
  return metric(scenario, samples, wallMs, cpu, heapBefore, heapAfter)
})

const markdownStream = Effect.fn("TerminalBenchmark.markdownStream")(function* () {
  return yield* withSurface(
    120,
    36,
    false,
    Effect.fn("TerminalBenchmark.markdownStream.use")(function* (runtime) {
      const source = markdownAnswer()
      let model: Model = {
        ...initial("/benchmark", "medium"),
        width: 120,
        height: 36,
        currentThreadId: "benchmark",
        busy: true,
        activity: { _tag: "Streaming", bytes: 0 },
      }
      let offset = 0
      let revision = 0
      runtime.surface.update(model)
      yield* renderOnce(runtime.setup.renderOnce)
      return yield* measuredScenario(
        "markdown-stream",
        Effect.fn("TerminalBenchmark.markdownStream.run")(function* (record) {
          let arrival = yield* Clock.currentTimeNanos
          while (offset < source.length) {
            const length = 8 + ((revision * 17) % 57)
            offset = Math.min(source.length, offset + length)
            const wait = arrival - (yield* Clock.currentTimeNanos)
            if (wait > 0) yield* Effect.sleep(Number(wait) / 1_000_000)
            yield* record(
              Effect.gen(function* () {
                model = projectUnits(model, [assistantUnit("tentative:benchmark", source.slice(0, offset), revision)])
                runtime.surface.update(model)
                yield* renderOnce(runtime.setup.renderOnce)
              }),
            )
            revision += 1
            arrival += 5_000_000n
          }
        }),
      )
    }),
  )
})

const warmTerminal = Effect.fn("TerminalBenchmark.warmTerminal")(function* () {
  yield* withSurface(
    120,
    36,
    false,
    Effect.fn("TerminalBenchmark.warmTerminal.use")(function* (runtime) {
      const source = markdownAnswer().slice(0, 4 * 1_024)
      let model: Model = {
        ...initial("/benchmark", "medium"),
        width: 120,
        height: 36,
        currentThreadId: "benchmark-warmup",
      }
      for (let offset = 32, revision = 0; offset <= source.length; offset += 32, revision += 1) {
        model = projectUnits(model, [assistantUnit("tentative:warmup", source.slice(0, offset), revision)])
        runtime.surface.update(model)
        yield* renderOnce(runtime.setup.renderOnce)
      }
    }),
  )
})

const toolOutput = Effect.fn("TerminalBenchmark.toolOutput")(function* () {
  return yield* withSurface(
    120,
    36,
    false,
    Effect.fn("TerminalBenchmark.toolOutput.use")(function* (runtime) {
      let model: Model = {
        ...initial("/benchmark", "medium"),
        width: 120,
        height: 36,
        currentThreadId: "benchmark",
      }
      return yield* measuredScenario(
        "tool-output",
        Effect.fn("TerminalBenchmark.toolOutput.run")(function* (record) {
          for (let index = 0; index < 30; index += 1)
            yield* record(
              Effect.gen(function* () {
                model = projectUnits(model, [toolUnit(index)])
                runtime.surface.update(model)
                yield* renderOnce(runtime.setup.renderOnce)
              }),
            )
        }),
      )
    }),
  )
})

const transcriptModel = (): Model => {
  const units = Array.from({ length: 500 }, (_, index) =>
    index % 2 === 0
      ? userUnit(`user:benchmark:${index}`, `User message ${index}`, index)
      : assistantUnit(`assistant:benchmark:${index}`, `Assistant message ${index}`, 0, index),
  )
  return projectUnits(
    { ...initial("/benchmark", "medium"), width: 120, height: 36, currentThreadId: "benchmark" },
    units,
  )
}

const transcriptScroll = Effect.fn("TerminalBenchmark.transcriptScroll")(function* () {
  return yield* withSurface(
    120,
    36,
    false,
    Effect.fn("TerminalBenchmark.transcriptScroll.use")(function* (runtime) {
      return yield* measuredScenario(
        "transcript-scroll",
        Effect.fn("TerminalBenchmark.transcriptScroll.run")(function* (record) {
          const model = transcriptModel()
          runtime.surface.update(model)
          yield* renderOnce(runtime.setup.renderOnce)
          runtime.surface.transcriptScroll.scrollTop = 0
          const page = Math.max(1, runtime.surface.transcriptScroll.viewport.height - 1)
          const maximum = Math.max(
            0,
            runtime.surface.transcriptScroll.scrollHeight - runtime.surface.transcriptScroll.viewport.height,
          )
          for (let position = 0; position <= maximum; position += page)
            yield* record(
              Effect.gen(function* () {
                runtime.surface.transcriptScroll.scrollTop = Math.min(maximum, position)
                runtime.setup.renderer.requestRender()
                yield* renderOnce(runtime.setup.renderOnce)
              }),
            )
        }),
      )
    }),
  )
})

const composerPaste = Effect.fn("TerminalBenchmark.composerPaste")(function* () {
  return yield* withSurface(
    120,
    36,
    false,
    Effect.fn("TerminalBenchmark.composerPaste.use")(function* (runtime) {
      const base: Model = {
        ...initial("/benchmark", "medium"),
        width: 120,
        height: 36,
        currentThreadId: "benchmark",
      }
      runtime.surface.update(base)
      yield* renderOnce(runtime.setup.renderOnce)
      const pasted = Array.from({ length: 3_000 }, (_, index) => `line ${index} 界🙂`).join("\n")
      return yield* measuredScenario(
        "composer-paste",
        Effect.fn("TerminalBenchmark.composerPaste.run")(function* (record) {
          yield* record(
            Effect.gen(function* () {
              runtime.surface.update({ ...base, input: pasted, cursor: pasted.length })
              yield* renderOnce(runtime.setup.renderOnce)
            }),
          )
        }),
      )
    }),
  )
})

const resizeStorm = Effect.fn("TerminalBenchmark.resizeStorm")(function* () {
  return yield* withSurface(
    120,
    36,
    false,
    Effect.fn("TerminalBenchmark.resizeStorm.use")(function* (runtime) {
      let model = transcriptModel()
      runtime.surface.update(model)
      yield* renderOnce(runtime.setup.renderOnce)
      return yield* measuredScenario(
        "resize-storm",
        Effect.fn("TerminalBenchmark.resizeStorm.run")(function* (record) {
          for (let index = 0; index < 20; index += 1)
            yield* record(
              Effect.gen(function* () {
                const width = index % 2 === 0 ? 80 : 140
                const height = index % 3 === 0 ? 28 : 40
                runtime.setup.resize(width, height)
                model = Object.assign({}, model, { width, height })
                runtime.surface.update(model)
                yield* renderOnce(runtime.setup.renderOnce)
              }),
            )
        }),
      )
    }),
  )
})

export const runTerminalBenchmark = Effect.fn("TerminalBenchmark.run")(function* () {
  yield* warmTerminal()
  const metrics = [
    yield* markdownStream(),
    yield* toolOutput(),
    yield* transcriptScroll(),
    yield* composerPaste(),
    yield* resizeStorm(),
  ]
  return yield* withSurface(
    120,
    36,
    true,
    Effect.fn("TerminalBenchmark.idleObservation")(function* (runtime): Effect.fn.Return<TerminalBenchmarkResult> {
      runtime.surface.update({
        ...initial("/benchmark", "medium"),
        width: 120,
        height: 36,
        currentThreadId: "benchmark",
        entries: [{ role: "assistant", text: "Settled" }],
      })
      yield* renderOnce(runtime.setup.renderOnce)
      const animations = runtime.surface.animationDiagnostics()
      yield* Effect.sleep(100)
      let idleFrames = 0
      const countFrame = () => {
        idleFrames += 1
      }
      runtime.setup.renderer.on(CliRenderEvents.FRAME, countFrame)
      const idleCpuBefore = process.cpuUsage()
      const idleObservedMs = 250
      yield* Effect.sleep(idleObservedMs)
      const idleCpu = process.cpuUsage(idleCpuBefore)
      runtime.setup.renderer.off(CliRenderEvents.FRAME, countFrame)
      return {
        renderer: "opentui-test-renderer",
        metrics,
        idle: {
          loaderRunning: animations.loaderRunning,
          welcomeRunning: animations.welcomeRunning,
          frames: idleFrames,
          observedMs: idleObservedMs,
          cpuMs: (idleCpu.user + idleCpu.system) / 1_000,
        },
      }
    }),
  )
})

export const terminalBenchmarkTable = (result: TerminalBenchmarkResult) =>
  result.metrics.map((current) => ({
    scenario: current.scenario,
    events: current.events,
    p50_ms: current.latencyP50Ms.toFixed(2),
    p95_ms: current.latencyP95Ms.toFixed(2),
    max_ms: current.latencyMaxMs.toFixed(2),
    fps: current.sustainedFps.toFixed(1),
    cpu_ms: current.cpuMs.toFixed(1),
    heap_mb: current.heapGrowthMb.toFixed(2),
    retained_B_event: current.retainedHeapBytesPerEvent.toFixed(0),
    renderables: `${current.renderablesCreated}/${current.renderablesDestroyed}`,
    lexer: current.markdownLexerInvocations,
    copied_B_event: current.transcriptBytesCopiedPerEvent.toFixed(1),
    copies_event: current.fullTranscriptCopiesPerEvent.toFixed(2),
  }))
