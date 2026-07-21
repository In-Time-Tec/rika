import { afterEach, describe, expect, test } from "vitest"
import { Effect } from "effect"
import { resolve } from "../src/resident-endpoint"
import {
  alive,
  attachedEffect,
  cleanRoot,
  fileExists,
  fileStat,
  killTrackedHosts,
  makeRoot,
  readText,
  run,
  start,
  waitUntil,
} from "./resident-transport-harness"

afterEach(() => killTrackedHosts())

describe("resident WebSocket process transport", () => {
  test(
    "uses one distinct host for simultaneous clients and exits after final-client grace",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const [a, b] = yield* Effect.all([start(root), start(root)], { concurrency: 2 })
            const [aEvent, bEvent] = yield* Effect.all([attachedEffect(a), attachedEffect(b)])
            expect(aEvent.hostPid).toBe(bEvent.hostPid)
            expect(aEvent.id).not.toBe(bEvent.id)
            expect((yield* fileStat(`${root}/resident.token`)).mode & 0o077).toBe(0)
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(`${aEvent.hostPid}\n`)

            yield* a.kill
            expect(alive(aEvent.hostPid!)).toBe(true)
            yield* b.send("ping")
            expect((yield* b.nextEffect).type).toBe("pong")

            const c = yield* start(root)
            const cEvent = yield* attachedEffect(c)
            expect(cEvent.hostPid).toBe(aEvent.hostPid)
            yield* b.closeEffect
            expect(alive(aEvent.hostPid!)).toBe(true)
            yield* c.send("ping")
            expect((yield* c.nextEffect).type).toBe("pong")
            yield* c.closeEffect

            yield* waitUntil(fileExists(`${root}/owner-finalizations.log`), 4_000)
            expect(yield* readText(`${root}/owner-finalizations.log`)).toBe(`${aEvent.hostPid}\n`)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "attaches concurrent clients to the listener while its one owner is still starting",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const [a, b] = yield* Effect.all(
              [
                start(root, 350, 0, false, 1_024, 0, false, undefined, 1_000),
                Effect.sleep(100).pipe(Effect.andThen(start(root))),
              ],
              { concurrency: 2 },
            )
            const [aEvent, bEvent] = yield* Effect.all([attachedEffect(a), attachedEffect(b)], { concurrency: 2 })
            expect(aEvent.hostPid).toBe(bEvent.hostPid)
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(`${aEvent.hostPid}\n`)
            yield* Effect.all([a.closeEffect, b.closeEffect], { concurrency: 2 })
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "keeps the cold startup host alive for clients arriving after normal grace",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const firstClient = yield* start(root, 100, 0, false, 1_024, 2_000)
            const first = yield* attachedEffect(firstClient)
            yield* firstClient.closeEffect
            yield* firstClient.awaitExit.pipe(
              Effect.timeoutOrElse({
                duration: "500 millis",
                orElse: () => Effect.die("resident startup owner did not exit after detaching its live host"),
              }),
            )
            expect(alive(first.hostPid!)).toBe(true)
            yield* Effect.sleep("500 millis")

            const lateClient = yield* start(root, 100, 0, false, 1_024, 2_000)
            const late = yield* attachedEffect(lateClient)
            expect(late.hostPid).toBe(first.hostPid)
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(`${first.hostPid}\n`)
            yield* lateClient.closeEffect

            yield* waitUntil(fileExists(`${root}/owner-finalizations.log`), 3_000)
            expect(yield* readText(`${root}/owner-finalizations.log`)).toBe(`${first.hostPid}\n`)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    10_000,
  )

  test(
    "survives starter SIGKILL and replaces a SIGKILLed host",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const starter = yield* start(root, 10_000)
            const first = yield* attachedEffect(starter)
            yield* starter.kill
            expect(alive(first.hostPid!)).toBe(true)

            const survivor = yield* start(root, 10_000)
            expect((yield* attachedEffect(survivor)).hostPid).toBe(first.hostPid)
            process.kill(first.hostPid!, "SIGKILL")
            yield* waitUntil(Effect.sync(() => !alive(first.hostPid!)))

            const replacement = yield* start(root, 10_000)
            const second = yield* attachedEffect(replacement)
            expect(second.hostPid).not.toBe(first.hostPid)
            const acquisitions = (yield* readText(`${root}/owner-acquisitions.log`)).trim().split("\n")
            expect(acquisitions).toEqual([String(first.hostPid), String(second.hostPid)])
            yield* replacement.send("ping")
            expect((yield* replacement.nextEffect).type).toBe("pong")
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "waits for the previous owner to finish draining before replacing it",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 100, 1_000)
            const first = yield* attachedEffect(client)
            yield* client.closeEffect
            yield* waitUntil(fileExists(`${root}/owner-finalizer-starts.log`))

            const replacement = yield* start(root)
            const second = yield* attachedEffect(replacement)
            expect(second.hostPid).not.toBe(first.hostPid)
            expect((yield* readText(`${root}/owner-acquisitions.log`)).trim().split("\n")).toEqual([
              String(first.hostPid),
              String(second.hostPid),
            ])
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "waits for a signalled owner to finish draining before replacing it",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000, 1_000)
            const first = yield* attachedEffect(client)
            process.kill(first.hostPid!, "SIGTERM")
            yield* waitUntil(fileExists(`${root}/owner-finalizer-starts.log`))

            const replacement = yield* start(root)
            const second = yield* attachedEffect(replacement)
            expect(second.hostPid).not.toBe(first.hostPid)
            expect((yield* readText(`${root}/owner-acquisitions.log`)).trim().split("\n")).toEqual([
              String(first.hostPid),
              String(second.hostPid),
            ])
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "exits promptly when signalled with ten attached clients",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const clients = yield* Effect.forEach(Array.from({ length: 10 }), () => start(root, 1_000), {
              concurrency: 10,
            })
            const attachments = yield* Effect.forEach(clients, attachedEffect, { concurrency: 10 })
            const hostPid = attachments[0]!.hostPid!
            expect(new Set(attachments.map((attachment) => attachment.hostPid))).toEqual(new Set([hostPid]))

            process.kill(hostPid, "SIGTERM")
            yield* waitUntil(
              Effect.sync(() => !alive(hostPid)),
              3_000,
            )
            expect(yield* fileExists(`${root}/resident-${(yield* resolve("default", root)).identity}.startup`)).toBe(
              false,
            )
            yield* Effect.forEach(clients, (client) => client.kill, { concurrency: 10, discard: true })
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "hard-exits within the owner-drain bound when an owner finalizer hangs uninterruptibly",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000, 0, false, 1_024, 0, true, 700)
            const attached = yield* attachedEffect(client)
            const hostPid = attached.hostPid!
            yield* waitUntil(fileExists(`${root}/owner-acquisitions.log`))
            process.kill(hostPid, "SIGTERM")
            yield* waitUntil(
              Effect.sync(() => !alive(hostPid)),
              4_000,
            )
            expect(yield* fileExists(`${root}/owner-finalizer-starts.log`)).toBe(true)
            expect(yield* fileExists(`${root}/owner-finalizations.log`)).toBe(false)
            yield* client.kill
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "interrupts host work before owner finalization and rejects work from an attached client while draining",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000, 750, true)
            const first = yield* attachedEffect(client)
            const existing = yield* start(root, 1_000, 750, true)
            expect((yield* attachedEffect(existing)).hostPid).toBe(first.hostPid)
            yield* client.send("delayed")
            yield* waitUntil(fileExists(`${root}/delayed-work-starts.log`))
            process.kill(first.hostPid!, "SIGTERM")
            yield* waitUntil(fileExists(`${root}/delayed-work-finalizations.log`))
            yield* existing.send("rejected")
            expect(yield* existing.nextEffect).toMatchObject({
              type: "rejected-work",
              error: "Resident service is draining",
            })
            yield* waitUntil(fileExists(`${root}/owner-finalizer-starts.log`))

            expect(yield* readText(`${root}/owner-finalizer-starts.log`)).toBe(`${first.hostPid}:0\n`)
            expect(yield* readText(`${root}/delayed-work-finalizations.log`)).toBe(`${first.hostPid}\n`)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )
})
