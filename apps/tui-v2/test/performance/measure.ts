import { testRender } from "@opentui/solid"
import { Clock, Effect } from "effect"
import { createComponent } from "solid-js"
import { App } from "../../src/app"
import { createWorkload, type WorkloadSize } from "../../src/scenarios/stress"

export interface MeasureOptions extends WorkloadSize {
  readonly iterations: number
  readonly idleMs: number
  readonly animate: boolean
  readonly idleOnly: boolean
}

export const distribution = (samples: readonly number[]) => {
  const sorted = samples.toSorted((a, b) => a - b)
  return {
    samples: [...samples],
    p50: sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)] ?? 0,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    max: sorted.at(-1) ?? 0,
  }
}

export const measure = Effect.fn("Benchmark.measure")(function* (options: MeasureOptions) {
  const start = yield* Clock.currentTimeNanos
  const cpuStart = process.cpuUsage()
  const rssSamples = [process.memoryUsage().rss]
  const workload = createWorkload(options)
  const seedMs = Number((yield* Clock.currentTimeNanos) - start) / 1_000_000
  const mountStart = yield* Clock.currentTimeNanos
  const screen = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      testRender(() => createComponent(App, { client: workload.client, animate: options.animate, onQuit: () => {} }), {
        width: 216,
        height: 62,
        exitOnCtrlC: false,
      }),
    ),
    (value) => Effect.sync(() => value.renderer.destroy()),
  )
  yield* Effect.tryPromise(() => screen.flush())
  if (screen.captureCharFrame().includes("[object Object]")) return yield* Effect.die("Invalid rich-text rendering")
  const mountMs = Number((yield* Clock.currentTimeNanos) - mountStart) / 1_000_000
  rssSamples.push(process.memoryUsage().rss)
  const idleBefore = { native: screen.getNativeStats(), frames: screen.renderer.getStats().frameCount }
  const idleStart = yield* Clock.currentTimeNanos
  const idleCpuStart = process.cpuUsage()
  yield* Effect.sleep(options.idleMs)
  const idleFramesBeforeFlush = screen.renderer.getStats().frameCount
  const idleCpuMicros = process.cpuUsage(idleCpuStart)
  const idleEnd = yield* Clock.currentTimeNanos
  const idleNativeAfterSleep = screen.getNativeStats()
  yield* Effect.tryPromise(() => screen.flush())
  const idle = {
    wallMs: Number(idleEnd - idleStart) / 1_000_000,
    cpuMicros: idleCpuMicros,
    frames: idleFramesBeforeFlush - idleBefore.frames,
    framesDuringSleep: idleFramesBeforeFlush - idleBefore.frames,
    framesDuringFlush: screen.renderer.getStats().frameCount - idleFramesBeforeFlush,
    before: idleBefore.native,
    after: idleNativeAfterSleep,
    afterFlush: screen.getNativeStats(),
  }
  const updateSamples: number[] = []
  const mutationSamples: number[] = []
  const flushSamples: number[] = []
  const modeSamples: number[] = []
  const paletteSamples: number[] = []
  const nativeSamples: ReturnType<typeof screen.getNativeStats>[] = []
  for (let iteration = 0; iteration < (options.idleOnly ? 0 : options.iterations); iteration += 1) {
    const updateStart = yield* Clock.currentTimeNanos
    workload.advance(iteration * 3)
    const flushStart = yield* Clock.currentTimeNanos
    mutationSamples.push(Number(flushStart - updateStart) / 1_000_000)
    yield* Effect.tryPromise(() => screen.flush())
    const updateEnd = yield* Clock.currentTimeNanos
    updateSamples.push(Number(updateEnd - updateStart) / 1_000_000)
    flushSamples.push(Number(updateEnd - flushStart) / 1_000_000)
    for (const overlay of ["mode", "palette"] as const) {
      const inputStart = yield* Clock.currentTimeNanos
      workload.advance(iteration * 3 + (overlay === "mode" ? 1 : 2))
      screen.mockInput.pressKey(overlay === "mode" ? "s" : "o", { ctrl: true })
      yield* Effect.tryPromise(() => screen.flush())
      const elapsed = Number((yield* Clock.currentTimeNanos) - inputStart) / 1_000_000
      const frame = screen.captureCharFrame()
      if (frame.includes("[object Object]")) return yield* Effect.die("Invalid rich-text rendering")
      if (!frame.includes(overlay === "mode" ? "Mode" : "Command Palette"))
        return yield* Effect.die(`Input failed to open ${overlay}`)
      if (overlay === "mode") modeSamples.push(elapsed)
      else paletteSamples.push(elapsed)
      screen.mockInput.pressKey(overlay === "mode" ? "s" : "o", { ctrl: true })
      yield* Effect.tryPromise(() => screen.flush())
    }
    nativeSamples.push(screen.getNativeStats())
    rssSamples.push(process.memoryUsage().rss)
  }
  return {
    workload: {
      ...options,
      toolCalls: workload.toolCalls,
      streamingToolCount: workload.streamingToolCount,
      transcriptItems: options.items + options.children + options.threads,
      activeUpdatesPerBurst:
        options.threads + Math.min(options.children, options.streams) + workload.streamingToolCount,
      pendingOperationsPerBurst: { edits: 1, appends: 1, dequeues: 1 },
      bursts: updateSamples.length * 3,
    },
    seedMs,
    mountMs,
    idle,
    updateFlushMs: distribution(updateSamples),
    synchronousMutationMs: distribution(mutationSamples),
    flushWaitMs: distribution(flushSamples),
    inputWithStreamingMs: { mode: distribution(modeSamples), palette: distribution(paletteSamples) },
    nativeSamples,
    cpuMicros: process.cpuUsage(cpuStart),
    wallMs: Number((yield* Clock.currentTimeNanos) - start) / 1_000_000,
    memory: {
      rssBytes: rssSamples,
      maxSampledRssBytes: Math.max(...rssSamples),
      final: process.memoryUsage(),
      maxRssKiB: process.resourceUsage().maxRSS,
    },
  }
})
