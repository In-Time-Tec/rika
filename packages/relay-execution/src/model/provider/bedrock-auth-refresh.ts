import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export class Failure extends Schema.TaggedErrorClass<Failure>()("BedrockAuthRefreshFailure", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly run: (command: Command) => Effect.Effect<void, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/bedrock-auth-refresh/Service") {}

export const liveLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const killOptions = { killSignal: "SIGTERM", forceKillAfter: "5 seconds" } as const
    return Service.of({
      run: Effect.fn("BedrockAuthRefresh.run")((input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(input.command, input.args, {
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                ...killOptions,
              }),
            )
            const completed = yield* Effect.all(
              [Stream.runDrain(child.stdout), Stream.runDrain(child.stderr), child.exitCode],
              { concurrency: 3 },
            ).pipe(Effect.timeoutOption("3 minutes"))
            if (completed._tag === "None") {
              yield* child.kill(killOptions).pipe(Effect.ignore)
              return yield* Failure.make({ message: "Amazon Bedrock authentication refresh timed out" })
            }
            const exitCode = Number(completed.value[2])
            if (exitCode !== 0) return yield* Failure.make({ message: "Amazon Bedrock authentication refresh failed" })
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.logDebug("Amazon Bedrock authentication refresh interrupted").pipe(Effect.ignore),
            ),
            Effect.mapError((error) =>
              Schema.is(Failure)(error)
                ? error
                : Failure.make({ message: "Amazon Bedrock authentication refresh could not run" }),
            ),
          ),
        ),
      ),
    })
  }),
)

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))
