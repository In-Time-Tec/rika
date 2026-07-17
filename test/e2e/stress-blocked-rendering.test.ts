import { expect, test } from "bun:test"
import { Effect } from "effect"
import { assertNoResidueFiles, findResidueFiles } from "./lease-files"
import { startPackagedPty } from "./packaged-pty"
import { runTest, sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"
import {
  cleanupScenario,
  configureHomeState,
  hostConnections,
  printMetrics,
  readDiagnosticEvents,
  rssTrend,
  waitForHostConnections,
} from "./stress-support"

test(
  "a TUI stopped for twelve seconds during output resumes without disconnect or unbounded host buffering",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const dataRoot = yield* configureHomeState(context)
            delete context.env.RIKA_TEST_MODEL_RESPONSE
            context.env.RIKA_TEST_MODEL_SCRIPT = JSON.stringify([
              {
                parts: Array.from({ length: 4_000 }, (_, index) => ({
                  type: "text",
                  text: `BLOCKED_CHUNK_${String(index).padStart(4, "0")};`,
                })),
                delayMs: 2_000,
              },
              { parts: [{ type: "text", text: "blocked rendering title" }] },
              { parts: [{ type: "text", text: "BLOCKED_RESUMED_OK" }] },
            ])
            const client = yield* startPackagedPty(context, {
              durationMilliseconds: 25_000,
              readyTarget: "Welcome to Rika",
              target: "BLOCKED_RESUMED_OK",
              actions: [
                { atMilliseconds: 800, type: "write", text: "blocked rendering stream" },
                { atMilliseconds: 900, type: "write", key: "enter" },
                { atMilliseconds: 1_500, type: "signal", signal: "stop" },
                { atMilliseconds: 13_500, type: "signal", signal: "continue" },
                { atMilliseconds: 17_000, type: "write", text: "prove rendering resumed" },
                {
                  atMilliseconds: 17_100,
                  type: "write",
                  key: "enter",
                  expectedMarker: "BLOCKED_RESUMED_OK",
                  markerTimeoutMilliseconds: 7_000,
                },
              ],
            })
            const initial = yield* waitForHostConnections(dataRoot, 1)
            const hostResources = yield* ResourceSampler.Service.pipe(
              Effect.flatMap((sampler) => sampler.watch(initial.hostPid)),
            )
            const result = yield* client.result
            yield* hostResources.stop
            const series = yield* hostResources.series
            const summary = yield* hostResources.summary
            const trend = rssTrend(series)
            const diagnosticEvents = yield* readDiagnosticEvents(dataRoot)
            const hosts = hostConnections(diagnosticEvents)
            const sameHost = hosts.find((host) => host.hostPid === initial.hostPid)
            const replacementHosts = hosts.filter(
              (host) => host.hostPid !== initial.hostPid && host.accepted.length > 0,
            )
            const resumed = result.probeLatencies.find((probe) => probe.marker === "BLOCKED_RESUMED_OK")

            const orphans = yield* cleanupScenario()
            const residue = yield* findResidueFiles(context.env.HOME!)
            const feedEvents = diagnosticEvents.filter((event) => String(event.message).startsWith("resident.feed."))
            const detailSent = feedEvents.find((event) => event.message === "resident.feed.detail_sent")
            const feedQueued = Number(detailSent?.annotations["rika.resident.feed.queued"])
            const feedOverflowed = detailSent?.annotations["rika.resident.feed.overflowed"]
            const transientCeilingKilobytes = 512 * 1_024
            yield* printMetrics("blocked-rendering", {
              stoppedMilliseconds: 12_000,
              hostPid: initial.hostPid,
              acceptedConnections: sameHost?.accepted.length ?? 0,
              replacementHosts: replacementHosts.length,
              observerDeliveredFinalMarker: result.observedTarget,
              resumedMarkerLatencyMilliseconds: resumed?.latencyMilliseconds,
              transportPath: replacementHosts.length === 0 ? "connection-preserved" : "explicit-resync",
              outputChunks: 4_000,
              host: { ...summary, ...trend },
              transientCeilingKilobytes,
              orphanProcesses: orphans.length,
              residueFiles: residue.length,
              feedEvents: feedEvents.map((event) => ({
                message: event.message,
                sent: event.annotations["rika.resident.feed.sent"],
                queued: event.annotations["rika.resident.feed.queued"],
                overflowed: event.annotations["rika.resident.feed.overflowed"],
                sequence: event.annotations["rika.resident.feed.sequence"],
              })),
            })
            expect(result.exitCode).toBe(0)
            expect(result.observedTarget).toBe(true)
            expect(resumed?.observed).toBe(true)
            expect(resumed?.latencyMilliseconds).toBeLessThan(7_000)
            expect(sameHost?.accepted).toHaveLength(1)
            expect(replacementHosts).toEqual([])
            expect(summary.peakRssKilobytes).toBeLessThan(transientCeilingKilobytes)
            expect(feedQueued).toBeLessThanOrEqual(1_024)
            expect(feedOverflowed).toBe(true)
            expect(feedEvents.map((event) => event.message)).toEqual(
              expect.arrayContaining(["resident.feed.barrier_sent", "resident.feed.barrier_received"]),
            )
            expect(orphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 100 })), Effect.scoped),
    ),
  45_000,
)
