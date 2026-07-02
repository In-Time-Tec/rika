import { Context, Effect, Layer, Schema, Stream } from "effect"
import { createInterface } from "node:readline"

export class InputError extends Schema.TaggedErrorClass<InputError>()("InputError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly readAll: Effect.Effect<string>
  readonly isTty: Effect.Effect<boolean>
  readonly lines: Stream.Stream<string, InputError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Input") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    readAll: Effect.fn("Cli.Input.readAll")(function* () {
      return yield* Effect.promise(() => Bun.stdin.text())
    })(),
    isTty: Effect.sync(() => process.stdin.isTTY ?? false),
    lines: Stream.unwrap(
      Effect.sync(() => {
        const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
        return Stream.fromAsyncIterable(
          reader,
          (cause) =>
            new InputError({
              message: cause instanceof Error ? cause.message : `Failed to read stdin: ${String(cause)}`,
            }),
        ).pipe(Stream.ensuring(Effect.sync(() => reader.close())))
      }),
    ),
  }),
)

const linesFromText = (text: string) => (text.length === 0 ? [] : text.split(/\r?\n/))

export const memoryLayer = (text: string, isTty = false) =>
  Layer.succeed(
    Service,
    Service.of({
      readAll: Effect.succeed(text),
      isTty: Effect.succeed(isTty),
      lines: Stream.fromIterable(linesFromText(text)),
    }),
  )

export const readAll = Effect.fn("Cli.Input.readAll.call")(function* () {
  const input = yield* Service
  return yield* input.readAll
})

export const isTty = Effect.fn("Cli.Input.isTty.call")(function* () {
  const input = yield* Service
  return yield* input.isTty
})

export const lines = Stream.unwrap(Effect.map(Service, (input) => input.lines))
