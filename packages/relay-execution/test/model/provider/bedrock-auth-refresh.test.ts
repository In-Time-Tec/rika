import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  liveLayer as bedrockAuthRefreshLiveLayer,
  Service as bedrockAuthRefreshService,
} from "../../../src/model/provider/bedrock-auth-refresh"

const processHandle = (exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>, killed: Array<string>) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: Effect.succeed(true),
    kill: (options) => Effect.sync(() => void killed.push(options?.killSignal ?? "SIGTERM")),
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode("discarded output")),
    stderr: Stream.make(new TextEncoder().encode("discarded error")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })

const environment = (exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const killed: Array<string> = []
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag === "PipedCommand") return Effect.die("unexpected pipeline")
      commands.push(command)
      return Effect.succeed(processHandle(exitCode, killed))
    }),
  )
  return {
    commands,
    killed,
    layer: bedrockAuthRefreshLiveLayer.pipe(Layer.provide(spawner)),
  }
}

describe("BedrockAuthRefresh", () => {
  it.effect("runs a structured command with closed stdin and discards its output", () => {
    const fixture = environment(Effect.succeed(ChildProcessSpawner.ExitCode(0)))
    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(fixture.layer)
        const refresh = Context.get(context, bedrockAuthRefreshService)
        yield* refresh.run({ command: "aws", args: ["sso", "login", "--profile", "engineering"] })
        expect(fixture.commands[0]).toMatchObject({
          command: "aws",
          args: ["sso", "login", "--profile", "engineering"],
          options: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        })
      }),
    )
  })

  it.effect("returns a secret-safe typed failure for a non-zero exit", () => {
    const fixture = environment(Effect.succeed(ChildProcessSpawner.ExitCode(23)))
    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(fixture.layer)
        const refresh = Context.get(context, bedrockAuthRefreshService)
        const result = yield* Effect.result(refresh.run({ command: "secret-command", args: ["secret-argument"] }))
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "BedrockAuthRefreshFailure",
            message: "Amazon Bedrock authentication refresh failed",
          },
        })
        expect(result).not.toHaveProperty("failure.command")
        expect(result).not.toHaveProperty("failure.args")
      }),
    )
  })

  it.effect("times out and terminates a stuck refresh process", () => {
    const fixture = environment(Effect.never)
    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(fixture.layer)
        const refresh = Context.get(context, bedrockAuthRefreshService)
        const fiber = yield* Effect.forkChild(refresh.run({ command: "aws", args: ["sso", "login"] }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("3 minutes")
        const result = yield* Effect.result(Fiber.join(fiber))
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "BedrockAuthRefreshFailure",
            message: "Amazon Bedrock authentication refresh timed out",
          },
        })
        expect(fixture.killed).toContain("SIGTERM")
      }),
    )
  })
})
