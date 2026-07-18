import { expect, test } from "vitest"
import { Config, Effect, Schema } from "effect"
import { assertNoResidueFiles } from "./lease-files"
import { runPackagedFanOut } from "./packaged-fan-out"
import { run, runTest, sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"
import {
  configureHomeState,
  hostConnections,
  printMetrics,
  readDiagnosticEvents,
  waitForProcessExit,
  waitUntil,
} from "./stress-support"

const ThreadJson = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
const ThreadsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String })))
test(
  "a fresh fan-out elects a new host from the same durable connection state",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const restartClients = Math.max(
              10,
              yield* Config.int("RIKA_STRESS_RESTART_CLIENTS").pipe(Config.withDefault(10)),
            )
            const dataRoot = yield* configureHomeState(context)
            context.env.RIKA_INTERNAL_RESIDENT_GRACE = "10000"
            const created = yield* Schema.decodeUnknownEffect(ThreadJson)(
              (yield* run(context, ["threads", "new"])).stdout,
            )
            expect((yield* run(context, ["threads", "rename", created.id, "Durable restart thread"])).exitCode).toBe(0)

            const initialHost = yield* waitUntil(
              "find initial resident host",
              readDiagnosticEvents(dataRoot).pipe(
                Effect.map((events) => hostConnections(events).find((host) => host.accepted.length > 0)),
              ),
            )
            const initialSample = yield* ResourceSampler.Service.pipe(
              Effect.flatMap((sampler) => sampler.snapshot(initialHost.hostPid)),
            )
            expect(initialSample).toBeDefined()
            process.kill(initialHost.hostPid, "SIGTERM")
            yield* waitForProcessExit(initialHost.hostPid)
            yield* assertNoResidueFiles(context.env.HOME!)

            const second = yield* runPackagedFanOut(context, { clientCount: restartClients })
            expect(second.hostPid).not.toBe(initialHost.hostPid)
            expect(second.attachments).toHaveLength(restartClients)
            expect(second.attachments.filter((attachment) => attachment.error !== undefined)).toEqual([])
            expect(new Set(second.attachments.map((attachment) => attachment.hostPid))).toEqual(
              new Set([second.hostPid]),
            )
            expect(new Set(second.attachments.map((attachment) => attachment.connectionId)).size).toBe(restartClients)
            const threads = yield* Schema.decodeUnknownEffect(ThreadsJson)(
              (yield* run(context, ["threads", "list"])).stdout,
            )
            expect(threads.map((thread) => thread.id)).toContain(created.id)

            const secondSummary = yield* second.hostResources.summary
            const cleanup = yield* second.teardown
            expect(cleanup.orphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)
            yield* printMetrics("restart", {
              clients: restartClients,
              initialHostPid: initialHost.hostPid,
              replacementHostPid: second.hostPid,
              durableThreadsLoaded: threads.length,
              orphanProcesses: cleanup.orphans.length,
              residueFiles: 0,
              initialHost: initialSample,
              replacementHost: secondSummary,
            })
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 100 })), Effect.scoped),
    ),
  60_000,
)
