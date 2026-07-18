import { expect, test } from "vitest"
import { Config, Effect } from "effect"
import { assertNoResidueFiles } from "./lease-files"
import { startPackagedPty } from "./packaged-pty"
import { runTest, sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"
import {
  cleanupScenario,
  configureHomeState,
  printMetrics,
  processChildren,
  rssTrend,
  waitForHostConnections,
  waitUntil,
} from "./stress-support"

const idleClients = 10
const samplingIntervalMilliseconds = 250
const settleMilliseconds = 5_000

const retainedRssKilobytes = (series: ReadonlyArray<ResourceSampler.ResourceSample>) =>
  Math.min(
    ...series
      .slice(-Math.floor(settleMilliseconds / samplingIntervalMilliseconds))
      .map((sample) => sample.rssKilobytes),
  )

test(
  "ten idle packaged clients keep host CPU and resident memory stable",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const idleMilliseconds = Math.max(
              5_000,
              yield* Config.int("RIKA_STRESS_IDLE_MS").pipe(Config.withDefault(20_000)),
            )
            const dataRoot = yield* configureHomeState(context)
            const clients = yield* Effect.forEach(
              Array.from({ length: idleClients }),
              () => startPackagedPty(context, { durationMilliseconds: idleMilliseconds + 20_000 }),
              { concurrency: idleClients },
            )
            const host = yield* waitForHostConnections(dataRoot, idleClients)
            const clientPid = yield* waitUntil(
              "wait for packaged TUI runtime",
              processChildren(clients[0]!.processPid).pipe(Effect.map((pids) => pids[0])),
            )
            yield* Effect.sleep("2 seconds")
            const sampler = yield* ResourceSampler.Service
            const hostResources = yield* sampler.watch(host.hostPid)
            const clientResources = yield* sampler.watch(clientPid)
            yield* Effect.sleep(`${idleMilliseconds / 2} millis`)
            yield* Effect.sleep(`${settleMilliseconds} millis`)
            const retainedHostAfterFirstPhase = retainedRssKilobytes(yield* hostResources.series)
            const retainedClientAfterFirstPhase = retainedRssKilobytes(yield* clientResources.series)
            yield* Effect.sleep(`${idleMilliseconds / 2} millis`)
            yield* Effect.sleep(`${settleMilliseconds} millis`)
            yield* Effect.all([hostResources.stop, clientResources.stop], { concurrency: 2, discard: true })

            const hostSeries = yield* hostResources.series
            const clientSeries = yield* clientResources.series
            const hostSummary = yield* hostResources.summary
            const clientSummary = yield* clientResources.summary
            const hostTrend = rssTrend(hostSeries)
            const clientTrend = rssTrend(clientSeries)
            const retainedHostAfterSecondPhase = retainedRssKilobytes(hostSeries)
            const retainedClientAfterSecondPhase = retainedRssKilobytes(clientSeries)
            const hostGrowthAllowance = Math.max(1_024, retainedHostAfterFirstPhase * 0.02)
            const clientGrowthAllowance = 32 * 1_024
            const clientTransientCeilingKilobytes = 512 * 1_024

            expect(hostSummary.samples).toBeGreaterThanOrEqual(Math.floor(idleMilliseconds / 500))
            expect(clientSummary.samples).toBeGreaterThanOrEqual(Math.floor(idleMilliseconds / 500))
            expect(hostSummary.meanCpuPercent).toBeLessThan(5)
            expect(retainedHostAfterSecondPhase).toBeLessThanOrEqual(retainedHostAfterFirstPhase + hostGrowthAllowance)
            expect(retainedClientAfterSecondPhase).toBeLessThanOrEqual(
              retainedClientAfterFirstPhase + clientGrowthAllowance,
            )
            expect(clientSummary.peakRssKilobytes).toBeLessThan(clientTransientCeilingKilobytes)

            const results = yield* Effect.forEach(clients, (client) => client.stop, { concurrency: idleClients })
            expect(results).toHaveLength(idleClients)
            const orphans = yield* cleanupScenario()
            expect(orphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)
            yield* printMetrics("idle", {
              clients: idleClients,
              durationMilliseconds: idleMilliseconds,
              hostPid: host.hostPid,
              sampledClientPid: clientPid,
              host: { ...hostSummary, ...hostTrend },
              client: { ...clientSummary, ...clientTrend },
              retainedHostAfterFirstPhase,
              retainedHostAfterSecondPhase,
              retainedClientAfterFirstPhase,
              retainedClientAfterSecondPhase,
              hostCpuThresholdPercent: 5,
              hostRssGrowthAllowanceKilobytes: hostGrowthAllowance,
              clientRssGrowthAllowanceKilobytes: clientGrowthAllowance,
              clientTransientCeilingKilobytes,
              orphanProcesses: orphans.length,
              residueFiles: 0,
            })
          }),
        (context) => context.dispose,
      ).pipe(
        Effect.provide(ResourceSampler.layer({ intervalMilliseconds: samplingIntervalMilliseconds })),
        Effect.scoped,
      ),
    ),
  70_000,
)
