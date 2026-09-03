import { expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { collectBoundedText } from "../../src/tool/process-registry"

const encoder = new TextEncoder()

it.effect("keeps a UTF-8 byte limit across many output chunks", () =>
  Effect.gen(function* () {
    const chunks = Array.from({ length: 10_000 }, () => encoder.encode("🙂"))
    const result = yield* collectBoundedText(Stream.fromIterable(chunks), 1_025)

    expect(encoder.encode(result.text).byteLength).toBe(1_024)
    expect(result.text).toBe("🙂".repeat(256))
    expect(result.truncated).toBe(true)
  }),
)

it.effect("flushes one UTF-8 scalar that spans multiple chunks", () =>
  Effect.gen(function* () {
    const scalar = encoder.encode("🙂")
    const chunks = Array.from(scalar, (byte) => Uint8Array.of(byte))
    const result = yield* collectBoundedText(Stream.fromIterable(chunks), scalar.byteLength)

    expect(result).toEqual({ text: "🙂", truncated: false })
  }),
)
