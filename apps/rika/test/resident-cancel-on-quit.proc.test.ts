import { afterEach, describe, expect, test } from "vitest"
import { Effect } from "effect"
import {
  alive,
  attachedEffect,
  cleanRoot,
  fileExists,
  killTrackedHosts,
  makeRoot,
  readText,
  run,
  start,
  startHostOnly,
  waitUntil,
} from "./resident-transport-harness"

afterEach(() => killTrackedHosts())

const abandonAfter = (milliseconds: number) => ({ RIKA_TEST_RESIDENT_ABANDON: String(milliseconds) })
const stayAbandoned = 200
const idleGrace = 10_000

describe("resident cancellation for abandoned clients", () => {
  test(
    "cancels recovered work when no client ever attaches after startup",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const host = yield* startHostOnly(root, {
              RIKA_TEST_RESIDENT_GRACE: String(idleGrace),
              RIKA_TEST_RESIDENT_ABANDON: String(stayAbandoned),
              RIKA_TEST_RESIDENT_INITIAL_ACTIVE_WORK: "1",
            })
            yield* waitUntil(fileExists(`${root}/stop-work.log`), 5_000)
            expect(yield* readText(`${root}/stop-work.log`)).toBe(`${host.pid}\n`)
            expect(alive(host.pid!)).toBe(true)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    20_000,
  )

  test(
    "cancels active execution work once a hard-killed client stays away",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, idleGrace, 0, true, 1_024, 0, false, undefined, 0, {
              environment: abandonAfter(200),
            })
            const attached = yield* attachedEffect(client)
            yield* client.send("active-root-with-child")
            yield* waitUntil(fileExists(`${root}/active-executions.log`))

            yield* client.kill
            yield* waitUntil(fileExists(`${root}/stop-work.log`), 5_000)
            expect(yield* readText(`${root}/stop-work.log`)).toBe(`${attached.hostPid}\n`)
            expect(alive(attached.hostPid!)).toBe(true)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    20_000,
  )

  test(
    "keeps active execution work while a replacement client reattaches inside the window",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, idleGrace, 0, true, 1_024, 0, false, undefined, 0, {
              environment: abandonAfter(1_500),
            })
            const attached = yield* attachedEffect(client)
            yield* client.send("active-root-with-child")
            yield* waitUntil(fileExists(`${root}/active-executions.log`))

            yield* client.kill
            const reattached = yield* start(root, idleGrace, 0, true, 1_024, 0, false, undefined, 0, {
              environment: abandonAfter(1_500),
            })
            expect((yield* attachedEffect(reattached)).hostPid).toBe(attached.hostPid)
            yield* Effect.sleep("2500 millis")

            expect(yield* fileExists(`${root}/stop-work.log`)).toBe(false)
            yield* reattached.send("ping")
            expect((yield* reattached.nextEffect).type).toBe("pong")
            yield* reattached.kill
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    25_000,
  )

  test(
    "keeps active execution work while another client stays attached",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const worker = yield* start(root, idleGrace, 0, true, 1_024, 0, false, undefined, 0, {
              environment: abandonAfter(200),
            })
            const attached = yield* attachedEffect(worker)
            const observer = yield* start(root, idleGrace, 0, true, 1_024, 0, false, undefined, 0, {
              environment: abandonAfter(200),
            })
            expect((yield* attachedEffect(observer)).hostPid).toBe(attached.hostPid)
            yield* worker.send("active-root-with-child")
            yield* waitUntil(fileExists(`${root}/active-executions.log`))

            yield* worker.kill
            yield* Effect.sleep("1500 millis")
            expect(yield* fileExists(`${root}/stop-work.log`)).toBe(false)

            yield* observer.kill
            yield* waitUntil(fileExists(`${root}/stop-work.log`), 5_000)
            expect(yield* readText(`${root}/stop-work.log`)).toBe(`${attached.hostPid}\n`)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    25_000,
  )

  test(
    "does not cancel execution work while a launching client supersedes the resident",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const mismatched = yield* start(root, idleGrace, 0, false, 1_024, 0, false, undefined, 0, {
              script: "test/fixtures/resident-mismatched-client.ts",
              environment: {
                RIKA_TEST_RESIDENT_HOST_SCRIPT: "test/fixtures/resident-mismatched-host.ts",
                RIKA_TEST_BUILD_IDENTITY: "rika-test-other-build",
                ...abandonAfter(stayAbandoned),
              },
            })
            const superseded = yield* attachedEffect(mismatched)

            const current = yield* start(root, idleGrace, 0, false, 1_024, 0, false, undefined, 0, {
              environment: abandonAfter(stayAbandoned),
            })
            expect(yield* current.nextEffect).toEqual({ type: "resident-status", callbacks: 1 })
            const replacement = yield* attachedEffect(current)
            expect(replacement.hostPid).not.toBe(superseded.hostPid)
            yield* waitUntil(
              Effect.sync(() => !alive(superseded.hostPid!)),
              5_000,
            )

            expect(yield* fileExists(`${root}/stop-work.log`)).toBe(false)
            yield* mismatched.kill
            yield* current.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    25_000,
  )
})
