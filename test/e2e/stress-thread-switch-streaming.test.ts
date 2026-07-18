import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { assertNoResidueFiles } from "./lease-files"
import { run, runTest, sandbox } from "./process"
import { startResidentCommandClient, type ResidentCommandClient, type ResidentEvent } from "./resident-command-client"
import * as ResourceSampler from "./resource-sampler"
import { cleanupScenario, configureHomeState, printMetrics } from "./stress-support"

const ThreadJson = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
const chunks = 100

const eventText = (event: ResidentEvent) => {
  const value = event.event
  return typeof value === "object" && value !== null && "text" in value && typeof value.text === "string"
    ? value.text
    : ""
}

const selectionText = (event: ResidentEvent) =>
  Array.isArray(event.entries)
    ? event.entries
        .map((entry) => {
          if (typeof entry !== "object" || entry === null || !("unit" in entry)) return ""
          const unit = entry.unit
          if (typeof unit !== "object" || unit === null || !("content" in unit)) return ""
          const content = unit.content
          return typeof content === "object" &&
            content !== null &&
            "_tag" in content &&
            content._tag === "Entry" &&
            "text" in content &&
            typeof content.text === "string"
            ? content.text
            : ""
        })
        .join("")
    : ""

const switchThreads = async (client: ResidentCommandClient, alpha: string, beta: string, cycles: number) => {
  for (let index = 0; index < cycles * 2; index += 1)
    await client.command({
      _tag: "SelectThread",
      threadId: index % 2 === 0 ? beta : alpha,
      selectionEpoch: index + 1,
    })
}

test(
  "two clients repeatedly switch away from a streaming thread and replay its complete ordered transcript",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            yield* configureHomeState(context)
            context.env.RIKA_INTERNAL_RESIDENT_GRACE = "500"
            delete context.env.RIKA_TEST_MODEL_RESPONSE
            context.env.RIKA_TEST_MODEL_SCRIPT = JSON.stringify([
              {
                parts: Array.from({ length: chunks }, (_, index) => ({
                  type: "text",
                  text: `SWITCH_CHUNK_${String(index).padStart(4, "0")};`,
                })),
                delayMs: 1_000,
              },
            ])
            const alpha = yield* Schema.decodeUnknownEffect(ThreadJson)(
              (yield* run(context, ["threads", "new"])).stdout,
            )
            const beta = yield* Schema.decodeUnknownEffect(ThreadJson)((yield* run(context, ["threads", "new"])).stdout)
            const clients = yield* Effect.all(
              [startResidentCommandClient(context, alpha.id), startResidentCommandClient(context, alpha.id)],
              { concurrency: 2 },
            )
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => Promise.all(clients.map((client) => client.close())).then(() => undefined)).pipe(
                Effect.ignore,
              ),
            )
            const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            yield* Effect.promise(() => clients[0]!.command({ _tag: "Submit", prompt: "stream while switching" }))
            yield* Effect.promise(() =>
              clients[0]!.waitFor((events) => events.some((event) => event._tag === "TurnStarted")),
            )
            const streamThreadId = String(clients[0]!.events.find((event) => event._tag === "TurnStarted")!.threadId)
            yield* Effect.promise(() =>
              Promise.all(clients.map((client) => switchThreads(client, streamThreadId, beta.id, 12))).then(
                () => undefined,
              ),
            )
            yield* Effect.promise(() =>
              clients[0]!.waitFor(
                (events) =>
                  events.map(eventText).join("").includes("SWITCH_CHUNK_0099") &&
                  events.some(
                    (event) =>
                      event._tag === "TranscriptPatched" &&
                      typeof event.event === "object" &&
                      event.event !== null &&
                      "type" in event.event &&
                      event.event.type === "execution.completed",
                  ),
              ),
            )
            yield* Effect.sleep("500 millis")
            yield* Effect.promise(() =>
              Promise.all(
                clients.map(async (client) => {
                  await client.command({ _tag: "SelectThread", threadId: beta.id, selectionEpoch: 99 })
                  await client.command({ _tag: "SelectThread", threadId: streamThreadId, selectionEpoch: 100 })
                }),
              ).then(() => undefined),
            )
            yield* Effect.promise(() =>
              Promise.all(
                clients.map((client) =>
                  client.waitFor(
                    (events) =>
                      events.some((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 100),
                    30_000,
                  ),
                ),
              ).then(() => undefined),
            )

            const replayed = clients.map((client) =>
              selectionText(
                client.events.find((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 100)!,
              ),
            )
            for (const transcript of replayed) {
              const order = Array.from(transcript.matchAll(/SWITCH_CHUNK_(\d{4})/g), (match) => Number(match[1]))
              expect(order).toEqual(Array.from({ length: chunks }, (_, index) => index))
              expect(new Set(order).size).toBe(chunks)
            }
            for (const client of clients)
              for (let index = 1; index < client.feedSequences.length; index += 1)
                expect(client.feedSequences[index]).toBe(client.feedSequences[index - 1]! + 1)
            expect(
              clients.every((client) => client.events.filter((event) => event._tag === "SelectionLoaded").length >= 24),
            ).toBe(true)
            const completedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

            yield* Effect.promise(() => Promise.all(clients.map((client) => client.close())).then(() => undefined))
            yield* Effect.sleep("1 second")
            const orphans = yield* cleanupScenario()
            expect(orphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)
            yield* printMetrics("thread-switch-streaming", {
              clients: clients.length,
              switchesPerClient: 24,
              streamChunks: chunks,
              replayedChunksPerClient: replayed.map(
                (transcript) => Array.from(transcript.matchAll(/SWITCH_CHUNK_/g)).length,
              ),
              feedEventsPerClient: clients.map((client) => client.feedSequences.length),
              durationMilliseconds: completedAt - startedAt,
              orphanProcesses: orphans.length,
              residueFiles: 0,
            })
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 100 })), Effect.scoped),
    ),
  60_000,
)
