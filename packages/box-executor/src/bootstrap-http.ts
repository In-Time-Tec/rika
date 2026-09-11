import { Effect, Schema } from "effect"

import { WorkspaceEnrollmentError } from "./enrollment"

const FileWriteResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("file.written"),
})

const FileReadResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("file.read"),
  path: Schema.String,
  content: Schema.String,
})

const FileMissingResponse = Schema.Struct({
  ok: Schema.Literal(false),
  type: Schema.Literal("box.error"),
  status: Schema.Literal(400),
  code: Schema.Literal("box_direct_failed"),
  message: Schema.String,
})

const CommandStartedResponse = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal("command.started"),
})

export { CommandStartedResponse, FileMissingResponse, FileReadResponse, FileWriteResponse }

const bootstrapRequestFailure = (phase: "enroll" | "handshake") =>
  WorkspaceEnrollmentError.make({ phase, message: "Box bootstrap request did not receive a valid response" })

const bootstrapResponseText = (response: Response, phase: "enroll" | "handshake", maxResponseBytes: number) => {
  const body = response.body
  if (body === null) return Effect.succeed("")
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => body.getReader(),
      catch: () => bootstrapRequestFailure(phase),
    }),
    (reader) => {
      const declared = response.headers.get("content-length")
      if (
        declared !== null &&
        (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
          !Number.isSafeInteger(Number(declared)) ||
          Number(declared) > maxResponseBytes)
      )
        return Effect.fail(bootstrapRequestFailure(phase))
      const chunks: Array<Uint8Array> = []
      let total = 0
      const read = (): Effect.Effect<string, WorkspaceEnrollmentError> =>
        Effect.tryPromise<Bun.ReadableStreamDefaultReadResult<Uint8Array>, WorkspaceEnrollmentError>({
          try: () => reader.read(),
          catch: () => bootstrapRequestFailure(phase),
        }).pipe(
          Effect.flatMap((result) => {
            if (result.done) {
              const bytes = Buffer.concat(chunks, total)
              return Effect.try({
                try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                catch: () => bootstrapRequestFailure(phase),
              })
            }
            if (total + result.value.byteLength > maxResponseBytes) return Effect.fail(bootstrapRequestFailure(phase))
            chunks.push(result.value)
            total += result.value.byteLength
            return Effect.suspend(read)
          }),
        )
      return read()
    },
    (reader) =>
      Effect.tryPromise({ try: () => reader.cancel(), catch: () => undefined }).pipe(
        Effect.timeout("100 millis"),
        Effect.ignore,
        Effect.andThen(Effect.try({ try: () => reader.releaseLock(), catch: () => undefined }).pipe(Effect.ignore)),
      ),
  )
}

const decodeBootstrapResponse = <A, I>(
  schema: Schema.Codec<A, I, never, never>,
  response: Response,
  phase: "enroll" | "handshake",
  maxResponseBytes: number,
) =>
  bootstrapResponseText(response, phase, maxResponseBytes).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
    Effect.mapError((error) => (Schema.is(WorkspaceEnrollmentError)(error) ? error : bootstrapRequestFailure(phase))),
  )

export const bootstrapHttp = {
  requestFailure: bootstrapRequestFailure,
  responseText: bootstrapResponseText,
  decodeResponse: decodeBootstrapResponse,
}
