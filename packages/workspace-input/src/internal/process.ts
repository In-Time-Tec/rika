import { Effect, Function, Schema, Stream, type Duration } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class ArchiveCommandError extends Schema.TaggedError<ArchiveCommandError>()("ArchiveCommandError", {
  reason: Schema.Literals(["command", "output"]),
  message: Schema.String,
}) {}

export interface CommandResult {
  readonly stdout: Uint8Array
  readonly exitCode: number
}

export interface CommandInput {
  readonly command: ReadonlyArray<string>
  readonly cwd?: string
  readonly environment?: Record<string, string | undefined>
  readonly extendEnvironment?: boolean
  readonly forceKillAfter?: Duration.Input
  readonly maximumStdoutBytes?: number
  readonly stdin?: Uint8Array
}

interface OutputCollection {
  readonly chunks: Array<Uint8Array>
  size: number
}

const failure = (reason: ArchiveCommandError["reason"] = "command") =>
  ArchiveCommandError.make({ reason, message: "Workspace archive command failed" })
const isArchiveCommandError = Schema.is(ArchiveCommandError)

const makeCommand = (input: CommandInput) =>
  input.cwd === undefined
    ? ChildProcess.make(input.command[0]!, input.command.slice(1), {
        env: input.environment,
        extendEnv: input.extendEnvironment,
        forceKillAfter: input.forceKillAfter,
        stdin: input.stdin === undefined ? "ignore" : Stream.fromIterable([input.stdin]),
        stdout: "pipe",
        stderr: "pipe",
      })
    : ChildProcess.make(input.command[0]!, input.command.slice(1), {
        cwd: input.cwd,
        env: input.environment,
        extendEnv: input.extendEnvironment,
        forceKillAfter: input.forceKillAfter,
        stdin: input.stdin === undefined ? "ignore" : Stream.fromIterable([input.stdin]),
        stdout: "pipe",
        stderr: "pipe",
      })

export const run = (input: CommandInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(makeCommand(input)).pipe(Effect.mapError(() => failure()))
      const [collected, , exitCode] = yield* Effect.all(
        [
          Stream.runFoldEffect(
            child.stdout,
            (): OutputCollection => ({ chunks: [], size: 0 }),
            (state, chunk) => {
              const size = state.size + chunk.byteLength
              if (input.maximumStdoutBytes !== undefined && size > input.maximumStdoutBytes)
                return Effect.fail(failure("output"))
              return Effect.sync(() => {
                state.chunks.push(chunk)
                state.size = size
                return state
              })
            },
          ).pipe(Effect.mapError((error) => (isArchiveCommandError(error) ? error : failure()))),
          Stream.runDrain(child.stderr).pipe(Effect.mapError(() => failure())),
          child.exitCode.pipe(Effect.mapError(() => failure())),
        ],
        { concurrency: 3 },
      )
      return {
        stdout: Buffer.concat(collected.chunks, collected.size),
        exitCode: Number(exitCode),
      } satisfies CommandResult
    }),
  )

export const runStreaming: {
  <E, R>(
    consume: (stdout: Stream.Stream<Uint8Array, ArchiveCommandError>) => Effect.Effect<void, E, R>,
  ): (
    input: CommandInput,
  ) => Effect.Effect<number, E | ArchiveCommandError, R | ChildProcessSpawner.ChildProcessSpawner>
  <E, R>(
    input: CommandInput,
    consume: (stdout: Stream.Stream<Uint8Array, ArchiveCommandError>) => Effect.Effect<void, E, R>,
  ): Effect.Effect<number, E | ArchiveCommandError, R | ChildProcessSpawner.ChildProcessSpawner>
} = Function.dual(
  2,
  <E, R>(
    input: CommandInput,
    consume: (stdout: Stream.Stream<Uint8Array, ArchiveCommandError>) => Effect.Effect<void, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const child = yield* spawner.spawn(makeCommand(input)).pipe(Effect.mapError(() => failure()))
        const [, , exitCode] = yield* Effect.all(
          [
            consume(child.stdout.pipe(Stream.mapError(() => failure()))),
            Stream.runDrain(child.stderr).pipe(Effect.mapError(() => failure())),
            child.exitCode.pipe(Effect.mapError(() => failure())),
          ],
          { concurrency: 3 },
        )
        return Number(exitCode)
      }),
    ),
)
