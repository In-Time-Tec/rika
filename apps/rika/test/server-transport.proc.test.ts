import { afterEach, describe, expect, test } from "vitest"
import { Clock, Effect, Fiber, FileSystem } from "effect"
import { makeRoot, run, waitUntil } from "./server-transport-runtime"
import { cleanRoot, fileExists, readText } from "./server-transport-files"
import { alive, attachedEffect, start } from "./server-transport-process"
import { killTrackedHosts } from "./server-process-exit"

afterEach(() => killTrackedHosts())

describe("server WebSocket process transport", () => {
  test(
    "rejects an unsafe existing token without starting an owner",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString(`${root}/server.token`, `${"a".repeat(64)}\n`, { mode: 0o644 })
            const startedAt = yield* Clock.currentTimeMillis
            const client = yield* start(root)
            expect(yield* client.nextEffect).toMatchObject({
              type: "rejected",
              error: "Server credential is unsafe",
            })
            expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(2_000)
            expect(yield* fileExists(`${root}/owner-acquisitions.log`)).toBe(false)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    10_000,
  )

  test(
    "keeps a healthy connection through a one-second client stall",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 2_000)
            yield* attachedEffect(client)
            yield* client.send("stall")
            expect((yield* client.nextEffect).type).toBe("stall-survived")
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "lets the first one-shot client exit without stopping its distinct host",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const oneShot = yield* start(root, 1_000)
            const first = yield* attachedEffect(oneShot)
            const closing = yield* oneShot.closeEffect.pipe(Effect.forkScoped)
            expect(alive(first.hostPid!)).toBe(true)

            const next = yield* start(root, 1_000)
            expect((yield* attachedEffect(next)).hostPid).toBe(first.hostPid)
            yield* Fiber.join(closing)
            yield* oneShot.awaitExit
            yield* next.send("ping")
            expect((yield* next.nextEffect).type).toBe("pong")
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "completes forwarded output and client-owned interactive sessions",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            const event = yield* attachedEffect(client)

            yield* client.send("output")
            expect(yield* client.nextEffect).toEqual({
              type: "output",
              text: `{"hostPid":${event.hostPid}}\n`,
            })
            expect((yield* client.nextEffect).type).toBe("output-completed")

            yield* client.send("interactive")
            expect((yield* client.nextEffect).type).toBe("interactive-callback")
            expect(yield* client.nextEffect).toEqual({
              type: "interactive-event",
              tag: "ThreadsListed",
            })
            expect((yield* client.nextEffect).type).toBe("interactive-completed")
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "forwards sanitized child visual patches through the server feed",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("child-execution-interactive")
            expect(yield* client.nextEffect).toEqual({
              type: "child-execution-events-completed",
              tags: ["Child started", "Child read src/a.ts", "Child review complete"],
            })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "forwards 200ms tool lifecycle events into distinct TUI model states",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("timed-tool-interactive")
            const event = yield* client.nextEffect
            expect(event.type).toBe("timed-tool-events-completed")
            const tags = event.tags ?? []
            expect(tags.map((tag) => tag.split(":")[0])).toEqual(["running", "running", "complete", "complete"])
            const times = tags.map((tag) => Number(tag.split(":")[1]))
            expect(times[1]! - times[0]!).toBeLessThan(100)
            expect(times[2]! - times[0]!).toBeGreaterThanOrEqual(100)
            expect(times[3]! - times[2]!).toBeGreaterThanOrEqual(100)
            expect(tags.map((tag) => tag.split(":")[2])).toEqual([
              "Running 1 tool",
              "Running 2 tools",
              "Running 1 tool",
              "Waiting",
            ])
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "launching client supersedes a compatible different build while two interactive clients stay alive",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const mismatched = yield* start(root, 1_000, 0, false, 1_024, 0, false, undefined, 0, {
              script: "test/fixtures/server-mismatched-client.ts",
              environment: {
                RIKA_TEST_SERVER_HOST_SCRIPT: "test/fixtures/server-mismatched-host.ts",
                RIKA_TEST_BUILD_IDENTITY: "rika-test-other-build",
              },
            })
            const oldAttached = yield* attachedEffect(mismatched)
            const second = yield* start(root, 1_000, 0, false, 1_024, 0, false, undefined, 0, {
              script: "test/fixtures/server-mismatched-client.ts",
              environment: {
                RIKA_TEST_SERVER_HOST_SCRIPT: "test/fixtures/server-mismatched-host.ts",
                RIKA_TEST_BUILD_IDENTITY: "rika-test-other-build",
              },
            })
            const secondAttached = yield* attachedEffect(second)
            expect(secondAttached.hostPid).toBe(oldAttached.hostPid)
            yield* mismatched.send("upgrade-interactive")
            yield* second.send("upgrade-interactive")
            expect(yield* mismatched.nextEffect).toMatchObject({ type: "interactive-callback", callbacks: 1 })
            expect((yield* mismatched.nextEffect).type).toBe("initial-read")
            expect(yield* second.nextEffect).toMatchObject({ type: "interactive-callback", callbacks: 1 })
            expect((yield* second.nextEffect).type).toBe("initial-read")

            const current = yield* start(root, 1_000)
            expect(yield* current.nextEffect).toEqual({ type: "server-status", callbacks: 1 })
            const newAttached = yield* attachedEffect(current)
            expect(newAttached.hostPid).not.toBe(oldAttached.hostPid)
            yield* waitUntil(
              Effect.sync(() => !alive(oldAttached.hostPid!)),
              3_000,
            )

            for (const client of [mismatched, second]) {
              let event = yield* client.nextEffect
              while (event.type !== "upgrade-survived") {
                expect(event.type).not.toBe("server-status")
                expect(event.type).not.toBe("restart-required")
                expect(event.type).not.toBe("interactive-callback")
                event = yield* client.nextEffect
              }
              expect(event).toMatchObject({ tag: "ThreadsListed", callbacks: 1 })
            }
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(
              `${oldAttached.hostPid}\n${newAttached.hostPid}\n`,
            )

            yield* Effect.sleep("750 millis")
            expect(alive(newAttached.hostPid!)).toBe(true)
            yield* current.send("ping")
            expect((yield* current.nextEffect).type).toBe("pong")
            yield* mismatched.kill
            yield* second.kill
            yield* current.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    20_000,
  )

  test(
    "keeps a different-build server alive while a root and delegated child execution are active",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const mismatched = yield* start(root, 1_000, 0, true, 1_024, 0, false, undefined, 0, {
              script: "test/fixtures/server-mismatched-client.ts",
              environment: {
                RIKA_TEST_SERVER_HOST_SCRIPT: "test/fixtures/server-mismatched-host.ts",
                RIKA_TEST_BUILD_IDENTITY: "rika-test-other-build",
                RIKA_TEST_SERVER_ACTIVE_WORK_MILLIS: "1000",
              },
            })
            const oldAttached = yield* attachedEffect(mismatched)
            yield* mismatched.send("active-root-with-child")
            yield* waitUntil(fileExists(`${root}/active-executions.log`))

            const current = yield* start(root, 1_000)
            expect(yield* current.nextEffect).toMatchObject({
              type: "rejected",
              tag: "ServerServiceError",
              error: expect.stringContaining("replacement is delayed"),
            })
            expect(alive(oldAttached.hostPid!)).toBe(true)
            expect(yield* readText(`${root}/active-executions.log`)).toBe(
              `${oldAttached.hostPid}:root\n${oldAttached.hostPid}:child\n`,
            )
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(`${oldAttached.hostPid}\n`)

            yield* waitUntil(fileExists(`${root}/delayed-work-finalizations.log`), 3_000)
            const retry = yield* start(root, 1_000)
            expect(yield* retry.nextEffect).toEqual({ type: "server-status", callbacks: 1 })
            const replacement = yield* attachedEffect(retry)
            expect(replacement.hostPid).not.toBe(oldAttached.hostPid)
            yield* waitUntil(
              Effect.sync(() => !alive(oldAttached.hostPid!)),
              3_000,
            )
            yield* retry.closeEffect
            yield* mismatched.kill
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "a client without supersede rights attaches to a compatible different build",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const mismatched = yield* start(root, 1_000, 0, false, 1_024, 0, false, undefined, 0, {
              script: "test/fixtures/server-mismatched-client.ts",
              environment: {
                RIKA_TEST_SERVER_HOST_SCRIPT: "test/fixtures/server-mismatched-host.ts",
                RIKA_TEST_BUILD_IDENTITY: "rika-test-other-build",
              },
            })
            const oldAttached = yield* attachedEffect(mismatched)

            const restarted = yield* start(root, 1_000, 0, false, 1_024, 0, false, undefined, 0, {
              environment: { RIKA_TEST_SERVER_NO_SUPERSEDE: "1" },
            })
            const attached = yield* attachedEffect(restarted)
            expect(attached.hostPid).toBe(oldAttached.hostPid)
            expect(alive(oldAttached.hostPid!)).toBe(true)
            yield* mismatched.send("ping")
            expect((yield* mismatched.nextEffect).type).toBe("pong")
            yield* restarted.closeEffect
            yield* mismatched.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "reports an interactive operation failure before the client callback starts",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("rejected-interactive")
            expect(yield* client.nextEffect).toEqual({
              type: "interactive-rejected",
              error: "Interactive setup rejected",
            })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )
})
