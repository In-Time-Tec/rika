import { stdin, stdout } from "node:process"
import { createInterface, type Interface as ReadLineInterface } from "node:readline/promises"
import { Context, Effect, Layer, Schema } from "effect"

export class TerminalError extends Schema.TaggedErrorClass<TerminalError>()("TerminalError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export interface ReadLineOptions {
  readonly prompt: string
}

export interface Interface {
  readonly writeFrame: (frame: string) => Effect.Effect<void, TerminalError>
  readonly readLine: (options: ReadLineOptions) => Effect.Effect<string | undefined, TerminalError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tui/Terminal") {}

export interface MemoryTerminal {
  readonly inputs: Array<string>
  readonly frames: Array<string>
  readonly prompts: Array<string>
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => liveService(createInterface({ input: stdin, output: stdout }))),
)

export const memoryLayer = (terminal: MemoryTerminal) =>
  Layer.succeed(
    Service,
    Service.of({
      writeFrame: Effect.fn("Tui.Terminal.writeFrame.memory")(function* (frame: string) {
        yield* Effect.sync(() => terminal.frames.push(frame))
      }),
      readLine: Effect.fn("Tui.Terminal.readLine.memory")(function* (options: ReadLineOptions) {
        yield* Effect.sync(() => terminal.prompts.push(options.prompt))
        return terminal.inputs.shift()
      }),
    }),
  )

export const writeFrame = Effect.fn("Tui.Terminal.writeFrame.call")(function* (frame: string) {
  const terminal = yield* Service
  return yield* terminal.writeFrame(frame)
})

export const readLine = Effect.fn("Tui.Terminal.readLine.call")(function* (options: ReadLineOptions) {
  const terminal = yield* Service
  return yield* terminal.readLine(options)
})

const liveService = (readline: ReadLineInterface) =>
  Service.of({
    writeFrame: Effect.fn("Tui.Terminal.writeFrame")(function* (frame: string) {
      yield* Effect.try({
        try: () => stdout.write(`\u001b[2J\u001b[H${frame}\n`),
        catch: (cause) => toError(cause, "writeFrame"),
      })
    }),
    readLine: Effect.fn("Tui.Terminal.readLine")(function* (options: ReadLineOptions) {
      return yield* Effect.tryPromise({
        try: () => readline.question(options.prompt),
        catch: (cause) => toError(cause, "readLine"),
      })
    }),
  })

const toError = (cause: unknown, operation: string) =>
  new TerminalError({ message: cause instanceof Error ? cause.message : String(cause), operation })
