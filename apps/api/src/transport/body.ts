import { Effect, Schema } from "effect"

export class HttpBodyError extends Schema.TaggedError<HttpBodyError>()("RikaHttpBodyError", {
  kind: Schema.Literals(["invalid", "too-large"]),
}) {}

const maxDecodedBodyBytes = 16_384
const invalid = () => HttpBodyError.make({ kind: "invalid" })

export const readBoundedHttpText = Effect.fn("Rika.HttpBody.readBoundedText")(function* (
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
) {
  let completed = false
  return yield* Effect.acquireUseRelease(
    Effect.try({ try: () => body?.getReader(), catch: invalid }),
    (reader) =>
      Effect.gen(function* () {
        if (contentLength !== null) {
          if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) return yield* invalid()
          const declaredBytes = Number(contentLength)
          if (!Number.isSafeInteger(declaredBytes)) return yield* invalid()
          if (declaredBytes > maxDecodedBodyBytes) return yield* HttpBodyError.make({ kind: "too-large" })
        }
        if (reader === undefined) return ""
        const chunks: Uint8Array[] = []
        let totalBytes = 0
        while (true) {
          const result = yield* Effect.tryPromise({ try: () => reader.read(), catch: invalid })
          if (result.done) {
            completed = true
            if (contentLength !== null && totalBytes !== Number(contentLength)) return yield* invalid()
            const bytes = new Uint8Array(totalBytes)
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
            return yield* Effect.try({
              try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              catch: invalid,
            })
          }
          if (totalBytes > maxDecodedBodyBytes - result.value.byteLength)
            return yield* HttpBodyError.make({ kind: "too-large" })
          chunks.push(result.value)
          totalBytes += result.value.byteLength
        }
      }).pipe(Effect.timeout("10 seconds"), Effect.catchTag("TimeoutError", invalid)),
    (reader) => {
      if (reader === undefined) return Effect.void
      const cancel = completed
        ? Effect.void
        : Effect.tryPromise({ try: () => reader.cancel(), catch: invalid }).pipe(
            Effect.timeout("100 millis"),
            Effect.ignore,
          )
      return cancel.pipe(
        Effect.andThen(Effect.try({ try: () => reader.releaseLock(), catch: invalid }).pipe(Effect.ignore)),
      )
    },
  )
})
