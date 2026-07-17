import { expect, test } from "bun:test"
import { Effect, Fiber, Schema } from "effect"
import { assertNoResidueFiles } from "./lease-files"
import { startPackagedPty } from "./packaged-pty"
import { run, runTest, sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"
import { cleanupScenario, configureHomeState, printMetrics, waitForHostConnections } from "./stress-support"

const ThreadJson = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
const churnBaseline = "RIKA_STRESS_CHURN_BASELINE"
const churnTarget = "RIKA_STRESS_CHURN_COMPLETE"

const eventSequences = (output: string) =>
  output
    .split("\n")
    .map((line) => Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(line))
    .filter((decoded) => decoded._tag === "Some")
    .map((decoded) => decoded.value)
    .filter(
      (value): value is { readonly sequence: number } =>
        typeof value === "object" && value !== null && "sequence" in value && typeof value.sequence === "number",
    )
    .map((value) => value.sequence)

test(
  "packaged clients can join and disconnect while one deterministic execution streams without event loss",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const dataRoot = yield* configureHomeState(context)
            delete context.env.RIKA_TEST_MODEL_RESPONSE
            context.env.RIKA_TEST_MODEL_SCRIPT = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)([
              { parts: [{ type: "text", text: churnBaseline }] },
              { parts: [{ type: "text", text: churnTarget }], delayMs: 8_000 },
              { parts: [{ type: "text", text: "Stress churn thread" }] },
              { parts: [{ type: "text", text: "unused" }] },
              { parts: [{ type: "text", text: "unused" }] },
            ])
            const created = yield* Schema.decodeUnknownEffect(ThreadJson)(
              (yield* run(context, ["threads", "new"])).stdout,
            )
            expect((yield* run(context, ["threads", "rename", created.id, "Stress churn"])).exitCode).toBe(0)
            expect((yield* run(context, ["run", "--thread", created.id, "seed churn feed"])).stdout).toContain(
              churnBaseline,
            )

            const startWatchers = (count: number) =>
              Effect.forEach(
                Array.from({ length: count }),
                () =>
                  startPackagedPty(context, {
                    arguments: ["--thread", created.id],
                    durationMilliseconds: 30_000,
                    target: "CHURN_COMPLETE",
                    readyTarget: "CHURN_BASELINE",
                    readyTimeoutMilliseconds: 60_000,
                  }),
                { concurrency: count },
              )
            const initial = yield* startWatchers(4)
            const attached = yield* waitForHostConnections(dataRoot, 4)
            const hostResources = yield* ResourceSampler.Service.pipe(
              Effect.flatMap((sampler) => sampler.watch(attached.hostPid)),
            )
            yield* Effect.sleep("1500 millis")
            const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            const execution = yield* Effect.forkScoped(
              run(context, ["run", "--thread", created.id, "--stream-json", "long deterministic turn"], {
                timeout: 25_000,
              }),
            )
            yield* waitForHostConnections(dataRoot, 5)
            yield* Effect.sleep("750 millis")

            const firstWave = yield* startWatchers(4)
            yield* waitForHostConnections(dataRoot, 9)
            const firstKilled = [initial[0]!, initial[1]!, firstWave[0]!, firstWave[1]!]
            yield* Effect.forEach(firstKilled, (client) => client.stop, { concurrency: 4, discard: true })
            yield* Effect.sleep("750 millis")

            const secondWave = yield* startWatchers(4)
            yield* waitForHostConnections(dataRoot, 7)
            const secondKilled = [secondWave[0]!, secondWave[1]!]
            yield* Effect.forEach(secondKilled, (client) => client.stop, { concurrency: 2, discard: true })
            const survivors = [initial[2]!, initial[3]!, firstWave[2]!, firstWave[3]!, secondWave[2]!, secondWave[3]!]

            const executionResult = yield* Fiber.join(execution)
            expect(executionResult.exitCode).toBe(0)
            expect(executionResult.stdout).toContain(churnTarget)
            const sequences = eventSequences(executionResult.stdout)
            expect(sequences.length).toBeGreaterThan(1)
            expect(new Set(sequences).size).toBe(sequences.length)
            for (let index = 1; index < sequences.length; index += 1)
              expect(sequences[index]).toBe(sequences[index - 1]! + 1)

            yield* Effect.sleep("750 millis")
            expect(
              yield* ResourceSampler.Service.pipe(Effect.flatMap((sampler) => sampler.snapshot(attached.hostPid))),
            ).toBeDefined()
            const survivorResults = yield* Effect.forEach(survivors, (client) => client.stop, { concurrency: 6 })
            const observedSurvivors = survivorResults.filter((result) => result.observedTarget).length

            const completedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            yield* hostResources.stop
            const hostSummary = yield* hostResources.summary
            const orphans = yield* cleanupScenario()
            expect(orphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)
            yield* printMetrics("churn", {
              hostPid: attached.hostPid,
              clientsStarted: 12,
              clientsKilledDuringExecution: 6,
              survivingClients: survivors.length,
              survivorsReceivingFinalEvent: observedSurvivors,
              eventCount: sequences.length,
              firstEventSequence: sequences[0],
              lastEventSequence: sequences.at(-1),
              durationMilliseconds: completedAt - startedAt,
              orphanProcesses: orphans.length,
              residueFiles: 0,
              host: hostSummary,
            })
            expect(observedSurvivors).toBe(survivors.length)
            expect(survivorResults.every((result) => result.captureText.includes("CHURN_COMPLETE"))).toBe(true)
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 100 })), Effect.scoped),
    ),
  120_000,
)
