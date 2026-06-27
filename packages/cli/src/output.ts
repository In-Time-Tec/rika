import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly stdout: (line: string) => Effect.Effect<void>
  readonly stderr: (line: string) => Effect.Effect<void>
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
    stderr: Effect.fn("Cli.Output.stderr")(function* (line: string) {
      yield* Effect.sync(() => process.stderr.write(`${line}\n`))
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
      stderr: Effect.fn("Cli.Output.stderr.memory")(function* (line: string) {
        yield* Effect.sync(() => output.stderr.push(line))
      }),
    }),
  )

export const stdout = Effect.fn("Cli.Output.stdout.call")(function* (line: string) {
  const output = yield* Service
  return yield* output.stdout(line)
})

export const stderr = Effect.fn("Cli.Output.stderr.call")(function* (line: string) {
  const output = yield* Service
  return yield* output.stderr(line)
})
