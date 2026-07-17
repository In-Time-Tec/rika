import { expect, test } from "bun:test"
import { Effect, FileSystem, Path } from "effect"
import { assertNoResidueFiles, findResidueFiles } from "./lease-files"
import { startPackagedPty } from "./packaged-pty"
import { command, runTest, sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"
import { cleanupScenario, configureHomeState, printMetrics, processChildren, waitUntil } from "./stress-support"

const defaultTiers = [0, 50, 500, 10_000]

test(
  "changed-files sidebar CPU and interaction stay bounded from zero through ten thousand files",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            yield* configureHomeState(context)
            delete context.env.RIKA_TEST_MODEL_RESPONSE
            context.env.RIKA_TEST_MODEL_SCRIPT = JSON.stringify(
              defaultTiers.map((tier) => ({
                parts: Array.from({ length: 400 }, (_, index) => ({
                  type: "text",
                  text: `SIDEBAR_${tier}_${String(index).padStart(3, "0")};`,
                })),
                delayMs: 2_000,
              })),
            )
            expect(
              Number(
                yield* command("git", ["init", "--quiet"], {
                  cwd: context.workspace,
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                }),
              ),
            ).toBe(0)
            const sampler = yield* ResourceSampler.Service
            const measurements = new Array<{
              files: number
              meanCpuPercent: number
              peakRssKilobytes: number
              probeLatencyMilliseconds: number
            }>()
            let generated = 0
            for (const tier of defaultTiers) {
              yield* Effect.forEach(
                Array.from({ length: tier - generated }, (_, index) => generated + index),
                (index) =>
                  fileSystem.writeFileString(
                    path.join(context.workspace, `stress-file-${String(index).padStart(5, "0")}.txt`),
                    `${index}\n`,
                  ),
                { concurrency: 64, discard: true },
              )
              generated = tier
              const client = yield* startPackagedPty(context, {
                durationMilliseconds: 8_000,
                gracefulStopMilliseconds: 10_000,
                readyTarget: "Welcome to Rika",
                target: `Changed files (${tier})`,
                actions: [
                  { atMilliseconds: 1_500, type: "write", text: `sidebar tier ${tier}` },
                  { atMilliseconds: 1_600, type: "write", key: "enter" },
                  {
                    atMilliseconds: 2_000,
                    type: "write",
                    bytes: [27, 115],
                    expectedMarker: `Changed files (${tier})`,
                    markerTimeoutMilliseconds: 3_000,
                  },
                ],
              })
              const runtimePid = yield* waitUntil(
                "find sidebar TUI runtime",
                processChildren(client.processPid).pipe(Effect.map((pids) => pids[0])),
              )
              const resources = yield* sampler.watch(runtimePid)
              const result = yield* client.result
              yield* resources.stop
              const summary = yield* resources.summary
              const probe = result.probeLatencies.find((latency) => latency.marker === `Changed files (${tier})`)
              expect(result.exitCode).toBe(0)
              expect(result.observedTarget).toBe(true)
              expect(probe?.observed).toBe(true)
              expect(probe?.latencyMilliseconds).toBeLessThan(3_000)
              measurements.push({
                files: tier,
                meanCpuPercent: summary.meanCpuPercent,
                peakRssKilobytes: summary.peakRssKilobytes,
                probeLatencyMilliseconds: probe!.latencyMilliseconds,
              })
            }
            const fifty = measurements.find((measurement) => measurement.files === 50)!
            const tenThousand = measurements.find((measurement) => measurement.files === 10_000)!
            const cpuRatio = tenThousand.meanCpuPercent / Math.max(0.5, fifty.meanCpuPercent)
            expect(cpuRatio).toBeLessThan(4)

            const orphans = yield* cleanupScenario()
            expect(orphans).toEqual([])
            const residue = yield* findResidueFiles(context.env.HOME!)
            yield* printMetrics("sidebar-scale", {
              tiers: measurements,
              cpuRatio10kTo50: cpuRatio,
              cpuRatioThreshold: 4,
              interactionLatencyThresholdMilliseconds: 3_000,
              orphanProcesses: orphans.length,
              residueFiles: residue.length,
            })
            yield* assertNoResidueFiles(context.env.HOME!)
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 100 })), Effect.scoped),
    ),
  120_000,
)
