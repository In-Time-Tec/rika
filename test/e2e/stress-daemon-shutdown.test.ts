import { expect, test } from "vitest"
import { Config, Effect } from "effect"
import { assertAndRemoveExpectedOpenLogs, assertNoResidueFiles } from "./lease-files"
import { startPackagedPty } from "./packaged-pty"
import { run, runTest, sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"
import {
  cleanupScenario,
  configureHomeState,
  hostConnections,
  printMetrics,
  readDiagnosticEvents,
  waitForHostConnections,
  waitForProcessExit,
  waitUntil,
} from "./stress-support"

test(
  "SIGTERM drains a packaged host with connected clients and a fresh client attaches after handoff",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const clientCount = Math.max(
              10,
              yield* Config.int("RIKA_STRESS_SHUTDOWN_CLIENTS").pipe(Config.withDefault(10)),
            )
            const dataRoot = yield* configureHomeState(context)
            const clients = yield* Effect.forEach(
              Array.from({ length: clientCount }),
              () => startPackagedPty(context, { durationMilliseconds: 30_000 }),
              { concurrency: 10 },
            )
            const initial = yield* waitForHostConnections(dataRoot, clientCount)
            expect(new Set(initial.active).size).toBe(clientCount)
            const hostResources = yield* ResourceSampler.Service.pipe(
              Effect.flatMap((sampler) => sampler.watch(initial.hostPid)),
            )

            process.kill(initial.hostPid, "SIGTERM")
            const gracefulExit = yield* Effect.exit(waitForProcessExit(initial.hostPid, 5_000))
            if (gracefulExit._tag === "Failure") {
              process.kill(initial.hostPid, "SIGKILL")
              yield* waitForProcessExit(initial.hostPid, 5_000)
            }
            const replacement = yield* waitForHostConnections(dataRoot, clientCount, new Set([initial.hostPid]))
            expect(replacement.hostPid).not.toBe(initial.hostPid)
            expect(new Set(replacement.active).size).toBe(clientCount)

            const fresh = yield* run(context, ["doctor"], { timeout: 15_000 })
            expect(fresh.exitCode).toBe(0)
            const afterFresh = yield* waitUntil(
              "wait for fresh client attachment",
              readDiagnosticEvents(dataRoot).pipe(
                Effect.map((events) => {
                  const host = hostConnections(events).find((candidate) => candidate.hostPid === replacement.hostPid)
                  return host !== undefined && host.accepted.length >= clientCount + 1 ? host : undefined
                }),
              ),
            )
            expect(new Set(afterFresh.accepted).size).toBeGreaterThanOrEqual(clientCount + 1)

            const clientResults = yield* Effect.forEach(clients, (client) => client.stop, { concurrency: 10 })
            expect(clientResults).toHaveLength(clientCount)
            expect(clientResults.every((result) => result.durationMilliseconds < 30_000)).toBe(true)
            yield* hostResources.stop
            const initialHostSummary = yield* hostResources.summary
            const orphans = yield* cleanupScenario()
            expect(orphans).toEqual([])
            if (gracefulExit._tag === "Failure") {
              const removed = yield* assertAndRemoveExpectedOpenLogs(context.env.HOME!, [initial.hostPid])
              expect(removed.map((entry) => entry.pid)).toEqual([initial.hostPid])
            } else {
              yield* assertNoResidueFiles(context.env.HOME!)
            }
            yield* printMetrics("daemon-shutdown", {
              clients: clientCount,
              initialHostPid: initial.hostPid,
              replacementHostPid: replacement.hostPid,
              handedOffConnections: replacement.active.length,
              freshClientAttached: true,
              sigtermExitedWithinMilliseconds: gracefulExit._tag === "Success" ? 5_000 : null,
              forcedKillRequired: gracefulExit._tag === "Failure",
              orphanProcesses: orphans.length,
              residueFiles: 0,
              initialHost: initialHostSummary,
            })
            expect(gracefulExit._tag).toBe("Success")
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 100 })), Effect.scoped),
    ),
  60_000,
)
