import { expect, test } from "vitest"
import { Config, Console, Effect, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { assertNoResidueFiles } from "./lease-files"
import { runPackagedFanOut } from "./packaged-fan-out"
import * as ResourceSampler from "./resource-sampler"
import { runTest, sandbox } from "./process"

const supportedClientCounts = new Set([1, 10, 25, 100, 200])

test("resource sampler catches and cleans a grandchild after its client exits", () =>
  runTest(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const sampler = yield* ResourceSampler.Service
      const client = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", 'sh -c "sleep 60 & wait" &'], {
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      const clientPid = Number(client.pid)
      yield* sampler.track([clientPid])
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(-clientPid, "SIGKILL")
          } catch {}
        }),
      )
      expect(Number(yield* client.exitCode)).toBe(0)
      const detected = yield* sampler.scanOrphans
      expect(detected.some((entry) => entry.command.includes("sleep"))).toBe(true)
      const cleanup = yield* sampler.terminateOrphans
      expect(cleanup.detected.some((entry) => entry.command.includes("sleep"))).toBe(true)
      expect(cleanup.remaining).toEqual([])
    }).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 25 })), Effect.scoped),
  ))

test("resource sampler excludes its own process probes from tracked trees", () =>
  runTest(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const sampler = yield* ResourceSampler.Service
      const client = yield* spawner.spawn(
        ChildProcess.make("sleep", ["60"], {
          detached: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      yield* Effect.addFinalizer(() => client.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore))
      yield* sampler.track([Number(client.pid)])
      const detected = yield* sampler.scanOrphans
      expect(
        detected.filter(
          (entry) =>
            entry.parentPid === process.pid && /^\(?(?:ps|pgrep|lsof)\)?$/.test(entry.command.split("/").at(-1) ?? ""),
        ),
      ).toEqual([])
    }).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 25 })), Effect.scoped),
  ))

test("resource sampler does not adopt an untracked sibling in the same process group", () =>
  runTest(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const sampler = yield* ResourceSampler.Service
      const tracked = yield* spawner.spawn(
        ChildProcess.make("sleep", ["60"], {
          detached: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      const sibling = yield* spawner.spawn(
        ChildProcess.make("sleep", ["60"], {
          detached: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      yield* Effect.addFinalizer(() =>
        Effect.all([tracked.kill({ killSignal: "SIGKILL" }), sibling.kill({ killSignal: "SIGKILL" })], {
          concurrency: 2,
          discard: true,
        }).pipe(Effect.ignore),
      )
      yield* sampler.track([Number(tracked.pid)])
      const detected = yield* sampler.scanOrphans
      expect(detected.some((entry) => entry.pid === Number(tracked.pid))).toBe(true)
      expect(detected.some((entry) => entry.pid === Number(sibling.pid))).toBe(false)
    }).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 25 })), Effect.scoped),
  ))

test(
  "packaged fan-out cleans the first client and host when a later client fails",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const wrapper = path.join(context.root, "fail-after-first")
            const firstClient = path.join(context.root, "first-client")
            yield* fileSystem.writeFileString(
              wrapper,
              '#!/bin/sh\nif mkdir "$RIKA_STRESS_FIRST_CLIENT" 2>/dev/null; then\n  exec "$RIKA_STRESS_REAL_BINARY" "$@"\nfi\nexit 23\n',
            )
            yield* fileSystem.chmod(wrapper, 0o755)
            const failed = yield* Effect.exit(
              runPackagedFanOut(
                {
                  ...context,
                  binary: wrapper,
                  env: {
                    ...context.env,
                    RIKA_STRESS_FIRST_CLIENT: firstClient,
                    RIKA_STRESS_REAL_BINARY: context.binary,
                  },
                },
                { clientCount: 3, spawnConcurrency: 2 },
              ).pipe(Effect.scoped),
            )
            expect(failed._tag).toBe("Failure")
            const sampler = yield* ResourceSampler.Service
            expect(yield* sampler.scanOrphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 25 })), Effect.scoped),
    ),
  30_000,
)

test(
  "packaged stress harness attaches the selected client scale and tears down every resource",
  () =>
    runTest(
      Effect.acquireUseRelease(
        sandbox,
        (context) =>
          Effect.gen(function* () {
            const clientCount = yield* Config.int("RIKA_STRESS_CLIENTS").pipe(Config.withDefault(10))
            expect(supportedClientCounts.has(clientCount)).toBe(true)
            const run = yield* runPackagedFanOut(context, {
              clientCount,
              spawnConcurrency: 16,
            })
            expect(run.attachments).toHaveLength(clientCount)
            expect(run.attachments.filter((attachment) => attachment.error !== undefined)).toEqual([])
            expect(run.attachments[0]?.owner).toBe(true)
            expect(run.attachments.slice(1).every((attachment) => !attachment.owner)).toBe(true)
            expect(new Set(run.attachments.map((attachment) => attachment.hostPid))).toEqual(new Set([run.hostPid]))
            expect(new Set(run.attachments.map((attachment) => attachment.connectionId)).size).toBe(clientCount)

            const cleanup = yield* run.teardown
            expect(cleanup.orphans).toEqual([])
            yield* assertNoResidueFiles(context.env.HOME!)

            const series = yield* run.hostResources.series
            const summary = yield* run.hostResources.summary
            expect(series.length).toBeGreaterThan(0)
            yield* Console.log(`RIKA_STRESS_METRICS ${JSON.stringify(summary)}`)
          }),
        (context) => context.dispose,
      ).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 50 })), Effect.scoped),
    ),
  110_000,
)
