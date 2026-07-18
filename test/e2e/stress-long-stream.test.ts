import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { assertNoResidueFiles } from "./lease-files"
import { startPackagedPty } from "./packaged-pty"
import { run, runTest, sandbox } from "./process"
import { startResidentCommandClient, type ResidentEvent } from "./resident-command-client"
import * as ResourceSampler from "./resource-sampler"
import {
  cleanupScenario,
  configureHomeState,
  printMetrics,
  processChildren,
  readDiagnosticEvents,
  rssTrend,
  waitForHostConnections,
  waitUntil,
} from "./stress-support"

const residentTurnsFinished = (dataRoot: string) =>
  readDiagnosticEvents(dataRoot).pipe(
    Effect.map((events) => events.filter((event) => event.message === "turn.finished").length),
  )

const ThreadJson = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
const chunks = 4_000

const executionText = (event: ResidentEvent) => {
  const value = event.event
  return typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "model.output.delta" &&
    "text" in value &&
    typeof value.text === "string"
    ? value.text
    : ""
}

test(
  "large reasoning, shell, patch, and model output completes in order with bounded resident and TUI RSS",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const dataRoot = yield* configureHomeState(context)
            context.env.RIKA_INTERNAL_RESIDENT_GRACE = "500"
            delete context.env.RIKA_TEST_MODEL_RESPONSE
            const patchLines = Array.from(
              { length: 500 },
              (_, index) => `+patch-line-${String(index).padStart(3, "0")}`,
            )
            context.env.RIKA_TEST_MODEL_SCRIPT = JSON.stringify([
              {
                parts: [
                  ...Array.from({ length: 500 }, (_, index) => ({ type: "reasoning", text: `REASON_${index};` })),
                  {
                    type: "toolCall",
                    name: "shell",
                    id: "long-shell",
                    params: {
                      command: "python3",
                      args: ["-c", "print('SHELL_OUTPUT_' * 12000)"],
                    },
                  },
                ],
              },
              {
                parts: [
                  { type: "reasoning", text: "PATCH_REASONING_COMPLETE" },
                  {
                    type: "toolCall",
                    name: "apply_patch",
                    id: "long-patch",
                    params: {
                      patchText: `*** Begin Patch\n*** Add File: long-stream-output.txt\n${patchLines.join("\n")}\n*** End Patch`,
                    },
                  },
                ],
              },
              {
                parts: Array.from({ length: chunks }, (_, index) => ({
                  type: "text",
                  text: `LONG_CHUNK_${String(index).padStart(4, "0")};`,
                })),
              },
              {
                parts: Array.from({ length: chunks }, (_, index) => ({
                  type: "text",
                  text: `SECOND_CHUNK_${String(index).padStart(4, "0")};`,
                })),
              },
            ])
            const thread = yield* Schema.decodeUnknownEffect(ThreadJson)(
              (yield* run(context, ["threads", "new"])).stdout,
            )
            const observer = yield* startPackagedPty(context, {
              arguments: ["--thread", thread.id],
              durationMilliseconds: 30_000,
              readyTarget: "$0.00",
              target: "LONG_CHUNK_3999",
            })
            const client = yield* startResidentCommandClient(context, thread.id)
            yield* Effect.addFinalizer(() => Effect.promise(() => client.close()).pipe(Effect.ignore))
            yield* Effect.promise(() =>
              client.command({ _tag: "SelectThread", threadId: thread.id, selectionEpoch: 1 }),
            )
            yield* Effect.promise(() =>
              client.waitFor(
                (events) => events.some((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 1),
                30_000,
              ),
            )
            const host = yield* waitForHostConnections(dataRoot, 2)
            const runtimePid = yield* waitUntil(
              "find long-stream TUI runtime",
              processChildren(observer.processPid).pipe(Effect.map((pids) => pids[0])),
            )
            const sampler = yield* ResourceSampler.Service
            const hostResources = yield* sampler.watch(host.hostPid)
            const clientResources = yield* sampler.watch(runtimePid)
            const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            yield* Effect.promise(() => client.command({ _tag: "Submit", prompt: "exercise every long output path" }))
            yield* Effect.promise(() =>
              client.waitFor(
                (events) =>
                  events
                    .filter((event) => event._tag === "TranscriptPatched")
                    .map(executionText)
                    .join("")
                    .includes("LONG_CHUNK_3999"),
                30_000,
              ),
            )
            const observerResult = yield* observer.stop
            yield* clientResources.stop
            const clientSeries = yield* clientResources.series
            const clientSummary = yield* clientResources.summary
            const clientTrend = rssTrend(clientSeries)
            const finishedTurnsAfterFirst = yield* waitUntil(
              "first long stream finished on resident",
              residentTurnsFinished(dataRoot).pipe(Effect.map((finished) => (finished >= 1 ? finished : undefined))),
              40_000,
            )
            yield* Effect.sleep("5 seconds")
            const retainedAfterFirstKilobytes = (yield* sampler.snapshot(host.hostPid))?.rssKilobytes ?? 0
            yield* Effect.promise(() => client.command({ _tag: "Submit", prompt: "second long output stream" }))
            yield* Effect.promise(() =>
              client.waitFor(
                (events) =>
                  events
                    .filter((event) => event._tag === "TranscriptPatched")
                    .map(executionText)
                    .join("")
                    .includes("SECOND_CHUNK_3999"),
                30_000,
              ),
            )
            yield* waitUntil(
              "second long stream finished on resident",
              residentTurnsFinished(dataRoot).pipe(
                Effect.map((finished) => (finished > finishedTurnsAfterFirst ? finished : undefined)),
              ),
              40_000,
            )
            yield* Effect.sleep("5 seconds")
            const retainedAfterSecondKilobytes = (yield* sampler.snapshot(host.hostPid))?.rssKilobytes ?? 0
            const retainedGrowthKilobytes = retainedAfterSecondKilobytes - retainedAfterFirstKilobytes
            yield* hostResources.stop
            const hostSeries = yield* hostResources.series
            const hostSummary = yield* hostResources.summary
            const hostTrend = rssTrend(hostSeries)
            const output = client.events
              .filter((event) => event._tag === "TranscriptPatched")
              .map(executionText)
              .join("")
            const serializedEvents = JSON.stringify(client.events)
            const order = Array.from(output.matchAll(/LONG_CHUNK_(\d{4})/g), (match) => Number(match[1]))
            const secondOrder = Array.from(output.matchAll(/SECOND_CHUNK_(\d{4})/g), (match) => Number(match[1]))
            const completedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

            yield* Effect.promise(() => client.close())
            yield* Effect.sleep("1 second")
            const orphans = yield* cleanupScenario()
            const retainedGrowthThresholdKilobytes = 32 * 1_024
            const transientCeilingKilobytes = 512 * 1_024
            const retainedMemoryWithinThreshold =
              retainedAfterSecondKilobytes <= retainedAfterFirstKilobytes + retainedGrowthThresholdKilobytes
            const transientMemoryWithinCeiling =
              hostSummary.peakRssKilobytes < transientCeilingKilobytes &&
              clientSummary.peakRssKilobytes < transientCeilingKilobytes
            yield* printMetrics("long-stream", {
              reasoningChunks: 501,
              shellOutputRequestedBytes: 156_000,
              patchLines: patchLines.length,
              modelOutputChunks: chunks,
              orderedChunks: order.length,
              secondStreamChunks: secondOrder.length,
              duplicates: order.length - new Set(order).size,
              observerDeliveredFinalMarker: observerResult.observedTarget,
              durationMilliseconds: completedAt - startedAt,
              host: { ...hostSummary, ...hostTrend },
              client: { ...clientSummary, ...clientTrend },
              retainedAfterFirstKilobytes,
              retainedAfterSecondKilobytes,
              retainedGrowthKilobytes,
              retainedGrowthThresholdKilobytes,
              retainedMemoryWithinThreshold,
              transientCeilingKilobytes,
              transientMemoryWithinCeiling,
              orphanProcesses: orphans.length,
              residueFiles: 0,
            })
            expect(order).toEqual(Array.from({ length: chunks }, (_, index) => index))
            expect(new Set(order).size).toBe(chunks)
            expect(secondOrder).toEqual(Array.from({ length: chunks }, (_, index) => index))
            expect(serializedEvents).toContain("SHELL_OUTPUT_")
            expect(serializedEvents).toContain("long-stream-output.txt")
            expect(retainedAfterSecondKilobytes).toBeLessThanOrEqual(
              retainedAfterFirstKilobytes + retainedGrowthThresholdKilobytes,
            )
            expect(hostSummary.peakRssKilobytes).toBeLessThan(transientCeilingKilobytes)
            expect(clientSummary.peakRssKilobytes).toBeLessThan(transientCeilingKilobytes)
            expect(observerResult.observedTarget).toBe(true)
            expect(orphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 100 })), Effect.scoped),
    ),
  90_000,
)
