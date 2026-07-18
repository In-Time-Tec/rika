import { expect, test } from "vitest"
import { Effect } from "effect"
import { assertNoResidueFiles } from "./lease-files"
import { runPackagedFanOut } from "./packaged-fan-out"
import { runTest, sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"
import { printMetrics } from "./stress-support"

const scales = Bun.env.RIKA_STRESS_CLIENTS === "200" ? [25, 100, 200] : [25, 100]

for (const clientCount of scales)
  test(
    `packaged scale run attaches ${clientCount} clients to one host and tears down cleanly`,
    () =>
      runTest(
        Effect.acquireUseRelease(
          sandbox,
          (context) =>
            Effect.gen(function* () {
              const run = yield* runPackagedFanOut(context, { clientCount, spawnConcurrency: 16 })
              expect(run.attachments).toHaveLength(clientCount)
              expect(run.attachments.filter((attachment) => attachment.error !== undefined)).toEqual([])
              expect(run.attachments.filter((attachment) => attachment.owner)).toHaveLength(1)
              expect(new Set(run.attachments.map((attachment) => attachment.hostPid))).toEqual(new Set([run.hostPid]))
              expect(new Set(run.attachments.map((attachment) => attachment.connectionId)).size).toBe(clientCount)

              const cleanup = yield* run.teardown
              const summary = yield* run.hostResources.summary
              expect(cleanup.orphans).toEqual([])
              expect(summary.samples).toBeGreaterThan(0)
              expect(summary.peakRssKilobytes).toBeGreaterThan(0)
              expect(summary.meanCpuPercent).toBeGreaterThanOrEqual(0)
              yield* assertNoResidueFiles(context.env.HOME!)
              yield* printMetrics("scale", {
                clients: clientCount,
                hostPid: run.hostPid,
                connectionIds: clientCount,
                orphanProcesses: cleanup.orphans.length,
                residueFiles: 0,
                host: summary,
              })
            }),
          (context) => context.dispose,
        ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 50 })), Effect.scoped),
      ),
    115_000,
  )
