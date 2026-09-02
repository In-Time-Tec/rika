import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { runTerminalBenchmark, terminalBenchmarkTable } from "../../src/performance/benchmark"

it.live(
  "keeps representative terminal workloads within CI performance envelopes",
  () =>
    Effect.gen(function* () {
      const result = yield* runTerminalBenchmark()
      yield* Effect.logInfo("terminal benchmark", terminalBenchmarkTable(result), { idle: result.idle })

      const metric = (scenario: (typeof result.metrics)[number]["scenario"]) =>
        result.metrics.find((candidate) => candidate.scenario === scenario)!
      const stream = metric("markdown-stream")
      const scroll = metric("transcript-scroll")
      const resize = metric("resize-storm")

      expect(stream.latencyP95Ms).toBeLessThanOrEqual(24)
      expect(stream.latencyMaxMs).toBeLessThanOrEqual(48)
      expect(stream.markdownLexerInvocations).toBeLessThanOrEqual(Math.ceil((stream.events / 200) * 2) + 2)
      expect(stream.fullTranscriptCopiesPerEvent).toBe(0)
      expect(stream.renderablesCreated).toBeLessThanOrEqual(128)
      expect(scroll.heapGrowthMb).toBeLessThanOrEqual(60)
      expect(scroll.latencyP95Ms).toBeLessThanOrEqual(24)
      expect(resize.latencyP95Ms).toBeLessThanOrEqual(150)
      expect(result.idle.loaderRunning).toBe(false)
      expect(result.idle.welcomeRunning).toBe(false)
      expect(result.idle.frames).toBe(0)
      // Zero idle frames is the proof that the renderer does no work. The CPU figure is whole-process
      // (Vitest worker, Effect scheduler, GC) over a 250 ms window, so it only guards against a busy loop.
      expect(result.idle.cpuMs).toBeLessThanOrEqual(60)
    }),
  60_000,
)
