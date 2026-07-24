import { afterEach, describe, expect, test } from "vitest"
import { Effect } from "effect"
import {
  attachedEffect,
  cleanRoot,
  fileExists,
  killTrackedHosts,
  makeRoot,
  nextTypeEffect,
  readText,
  run,
  start,
  waitUntil,
} from "./resident-transport-harness"

afterEach(() => killTrackedHosts())

describe("resident WebSocket process transport", () => {
  test(
    "cancels interrupted client work while keeping the resident connection usable",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000, 0, true)
            const attached = yield* attachedEffect(client)
            yield* client.send("cancel-delayed")
            expect(yield* client.nextEffect).toEqual({ type: "cancelled-delayed" })
            expect(yield* readText(`${root}/delayed-work-starts.log`)).toBe(`${attached.hostPid}\n`)
            expect(yield* readText(`${root}/delayed-work-finalizations.log`)).toBe(`${attached.hostPid}\n`)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "keeps one interactive callback and restores reads across resident replacements without retrying mutations",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000)
            yield* attachedEffect(client)
            yield* client.send("reconnect-interactive")
            expect(yield* client.nextEffect).toMatchObject({
              type: "interactive-callback",
              callbacks: 1,
            })
            expect(yield* client.nextEffect).toMatchObject({
              type: "initial-read",
              tag: "ThreadsListed",
            })
            expect(yield* nextTypeEffect(client, "replacement-read")).toMatchObject({
              tag: "ThreadsListed",
            })
            expect(yield* nextTypeEffect(client, "mutation-failed")).toMatchObject({
              tag: "ExecutionFailed",
            })
            expect(yield* nextTypeEffect(client, "post-mutation-read")).toMatchObject({
              tag: "ThreadsListed",
            })
            expect(yield* nextTypeEffect(client, "mutation-attempts")).toMatchObject({
              text: "1",
            })
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "logical close completes a blocking interactive callback and stops its physical connection",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 250)
            const event = yield* attachedEffect(client)
            yield* client.send("blocking-interactive")
            expect((yield* client.nextEffect).type).toBe("interactive-callback")
            yield* client.send("close")
            const completed = [yield* client.nextEffect, yield* client.nextEffect]
            expect(completed.map((item) => item.type).toSorted()).toEqual(["blocking-completed", "closed"])
            yield* client.end
            yield* client.awaitExit
            yield* waitUntil(fileExists(`${root}/owner-finalizations.log`), 4_000)
            expect(yield* readText(`${root}/owner-finalizations.log`)).toBe(`${event.hostPid}\n`)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "bounds repeated physical reconnects and terminates the logical interactive session",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000)
            yield* attachedEffect(client)
            yield* client.send("flap-interactive")
            expect(yield* client.nextEffect).toMatchObject({
              type: "interactive-callback",
              callbacks: 1,
            })
            const failed = yield* nextTypeEffect(client, "flap-failed")
            expect(failed.error).toContain("closed 8 times before becoming stable")
            expect(failed.callbacks).toBe(8)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    30_000,
  )
})
