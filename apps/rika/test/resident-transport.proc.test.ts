import { afterEach, describe, expect, test } from "vitest"
import { Clock, Effect, Fiber, FileSystem } from "effect"
import { resolve } from "../src/resident-endpoint"
import {
  alive,
  attachedEffect,
  cleanRoot,
  fileExists,
  killTrackedHosts,
  legacyClose,
  makeRoot,
  readText,
  run,
  start,
  startOldResident,
  waitUntil,
} from "./resident-transport-harness"

afterEach(() => killTrackedHosts())

describe("resident WebSocket process transport", () => {
  test(
    "does not disclose credentials to or supersede a pre-proof resident",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          const old = yield* startOldResident(root)
          try {
            const client = yield* start(root, 1_000)
            expect(yield* client.nextEffect).toMatchObject({
              type: "rejected",
              tag: "ResidentServiceError",
            })
            expect(alive(Number(old.pid))).toBe(true)
            expect(yield* fileExists(`${root}/owner-acquisitions.log`)).toBe(false)
          } finally {
            yield* old.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "does not supersede a recorded frozen v3 resident from an unsigned close",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          const old = yield* startOldResident(root, true, "v3")
          try {
            const client = yield* start(root, 1_000)
            expect(yield* client.nextEffect).toMatchObject({
              type: "rejected",
              error: expect.stringContaining("unsigned resident incompatibility"),
            })
            expect(alive(Number(old.pid))).toBe(true)
            expect(yield* fileExists(`${root}/owner-acquisitions.log`)).toBe(false)
          } finally {
            yield* old.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "returns the frozen v3 restart signal without attaching the old client",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const current = yield* start(root, 1_000)
            yield* attachedEffect(current)
            const legacy = yield* start(root, 1_000, 0, false, 1_024, 0, false, undefined, 0, {
              script: "test/fixtures/resident-v3-client.ts",
            })
            expect(yield* legacy.nextEffect).toEqual({ type: "legacy-restart-required", callbacks: 4406 })
            yield* legacy.awaitExit
            yield* current.send("ping")
            expect((yield* current.nextEffect).type).toBe("pong")
            yield* current.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test.each(["proof", "nonce", "build", "kind"])(
    "rejects a frozen v3 client with a tampered %s before sending the upgrade signal",
    (tamper) =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const current = yield* start(root, 1_000)
            yield* attachedEffect(current)
            const legacy = yield* start(root, 1_000, 0, false, 1_024, 0, false, undefined, 0, {
              script: "test/fixtures/resident-v3-client.ts",
              environment: {
                RIKA_TEST_V3_EXPECT_CLOSE: "4400",
                RIKA_TEST_V3_TAMPER: tamper,
              },
            })
            expect(yield* legacy.nextEffect).toEqual({ type: "legacy-close", callbacks: 4400 })
            yield* legacy.awaitExit
            yield* current.send("ping")
            expect((yield* current.nextEffect).type).toBe("pong")
            yield* current.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "does not kill an unrecorded listener that only sends the legacy incompatibility close",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          const old = yield* startOldResident(root, false, "fake-incompatible")
          try {
            const client = yield* start(root, 1_000)
            expect(yield* client.nextEffect).toMatchObject({
              type: "rejected",
              error: expect.stringContaining("unsigned resident incompatibility"),
            })
            expect(alive(Number(old.pid))).toBe(true)
            expect(yield* fileExists(`${root}/owner-acquisitions.log`)).toBe(false)
          } finally {
            yield* old.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "closes an old-path client with a clean incompatibility signal",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000)
            yield* attachedEffect(client)
            const endpoint = yield* resolve("default", root)
            const closed = yield* legacyClose(endpoint.legacyUrl)
            const oldClientFailure =
              closed.code === 4403
                ? { reason: "upgrade-required", message: "Resident protocol upgrade required", startsHost: false }
                : { reason: "resident-absent", message: closed.reason, startsHost: true }
            expect(closed).toEqual({
              code: 4403,
              reason: "Resident protocol upgrade required",
            })
            expect(oldClientFailure).toEqual({
              reason: "upgrade-required",
              message: "Resident protocol upgrade required",
              startsHost: false,
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
    "does not replace a recorded listener that rejects both authenticated handshake schemas",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          const old = yield* startOldResident(root, true, "schema-reject")
          try {
            const client = yield* start(root, 1_000)
            expect(yield* client.nextEffect).toMatchObject({
              type: "rejected",
              error: expect.stringContaining("could not be authenticated"),
            })
            expect(alive(Number(old.pid))).toBe(true)
            expect(yield* fileExists(`${root}/owner-acquisitions.log`)).toBe(false)
          } finally {
            yield* old.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "fails once without spawning for an unrecorded pre-proof listener",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          const old = yield* startOldResident(root, false)
          try {
            const startedAt = yield* Clock.currentTimeMillis
            const client = yield* start(root, 1_000)
            expect(yield* client.nextEffect).toMatchObject({
              type: "rejected",
              error: expect.stringContaining("could not be authenticated"),
            })
            expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(4_000)
            expect(yield* fileExists(`${root}/owner-acquisitions.log`)).toBe(false)
          } finally {
            yield* old.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
            yield* cleanRoot(root)
          }
        }),
      ),
    10_000,
  )

  test(
    "does not supersede a listener matched only by a stale PID marker",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          const old = yield* startOldResident(root, false, "schema-reject")
          try {
            const fs = yield* FileSystem.FileSystem
            const staleMarker = `${root}/diagnostics/resident-stale-${old.pid}.open.jsonl`
            yield* fs.writeFileString(staleMarker, "", {
              mode: 0o600,
            })
            yield* fs.utimes(staleMarker, 0, 0)
            const client = yield* start(root, 1_000)
            expect(yield* client.nextEffect).toMatchObject({
              type: "rejected",
              error: expect.stringContaining("could not be authenticated"),
            })
            expect(alive(Number(old.pid))).toBe(true)
            expect(yield* fileExists(`${root}/owner-acquisitions.log`)).toBe(false)
          } finally {
            yield* old.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
            yield* cleanRoot(root)
          }
        }),
      ),
    10_000,
  )

  test(
    "rejects an unsafe existing token without starting an owner",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString(`${root}/resident.token`, `${"a".repeat(64)}\n`, { mode: 0o644 })
            const startedAt = yield* Clock.currentTimeMillis
            const client = yield* start(root)
            expect(yield* client.nextEffect).toMatchObject({
              type: "rejected",
              error: "Resident credential is unsafe",
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
    "forwards parent and child execution patches through the resident feed unchanged",
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
              tags: [
                "parent-turn:child_run.spawned",
                "parent-turn:child:oracle:tool.call.requested",
                "parent-turn:child:oracle:model.output.completed",
              ],
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
            expect(tags.map((tag) => tag.split(":")[0])).toEqual([
              "tool.call.requested",
              "tool.call.requested",
              "tool.result.received",
              "tool.result.received",
            ])
            const times = tags.map((tag) => Number(tag.split(":")[1]))
            expect(times[1]! - times[0]!).toBeLessThan(100)
            expect(times[2]! - times[0]!).toBeGreaterThanOrEqual(100)
            expect(times[3]! - times[2]!).toBeGreaterThanOrEqual(100)
            expect(tags.map((tag) => tag.split(":")[2])).toEqual([
              "Running tools",
              "Running tools",
              "Running tools",
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
              script: "test/fixtures/resident-mismatched-client.ts",
              environment: {
                RIKA_TEST_RESIDENT_HOST_SCRIPT: "test/fixtures/resident-mismatched-host.ts",
                RIKA_TEST_BUILD_IDENTITY: "rika-test-other-build",
              },
            })
            const oldAttached = yield* attachedEffect(mismatched)
            const second = yield* start(root, 1_000, 0, false, 1_024, 0, false, undefined, 0, {
              script: "test/fixtures/resident-mismatched-client.ts",
              environment: {
                RIKA_TEST_RESIDENT_HOST_SCRIPT: "test/fixtures/resident-mismatched-host.ts",
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
            expect(yield* current.nextEffect).toEqual({ type: "resident-status", callbacks: 1 })
            const newAttached = yield* attachedEffect(current)
            expect(newAttached.hostPid).not.toBe(oldAttached.hostPid)
            yield* waitUntil(
              Effect.sync(() => !alive(oldAttached.hostPid!)),
              3_000,
            )

            for (const client of [mismatched, second]) {
              let event = yield* client.nextEffect
              while (event.type !== "upgrade-survived") {
                expect(event.type).not.toBe("resident-status")
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
    "a reattaching client fails closed against a frozen v3 resident without replacing it",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          const old = yield* startOldResident(root, true, "v3")
          try {
            const client = yield* start(root, 1_000, 0, false, 1_024, 0, false, undefined, 0, {
              environment: { RIKA_TEST_RESIDENT_NO_SUPERSEDE: "1" },
            })
            expect(yield* client.nextEffect).toMatchObject({
              type: "rejected",
              tag: "ResidentServiceError",
              error: expect.stringContaining("unsigned resident incompatibility"),
            })
            expect(alive(Number(old.pid))).toBe(true)
            expect(yield* fileExists(`${root}/owner-acquisitions.log`)).toBe(false)
          } finally {
            yield* old.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
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
              script: "test/fixtures/resident-mismatched-client.ts",
              environment: {
                RIKA_TEST_RESIDENT_HOST_SCRIPT: "test/fixtures/resident-mismatched-host.ts",
                RIKA_TEST_BUILD_IDENTITY: "rika-test-other-build",
              },
            })
            const oldAttached = yield* attachedEffect(mismatched)

            const restarted = yield* start(root, 1_000, 0, false, 1_024, 0, false, undefined, 0, {
              environment: { RIKA_TEST_RESIDENT_NO_SUPERSEDE: "1" },
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
