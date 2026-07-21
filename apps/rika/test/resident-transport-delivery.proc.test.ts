import { afterEach, describe, expect, test } from "vitest"
import { Effect, Schema } from "effect"
import {
  attachedEffect,
  cleanRoot,
  killTrackedHosts,
  makeRoot,
  nextTypeEffect,
  readText,
  run,
  start,
} from "./resident-transport-harness"

afterEach(() => killTrackedHosts())

describe("resident WebSocket process transport", () => {
  test(
    "serializes concurrent admissions without making execution block later admissions",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("serialized-interactive")
            const event = yield* client.nextEffect
            expect(event.type).toBe("serialized-interactive-completed")
            const result = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  admissionMaximum: Schema.optionalKey(Schema.Finite),
                  admissions: Schema.optionalKey(Schema.Array(Schema.Finite)),
                  executionMaximum: Schema.optionalKey(Schema.Finite),
                  completions: Schema.optionalKey(Schema.Array(Schema.Finite)),
                }),
              ),
            )(event.text ?? "{}")
            expect(result.admissionMaximum).toBe(1)
            expect(result.admissions).toEqual([0, 1, 2, 3])
            expect(result.executionMaximum).toBeGreaterThan(1)
            expect(result.completions?.toSorted((left, right) => left - right)).toEqual([0, 1, 2, 3])
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "chunks oversized operation output and keeps the connection healthy",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("oversized-output")
            const output = yield* client.nextEffect
            expect(output).toMatchObject({
              type: "oversized-output-completed",
              text: "1100001",
              outcome: "exact",
            })
            expect(output.callbacks).toBeGreaterThan(1)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "delivers an oversized interactive submit without reconnecting",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("oversized-submit")
            expect(yield* client.nextEffect).toEqual({
              type: "oversized-submit-completed",
              text: "2000000",
              callbacks: 1,
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
    "rejects an over-ceiling submit with an actionable message and keeps the session",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("over-ceiling-submit")
            const event = yield* client.nextEffect
            expect(event.type).toBe("over-ceiling-submit-completed")
            expect(event.error).toContain("16 MiB resident message limit")
            expect(event.error).not.toContain("transport disconnected")
            expect(event.text).toBe("2000000")
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "delivers a long bounded burst of interactive execution events without overflowing",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("burst-interactive")
            expect(yield* client.nextEffect).toEqual({ type: "burst-completed", text: "1000" })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "delivers an oversized interactive event without reconnecting",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("oversized-interactive-event")
            expect(yield* client.nextEffect).toEqual({
              type: "oversized-interactive-event-completed",
              text: "1100000",
            })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    30_000,
  )

  test(
    "backpressures two fragment-heavy sessions without failing either session",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 350, 0, false, 2)
            yield* attachedEffect(client)
            yield* client.send("fragment-burst")
            expect(yield* client.nextEffect).toEqual({
              type: "fragment-burst-completed",
              text: "8000000,8000000",
            })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    30_000,
  )

  test(
    "degrades a 20 MB event and survives replay after resident replacement",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000)
            yield* attachedEffect(client)
            yield* client.send("wire-limit-reattach")
            expect(yield* nextTypeEffect(client, "wire-limit-reattach-completed")).toMatchObject({ callbacks: 2 })
            expect((yield* readText(`${root}/owner-acquisitions.log`)).trim().split("\n")).toHaveLength(2)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    30_000,
  )

  test(
    "resyncs transcript delivery without failing the current physical feed",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 350, 0, false, 4)
            yield* attachedEffect(client)

            yield* client.send("overflow-interactive")
            const event = yield* client.nextEffect
            expect(event).toMatchObject({
              type: "overflow-completed",
              tag: "TranscriptResyncRequired",
            })
            expect(event.callbacks).toBeLessThan(12)
            expect(event.tags).toContain("TranscriptResyncRequired")
            expect((event.tags ?? []).includes("ExecutionFailed")).toBe(false)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "holds feed acknowledgements until a slow consumer releases capacity",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 350, 0, false, 4)
            yield* attachedEffect(client)
            yield* client.send("slow-consumer")
            const event = yield* client.nextEffect
            expect(event.type).toBe("slow-consumer-completed")
            expect(event.tags).toContain("TranscriptResyncRequired")
            expect(event.tags).not.toContain("execution.completed")
            expect(event.callbacks).toBeLessThan(10)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "keeps an interactive subscription alive after transcript delivery resyncs",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 350, 0, false, 4)
            yield* attachedEffect(client)

            yield* client.send("overflow-watch")
            const event = yield* client.nextEffect
            expect((event.tags ?? []).includes("ExecutionFailed")).toBe(false)
            expect(event).toMatchObject({
              type: "overflow-watch-finished",
              outcome: "Success",
              tags: expect.arrayContaining(["TranscriptResyncRequired", "ThreadsListed"]),
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
    "resyncs queue delivery without failing the current physical feed",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 350, 0, false, 4)
            yield* attachedEffect(client)

            yield* client.send("queue-overflow-interactive")
            const event = yield* client.nextEffect
            expect(event).toMatchObject({
              type: "queue-overflow-completed",
              tag: "QueueResyncRequired",
            })
            expect(event.callbacks).toBeLessThan(12)
            expect(event.tags).toContain("QueueResyncRequired")
            expect((event.tags ?? []).includes("TranscriptResyncRequired")).toBe(false)
            expect((event.tags ?? []).includes("ExecutionFailed")).toBe(false)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "detaches and replaces the one resident event consumer",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("feed-takeover")
            expect(yield* client.nextEffect).toEqual({
              type: "replacement-feed-event",
              tag: "ThreadsListed",
            })
            expect((yield* client.nextEffect).type).toBe("feed-takeover-completed")
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )
})
