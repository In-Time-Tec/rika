import { expect, test } from "vitest"
import { Config, Effect, Schema } from "effect"
import { assertNoResidueFiles } from "./lease-files"
import { startPackagedPty } from "./pty"
import { run, runTest, sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"
import { cleanupScenario, configureHomeState, printMetrics } from "./stress-support"

const ThreadJson = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
const alphaMarker = "RIKA_STRESS_ALPHA_THREAD"
const betaMarker = "RIKA_STRESS_BETA_THREAD"

test(
  "one packaged TUI repeatedly opens, closes, and reopens durable threads",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const cycles = Math.max(10, yield* Config.int("RIKA_STRESS_THREAD_CYCLES").pipe(Config.withDefault(50)))
            yield* configureHomeState(context)
            const alpha = yield* Schema.decodeUnknownEffect(ThreadJson)(
              (yield* run(context, ["threads", "create"])).stdout,
            )
            const beta = yield* Schema.decodeUnknownEffect(ThreadJson)(
              (yield* run(context, ["threads", "create"])).stdout,
            )
            expect((yield* run(context, ["threads", "rename", alpha.id, "Alpha stress thread"])).exitCode).toBe(0)
            expect((yield* run(context, ["threads", "rename", beta.id, "Beta stress thread"])).exitCode).toBe(0)
            expect((yield* run(context, ["run", "--thread", alpha.id, alphaMarker])).exitCode).toBe(0)
            expect((yield* run(context, ["run", "--thread", beta.id, betaMarker])).exitCode).toBe(0)

            const client = yield* startPackagedPty(context, {
              arguments: ["--thread", alpha.id],
              durationMilliseconds: 45_000,
              cycle: {
                count: cycles,
                stepDelayMilliseconds: 150,
                targets: [
                  { query: "Beta stress", marker: "BETA_THREAD" },
                  { query: "Alpha stress", marker: "ALPHA_THREAD" },
                ],
              },
            })
            const result = yield* client.result
            expect(result.requestedCycles).toBe(cycles)
            expect(result.confirmedCycles).toBe(cycles)
            expect(result.captureText).not.toContain("Execution failed")
            expect(result.captureText).not.toContain("Resident connection closed")

            const orphans = yield* cleanupScenario()
            expect(orphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)
            yield* printMetrics("thread-reopen", {
              requestedCycles: cycles,
              confirmedCycles: result.confirmedCycles,
              durationMilliseconds: result.durationMilliseconds,
              orphanProcesses: orphans.length,
              residueFiles: 0,
            })
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 100 })), Effect.scoped),
    ),
  70_000,
)
