import { expect, test } from "vitest"
import { Effect } from "effect"
import { assertNoResidueFiles, findResidueFiles } from "./lease-files"
import { startPackagedPty, type PackagedPtyAction } from "./packaged-pty"
import { runTest, sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"
import { cleanupScenario, configureHomeState, printMetrics, processChildren, waitUntil } from "./stress-support"

const finalRows = 37
const finalColumns = 137

const resizeBurst = (offset: number): ReadonlyArray<PackagedPtyAction> => [
  { atMilliseconds: offset, type: "resize", rows: 20, columns: 70 },
  { atMilliseconds: offset + 20, type: "resize", rows: 55, columns: 180 },
  { atMilliseconds: offset + 40, type: "resize", rows: 25, columns: 90 },
  { atMilliseconds: offset + 60, type: "resize", rows: 60, columns: 200 },
  { atMilliseconds: offset + 80, type: "resize", rows: finalRows, columns: finalColumns },
  { atMilliseconds: offset + 350, type: "probe" },
]

test(
  "rapid packaged PTY resizes converge to the exact trailing size while idle and streaming",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            yield* configureHomeState(context)
            delete context.env.RIKA_TEST_MODEL_RESPONSE
            context.env.RIKA_TEST_MODEL_SCRIPT = JSON.stringify([
              {
                parts: Array.from({ length: 1_000 }, (_, index) => ({ type: "text", text: `RESIZE_${index};` })),
                delayMs: 1_000,
              },
            ])
            const sampler = yield* ResourceSampler.Service
            const measurements = [] as Array<{
              mode: "idle" | "streaming"
              meanCpuPercent: number
              peakCpuPercent: number
              finalRows: number
              finalColumns: number
            }>
            for (const mode of ["idle", "streaming"] as const) {
              const actions: ReadonlyArray<PackagedPtyAction> = [
                ...(mode === "streaming"
                  ? [
                      { atMilliseconds: 1_000, type: "write", text: "resize stream" } as const,
                      { atMilliseconds: 1_100, type: "write", key: "enter" } as const,
                    ]
                  : []),
                ...resizeBurst(1_500),
                ...resizeBurst(2_500),
                ...resizeBurst(3_500),
              ]
              const client = yield* startPackagedPty(context, {
                durationMilliseconds: 6_000,
                readyTarget: "Welcome to Rika",
                actions,
              })
              const runtimePid = yield* waitUntil(
                "find resize TUI runtime",
                processChildren(client.processPid).pipe(Effect.map((pids) => pids[0])),
              )
              const resources = yield* sampler.watch(runtimePid)
              const result = yield* client.result
              yield* resources.stop
              const summary = yield* resources.summary
              const series = yield* resources.series
              const finalSnapshot = result.snapshots.at(-1)!
              expect(result.exitCode).toBe(0)
              expect(result.finalRows).toBe(finalRows)
              expect(result.finalColumns).toBe(finalColumns)
              expect(finalSnapshot.rows).toBe(finalRows)
              expect(finalSnapshot.columns).toBe(finalColumns)
              expect(finalSnapshot.screen.split("\n").length).toBeLessThanOrEqual(finalRows)
              expect(Math.max(...finalSnapshot.screen.split("\n").map((line) => line.length))).toBeLessThanOrEqual(
                finalColumns,
              )
              expect(summary.meanCpuPercent).toBeLessThan(80)
              measurements.push({
                mode,
                meanCpuPercent: summary.meanCpuPercent,
                peakCpuPercent: Math.max(...series.map((sample) => sample.cpuPercent)),
                finalRows: result.finalRows,
                finalColumns: result.finalColumns,
              })
            }

            const orphans = yield* cleanupScenario()
            expect(orphans).toEqual([])
            const residue = yield* findResidueFiles(context.env.HOME!)
            yield* printMetrics("resize", {
              burstsPerMode: 3,
              resizesPerBurst: 5,
              trailingDebounceMilliseconds: 270,
              measurements,
              cpuThresholdPercent: 80,
              orphanProcesses: orphans.length,
              residueFiles: residue.length,
            })
            yield* assertNoResidueFiles(context.env.HOME!)
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 50 })), Effect.scoped),
    ),
  45_000,
)
