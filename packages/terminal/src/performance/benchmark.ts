import { CliRenderEvents } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { Unit } from "@rika/transcript/transcript-unit"
import { unitOrder } from "@rika/transcript/transcript-unit-order"
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

const now = () => Number(process.hrtime.bigint()) / 1_000_000

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

const measuredScenario = async (
  scenario: TerminalBenchmarkMetric["scenario"],
  run: (record: (action: () => Promise<void> | void) => Promise<void>) => Promise<void>,
): Promise<TerminalBenchmarkMetric> => {
  resetDiagnostics()
  const heapBefore = memory()
  const cpuBefore = process.cpuUsage()
  const wallStarted = now()
  const samples: Array<number> = []
  await run(async (action) => {
    const started = now()
    await action()
    samples.push(now() - started)
  })
  const wallMs = now() - wallStarted
  const cpu = process.cpuUsage(cpuBefore)
  const heapAfter = memory()
  return metric(scenario, samples, wallMs, cpu, heapBefore, heapAfter)
}

const surfaceSetup = async (width = 120, height = 36, animate = false) => {
  const setup = await createTestRenderer({ width, height })
  const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate })
  return { setup, surface }
}

const destroySurface = ({ setup, surface }: Awaited<ReturnType<typeof surfaceSetup>>) => {
  surface.destroy()
  setup.renderer.destroy()
}

const markdownStream = async (): Promise<TerminalBenchmarkMetric> => {
  const runtime = await surfaceSetup()
  try {
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
    await runtime.setup.renderOnce()
    return await measuredScenario("markdown-stream", async (record) => {
      let arrival = now()
      while (offset < source.length) {
        const length = 8 + ((revision * 17) % 57)
        offset = Math.min(source.length, offset + length)
        const wait = arrival - now()
        if (wait > 0) await Bun.sleep(wait)
        await record(async () => {
          model = projectUnits(model, [assistantUnit("tentative:benchmark", source.slice(0, offset), revision)])
          runtime.surface.update(model)
          await runtime.setup.renderOnce()
        })
        revision += 1
        arrival += 5
      }
    })
  } finally {
    destroySurface(runtime)
  }
}

const toolOutput = async (): Promise<TerminalBenchmarkMetric> => {
  const runtime = await surfaceSetup()
  try {
    let model: Model = {
      ...initial("/benchmark", "medium"),
      width: 120,
      height: 36,
      currentThreadId: "benchmark",
    }
    return await measuredScenario("tool-output", async (record) => {
      for (let index = 0; index < 30; index += 1)
        await record(async () => {
          model = projectUnits(model, [toolUnit(index)])
          runtime.surface.update(model)
          await runtime.setup.renderOnce()
        })
    })
  } finally {
    destroySurface(runtime)
  }
}

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

const transcriptScroll = async (): Promise<TerminalBenchmarkMetric> => {
  const runtime = await surfaceSetup()
  try {
    return await measuredScenario("transcript-scroll", async (record) => {
      const model = transcriptModel()
      runtime.surface.update(model)
      await runtime.setup.renderOnce()
      runtime.surface.transcriptScroll.scrollTop = 0
      const page = Math.max(1, runtime.surface.transcriptScroll.viewport.height - 1)
      const maximum = Math.max(
        0,
        runtime.surface.transcriptScroll.scrollHeight - runtime.surface.transcriptScroll.viewport.height,
      )
      for (let position = 0; position <= maximum; position += page)
        await record(async () => {
          runtime.surface.transcriptScroll.scrollTop = Math.min(maximum, position)
          runtime.setup.renderer.requestRender()
          await runtime.setup.renderOnce()
        })
    })
  } finally {
    destroySurface(runtime)
  }
}

const composerPaste = async (): Promise<TerminalBenchmarkMetric> => {
  const runtime = await surfaceSetup()
  try {
    const base: Model = {
      ...initial("/benchmark", "medium"),
      width: 120,
      height: 36,
      currentThreadId: "benchmark",
    }
    runtime.surface.update(base)
    await runtime.setup.renderOnce()
    const pasted = Array.from({ length: 3_000 }, (_, index) => `line ${index} 界🙂`).join("\n")
    return await measuredScenario("composer-paste", async (record) =>
      record(async () => {
        runtime.surface.update({ ...base, input: pasted, cursor: pasted.length })
        await runtime.setup.renderOnce()
      }),
    )
  } finally {
    destroySurface(runtime)
  }
}

const resizeStorm = async (): Promise<TerminalBenchmarkMetric> => {
  const runtime = await surfaceSetup()
  try {
    let model = transcriptModel()
    runtime.surface.update(model)
    await runtime.setup.renderOnce()
    return await measuredScenario("resize-storm", async (record) => {
      for (let index = 0; index < 20; index += 1)
        await record(async () => {
          const width = index % 2 === 0 ? 80 : 140
          const height = index % 3 === 0 ? 28 : 40
          runtime.setup.resize(width, height)
          model = { ...model, width, height }
          runtime.surface.update(model)
          await runtime.setup.renderOnce()
        })
    })
  } finally {
    destroySurface(runtime)
  }
}

export const runTerminalBenchmark = async (): Promise<TerminalBenchmarkResult> => {
  const metrics = [
    await markdownStream(),
    await toolOutput(),
    await transcriptScroll(),
    await composerPaste(),
    await resizeStorm(),
  ]
  const runtime = await surfaceSetup(120, 36, true)
  try {
    runtime.surface.update({
      ...initial("/benchmark", "medium"),
      width: 120,
      height: 36,
      currentThreadId: "benchmark",
      entries: [{ role: "assistant", text: "Settled" }],
    })
    await runtime.setup.renderOnce()
    const animations = runtime.surface.animationDiagnostics()
    await Bun.sleep(100)
    let idleFrames = 0
    const countFrame = () => {
      idleFrames += 1
    }
    runtime.setup.renderer.on(CliRenderEvents.FRAME, countFrame)
    const idleCpuBefore = process.cpuUsage()
    const idleObservedMs = 250
    await Bun.sleep(idleObservedMs)
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
  } finally {
    destroySurface(runtime)
  }
}

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
