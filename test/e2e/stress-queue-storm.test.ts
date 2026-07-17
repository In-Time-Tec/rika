import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { assertNoResidueFiles, findResidueFiles } from "./lease-files"
import { startPackagedPty } from "./packaged-pty"
import { run, runTest, sandbox } from "./process"
import { startResidentCommandClient, type ResidentEvent } from "./resident-command-client"
import * as ResourceSampler from "./resource-sampler"
import { cleanupScenario, configureHomeState, printMetrics } from "./stress-support"

const ThreadJson = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
const submitted = 101
const capacity = 64
const admitted = capacity + 1

const eventText = (event: ResidentEvent) => {
  const execution = event.event
  return typeof execution === "object" &&
    execution !== null &&
    "type" in execution &&
    execution.type === "model.output.delta" &&
    "text" in execution &&
    typeof execution.text === "string"
    ? execution.text
    : ""
}

const queueScript = (prefix: string) => [
  { parts: [{ type: "text", text: `${prefix}_000` }], delayMs: 4_000 },
  ...Array.from({ length: capacity }, (_, index) => ({
    parts: [{ type: "text", text: `${prefix}_${String(index + 1).padStart(3, "0")}` }],
  })),
]

test(
  "one thread durably admits a bounded FIFO queue and explicitly rejects overflow",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            yield* configureHomeState(context)
            context.env.RIKA_INTERNAL_RESIDENT_GRACE = "500"
            delete context.env.RIKA_TEST_MODEL_RESPONSE
            context.env.RIKA_TEST_MODEL_SCRIPT = JSON.stringify(queueScript("QUEUE_RESPONSE"))
            const thread = yield* Schema.decodeUnknownEffect(ThreadJson)(
              (yield* run(context, ["threads", "new"])).stdout,
            )
            const client = yield* startResidentCommandClient(context, thread.id)
            yield* Effect.addFinalizer(() => Effect.promise(() => client.close()).pipe(Effect.ignore))
            const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            const outcomes = yield* Effect.promise(() =>
              Promise.all(
                Array.from({ length: submitted }, (_, index) =>
                  client.command({ _tag: "Submit", prompt: `QUEUE_PROMPT_${String(index).padStart(3, "0")}` }),
                ),
              ),
            )
            expect(outcomes.every((outcome) => !outcome.failed)).toBe(true)
            yield* Effect.promise(() =>
              client.waitFor(
                (events) =>
                  events.filter((event) => event._tag === "TurnStarted").length === admitted &&
                  events.map(eventText).join("").includes("QUEUE_RESPONSE_064"),
                60_000,
              ),
            )

            const queueFull = client.events.filter((event) => event._tag === "QueueFull")
            const queueUpdates = client.events.filter((event) => event._tag === "QueueUpdated")
            const additions = queueUpdates.filter(
              (event) =>
                typeof event.change === "object" &&
                event.change !== null &&
                "_tag" in event.change &&
                event.change._tag === "Added",
            )
            const removals = queueUpdates.filter(
              (event) =>
                typeof event.change === "object" &&
                event.change !== null &&
                "_tag" in event.change &&
                event.change._tag === "Removed",
            )
            const started = client.events.filter((event) => event._tag === "TurnStarted")
            const prompts = started.map((event) => {
              const turn = event.turn
              return typeof turn === "object" && turn !== null && "prompt" in turn ? turn.prompt : undefined
            })
            const responseText = client.events
              .filter((event) => event._tag === "TranscriptPatched")
              .map(eventText)
              .join("")
            const responseOrder = Array.from(responseText.matchAll(/QUEUE_RESPONSE_(\d{3})/g), (matched) =>
              Number(matched[1]),
            )
            const additionCounts = additions.map((event) => Number(event.queuedCount))
            const removalCounts = removals.map((event) => Number(event.queuedCount))

            expect(queueFull).toHaveLength(submitted - admitted)
            expect(queueFull.every((event) => event.capacity === capacity && event.count === capacity)).toBe(true)
            expect(additionCounts).toEqual(Array.from({ length: capacity }, (_, index) => index + 1))
            expect(removalCounts).toEqual(Array.from({ length: capacity }, (_, index) => capacity - index - 1))
            expect(prompts).toEqual(
              Array.from({ length: admitted }, (_, index) => `QUEUE_PROMPT_${String(index).padStart(3, "0")}`),
            )
            expect(responseOrder).toEqual(Array.from({ length: admitted }, (_, index) => index))
            expect(new Set(prompts).size).toBe(admitted)
            expect(new Set(responseOrder).size).toBe(admitted)
            const completedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

            yield* Effect.promise(() => client.close())
            yield* Effect.sleep("1 second")
            const orphans = yield* cleanupScenario()
            expect(orphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)
            yield* printMetrics("queue-storm", {
              clients: 1,
              submitted,
              admitted,
              rejectedQueueFull: queueFull.length,
              queueCapacity: capacity,
              queueAdditions: additions.length,
              queueRemovals: removals.length,
              turnsStarted: started.length,
              responsesCompleted: responseOrder.length,
              duplicates: prompts.length - new Set(prompts).size,
              losses: admitted - responseOrder.length,
              durationMilliseconds: completedAt - startedAt,
              orphanProcesses: orphans.length,
              residueFiles: 0,
            })
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 100 })), Effect.scoped),
    ),
  90_000,
)

test(
  "the packaged TUI keeps every queued prompt visible without the old queue marker",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            yield* configureHomeState(context)
            delete context.env.RIKA_TEST_MODEL_RESPONSE
            context.env.RIKA_TEST_MODEL_SCRIPT = JSON.stringify([
              { parts: [{ type: "text", text: "QUEUE_UI_ACTIVE" }], delayMs: 4_000 },
              { parts: [{ type: "text", text: "queue UI title" }] },
              ...Array.from({ length: 6 }, (_, index) => ({
                parts: [{ type: "text", text: `QUEUE_UI_${index}` }],
              })),
            ])
            const actions = Array.from({ length: 7 }, (_, index) => [
              { atMilliseconds: 600 + index * 120, type: "write" as const, text: `queue ui prompt ${index}` },
              { atMilliseconds: 650 + index * 120, type: "write" as const, key: "enter" as const },
            ]).flat()
            const client = yield* startPackagedPty(context, {
              durationMilliseconds: 7_000,
              readyTarget: "Welcome to Rika",
              target: "queue ui prompt 6",
              actions,
            })
            const result = yield* client.result
            const residue = yield* findResidueFiles(context.env.HOME!)
            yield* printMetrics("queue-storm-ui", {
              submitted: 7,
              projectedFullPendingSet: result.observedTarget,
              oldQueueMarkerVisible: result.captureText.includes("queued 6/6"),
              residueFiles: residue.length,
            })
            expect(result.exitCode).toBe(0)
            expect(result.observedTarget).toBe(true)
            expect(result.captureText).toContain("queue ui prompt 6")
            expect(result.captureText).not.toContain("queued 6/6")
            yield* assertNoResidueFiles(context.env.HOME!)
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 100 })), Effect.scoped),
    ),
  20_000,
)

test.skipIf(Bun.env.RIKA_STRESS_MULTI_CLIENT !== "1")(
  "multiple command clients preserve one active mutation stream under a queue storm",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            yield* configureHomeState(context)
            context.env.RIKA_INTERNAL_RESIDENT_GRACE = "500"
            delete context.env.RIKA_TEST_MODEL_RESPONSE
            context.env.RIKA_TEST_MODEL_SCRIPT = JSON.stringify(queueScript("MULTI_RESPONSE"))
            const thread = yield* Schema.decodeUnknownEffect(ThreadJson)(
              (yield* run(context, ["threads", "new"])).stdout,
            )
            const clients = yield* Effect.all(
              Array.from({ length: 4 }, () => startResidentCommandClient(context, thread.id)),
              { concurrency: 4 },
            )
            yield* Effect.promise(() =>
              Promise.all(
                Array.from({ length: submitted }, (_, index) =>
                  clients[index % clients.length]!.command({ _tag: "Submit", prompt: `MULTI_PROMPT_${index}` }),
                ),
              ),
            )
            yield* Effect.promise(() =>
              clients[0]!.waitFor(
                (events) =>
                  events.filter((event) => event._tag === "TurnStarted").length === admitted &&
                  events.map(eventText).join("").includes("MULTI_RESPONSE_064"),
                60_000,
              ),
            )
            const events = clients[0]!.events
            const queueFull = clients.flatMap((commandClient) =>
              commandClient.events.filter((event) => event._tag === "QueueFull"),
            )
            const queueUpdates = events.filter((event) => event._tag === "QueueUpdated")
            const additions = queueUpdates.filter(
              (event) =>
                typeof event.change === "object" &&
                event.change !== null &&
                "_tag" in event.change &&
                event.change._tag === "Added",
            )
            const removals = queueUpdates.filter(
              (event) =>
                typeof event.change === "object" &&
                event.change !== null &&
                "_tag" in event.change &&
                event.change._tag === "Removed",
            )
            const started = events.filter((event) => event._tag === "TurnStarted")
            const startedIds = started.map((event) => (event.turn as { readonly id: string }).id)
            const queuedIds = additions.map(
              (event) => (event.change as { readonly item: { readonly id: string } }).item.id,
            )
            const responseOrder = Array.from(
              events
                .filter((event) => event._tag === "TranscriptPatched")
                .map(eventText)
                .join("")
                .matchAll(/MULTI_RESPONSE_(\d{3})/g),
              (matched) => Number(matched[1]),
            )
            const terminalIndexes = events.flatMap((event, index) =>
              event._tag === "TranscriptPatched" &&
              typeof event.event === "object" &&
              event.event !== null &&
              "type" in event.event &&
              event.event.type === "execution.completed"
                ? [index]
                : [],
            )
            const startedIndexes = events.flatMap((event, index) => (event._tag === "TurnStarted" ? [index] : []))
            const uniqueStartedIds = new Set(startedIds)
            expect(uniqueStartedIds.size).toBe(admitted)
            expect(queueFull).toHaveLength(submitted - admitted)
            expect(additions.map((event) => Number(event.queuedCount))).toEqual(
              Array.from({ length: capacity }, (_, index) => index + 1),
            )
            expect(removals.map((event) => Number(event.queuedCount))).toEqual(
              Array.from({ length: capacity }, (_, index) => capacity - index - 1),
            )
            expect(startedIds).toEqual([startedIds[0]!, ...queuedIds])
            expect(responseOrder).toEqual(Array.from({ length: admitted }, (_, index) => index))
            expect(
              startedIndexes
                .slice(1)
                .every((index, position) =>
                  terminalIndexes.some((terminal) => terminal > startedIndexes[position]! && terminal < index),
                ),
            ).toBe(true)
            expect(
              clients.every(
                (client) => client.events.filter((event) => event._tag === "TurnStarted").length === admitted,
              ),
            ).toBe(true)
            yield* Effect.promise(() => Promise.all(clients.map((client) => client.close())).then(() => undefined))
            yield* Effect.sleep("1 second")
            const orphans = yield* cleanupScenario()
            expect(orphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)
            yield* printMetrics("queue-storm-multi-client", {
              clients: clients.length,
              submitted,
              admitted,
              rejectedQueueFull: queueFull.length,
              queueAdditions: additions.length,
              queueRemovals: removals.length,
              uniqueTurnsStarted: uniqueStartedIds.size,
              responsesCompleted: responseOrder.length,
              oneActiveMutation: true,
              orphanProcesses: orphans.length,
              residueFiles: 0,
            })
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 100 })), Effect.scoped),
    ),
  90_000,
)
