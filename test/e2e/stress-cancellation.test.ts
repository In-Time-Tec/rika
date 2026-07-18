import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { assertNoResidueFiles } from "./lease-files"
import { run, runTest, sandbox } from "./process"
import { startResidentCommandClient } from "./resident-command-client"
import * as ResourceSampler from "./resource-sampler"
import { cleanupScenario, configureHomeState, printMetrics } from "./stress-support"

const ThreadJson = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))

test(
  "queued and active cancellation under load promotes the next FIFO turn without wedging",
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
              { parts: [{ type: "text", text: "CANCELLED_ACTIVE_OUTPUT" }], delayMs: 8_000 },
              ...Array.from({ length: 8 }, (_, index) => ({
                parts: [{ type: "text", text: `CANCEL_RESPONSE_${index}` }],
              })),
            ])
            const thread = yield* Schema.decodeUnknownEffect(ThreadJson)(
              (yield* run(context, ["threads", "new"])).stdout,
            )
            const client = yield* startResidentCommandClient(context, thread.id)
            yield* Effect.addFinalizer(() => Effect.promise(() => client.close()).pipe(Effect.ignore))
            const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            yield* Effect.promise(() =>
              Promise.all(
                Array.from({ length: 6 }, (_, index) =>
                  client.command({ _tag: "Submit", prompt: `CANCEL_PROMPT_${index}` }),
                ),
              ),
            )
            yield* Effect.promise(() =>
              client.waitFor(
                (events) =>
                  events.filter(
                    (event) =>
                      event._tag === "QueueUpdated" &&
                      typeof event.change === "object" &&
                      event.change !== null &&
                      "_tag" in event.change &&
                      event.change._tag === "Added",
                  ).length === 5,
              ),
            )
            const queued = client.events
              .filter(
                (event) =>
                  event._tag === "QueueUpdated" &&
                  typeof event.change === "object" &&
                  event.change !== null &&
                  "_tag" in event.change &&
                  event.change._tag === "Added",
              )
              .map(
                (event) => (event.change as { readonly item: { readonly id: string; readonly prompt: string } }).item,
              )
            const cancelledQueued = [queued[1]!, queued[3]!]
            yield* Effect.promise(() =>
              Promise.all(cancelledQueued.map((turn) => client.command({ _tag: "Dequeue", turnId: turn.id }))),
            )
            yield* Effect.promise(() => client.command({ _tag: "Cancel" }))
            yield* Effect.promise(() =>
              client.waitFor(
                (events) =>
                  events.filter((event) => event._tag === "TurnStarted").length === 4 &&
                  events.some((event) => event._tag === "QueueUpdated" && event.queuedCount === 0),
                30_000,
              ),
            )

            const started = client.events.filter((event) => event._tag === "TurnStarted")
            const startedPrompts = started.map((event) => (event.turn as { readonly prompt?: string }).prompt)
            const controls = client.events.filter((event) => event._tag === "ExecutionControlled")
            const failures = client.events.filter((event) => event._tag === "ExecutionFailed")
            expect(startedPrompts).toEqual(["CANCEL_PROMPT_0", "CANCEL_PROMPT_1", "CANCEL_PROMPT_3", "CANCEL_PROMPT_5"])
            expect(startedPrompts).not.toContain(cancelledQueued[0]!.prompt)
            expect(startedPrompts).not.toContain(cancelledQueued[1]!.prompt)
            expect(controls.some((event) => event.action === "cancelled" && event.turnId !== undefined)).toBe(true)
            expect(failures).toEqual([])
            const completedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

            yield* Effect.promise(() => client.close())
            yield* Effect.sleep("1 second")
            const orphans = yield* cleanupScenario()
            expect(orphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)
            yield* printMetrics("cancellation", {
              submitted: 6,
              queuedCancelled: cancelledQueued.length,
              activeCancelled: 1,
              turnsStarted: started.length,
              queueDrained: true,
              executionFailures: failures.length,
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
