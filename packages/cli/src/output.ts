import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly stdout: (line: string) => Effect.Effect<void>
  readonly stdoutRaw: (text: string) => Effect.Effect<void>
  readonly stderr: (line: string) => Effect.Effect<void>
  readonly stderrRaw: (text: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Output") {}

export interface MemoryOutput {
  readonly stdout: Array<string>
  readonly stderr: Array<string>
}

export const layer = Layer.succeed(
  Service,
  Service.of({
    stdout: Effect.fn("Cli.Output.stdout")(function* (line: string) {
      yield* Effect.sync(() => process.stdout.write(`${line}\n`))
    }),
    stdoutRaw: Effect.fn("Cli.Output.stdoutRaw")(function* (text: string) {
      yield* Effect.sync(() => process.stdout.write(text))
    }),
    stderr: Effect.fn("Cli.Output.stderr")(function* (line: string) {
      yield* Effect.sync(() => process.stderr.write(`${line}\n`))
    }),
    stderrRaw: Effect.fn("Cli.Output.stderrRaw")(function* (text: string) {
      yield* Effect.sync(() => process.stderr.write(text))
    }),
  }),
)

export const memoryLayer = (output: MemoryOutput) =>
  Layer.succeed(
    Service,
    Service.of({
      stdout: Effect.fn("Cli.Output.stdout.memory")(function* (line: string) {
        yield* Effect.sync(() => output.stdout.push(line))
      }),
      stdoutRaw: Effect.fn("Cli.Output.stdoutRaw.memory")(function* (text: string) {
        yield* Effect.sync(() => output.stdout.push(text))
      }),
      stderr: Effect.fn("Cli.Output.stderr.memory")(function* (line: string) {
        yield* Effect.sync(() => output.stderr.push(line))
      }),
      stderrRaw: Effect.fn("Cli.Output.stderrRaw.memory")(function* (text: string) {
        yield* Effect.sync(() => output.stderr.push(text))
      }),
    }),
  )

export const stdout = Effect.fn("Cli.Output.stdout.call")(function* (line: string) {
  const output = yield* Service
  return yield* output.stdout(line)
})

export const stdoutRaw = Effect.fn("Cli.Output.stdoutRaw.call")(function* (text: string) {
  const output = yield* Service
  return yield* output.stdoutRaw(text)
})

export const stderr = Effect.fn("Cli.Output.stderr.call")(function* (line: string) {
  const output = yield* Service
  return yield* output.stderr(line)
})

export const stderrRaw = Effect.fn("Cli.Output.stderrRaw.call")(function* (text: string) {
  const output = yield* Service
  return yield* output.stderrRaw(text)
})
