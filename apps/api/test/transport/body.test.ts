import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { readBoundedHttpText } from "../../src/transport/body"

const body = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

it.effect("decodes bounded UTF-8 across chunk boundaries and verifies declared byte length", () =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode("hello 🌎")
    expect(yield* readBoundedHttpText(body(bytes.slice(0, 8), bytes.slice(8)), String(bytes.length))).toBe("hello 🌎")
    const mismatch = yield* readBoundedHttpText(body(bytes), "1").pipe(Effect.flip)
    expect(mismatch.kind).toBe("invalid")
    const malformed = yield* readBoundedHttpText(body(new Uint8Array([0xc3, 0x28])), null).pipe(Effect.flip)
    expect(malformed.kind).toBe("invalid")
  }),
)

it.effect("accepts the byte limit and rejects streamed overflow even without Content-Length", () =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode("x".repeat(16_384))
    expect((yield* readBoundedHttpText(body(bytes), null)).length).toBe(16_384)
    const overflow = yield* readBoundedHttpText(body(bytes, new Uint8Array([120])), null).pipe(Effect.flip)
    expect(overflow.kind).toBe("too-large")
  }),
)

it.effect("cancels and releases the body when Content-Length is malformed or too large", () =>
  Effect.gen(function* () {
    for (const length of ["-1", "1e3", "16385"]) {
      let cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        cancel: () => {
          cancelled = true
        },
      })
      const failure = yield* readBoundedHttpText(stream, length).pipe(Effect.flip)
      expect(failure.kind).toBe(length === "16385" ? "too-large" : "invalid")
      expect(cancelled).toBe(true)
      expect(stream.locked).toBe(false)
    }
  }),
)

it.effect("bounds a stalled body read and releases its reader", () =>
  Effect.gen(function* () {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true
      },
    })
    const reading = yield* readBoundedHttpText(stream, null).pipe(Effect.flip, Effect.forkChild)
    yield* TestClock.adjust("10 seconds")
    expect((yield* Fiber.join(reading)).kind).toBe("invalid")
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  }),
)
