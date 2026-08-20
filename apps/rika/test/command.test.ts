import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Exit, Layer, Ref } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { expect, it } from "@effect/vitest"
import { clientProcessExitCode } from "../src/client/client-process-exit"
import { parseJsonLines } from "../src/command/root/prompt-json"
import { run } from "../src/command/root/rika-command"
import * as HostedCommand from "../src/command/root/hosted-command-dispatch"

const execute = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R>): Effect.Effect<A, E, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const context = yield* Layer.buildWithScope(layer, scope)
      return yield* Effect.provide(effect, context)
    }),
  )

const capture = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<HostedCommand.Input>>([])
    const service = HostedCommand.Service.of({
      run: (input) => Ref.update(calls, (current) => [...current, input]),
    })
    yield* execute(run(argv).pipe(Effect.provideService(HostedCommand.Service, service)), Layer.merge(BunServices.layer, FetchHttpClient.layer))
    return yield* Ref.get(calls)
  })

const failsWithoutDispatch = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<HostedCommand.Input>>([])
    const service = HostedCommand.Service.of({
      run: (input) => Ref.update(calls, (current) => [...current, input]),
    })
    const exit = yield* Effect.exit(execute(run(argv).pipe(Effect.provideService(HostedCommand.Service, service)), Layer.merge(BunServices.layer, FetchHttpClient.layer)))
    expect(exit._tag).toBe("Failure")
    expect(yield* Ref.get(calls)).toEqual([])
    return exit
  })

it("maps pure client interruption to success without masking failures", () => {
  expect(clientProcessExitCode({ exit: Exit.interrupt(1), interruptedBySigint: true })).toBe(0)
  expect(clientProcessExitCode({ exit: Exit.interrupt(1), interruptedBySigint: false })).toBe(130)
  expect(clientProcessExitCode({ exit: Exit.succeed(undefined), interruptedBySigint: false })).toBe(0)
  expect(clientProcessExitCode({ exit: Exit.fail("real failure"), interruptedBySigint: true })).toBe(1)
})

it.effect("routes all supported client operations to the hosted dispatcher", () =>
  Effect.gen(function* () {
    expect(yield* capture(["auth", "login", "--server", "https://hosted.example.test", "--no-open"])).toEqual([
      { _tag: "Auth", action: "login", server: "https://hosted.example.test", noOpen: true },
    ])
    expect(yield* capture(["auth", "status", "--json"])).toEqual([{ _tag: "Auth", action: "status", json: true }])
    expect(yield* capture(["org", "use", "engineering"])).toEqual([
      { _tag: "Organization", action: "use", organization: "engineering" },
    ])
    expect(yield* capture(["thread", "new"])).toEqual([{ _tag: "LocalThread", action: "new" }])
    expect(yield* capture(["thread", "new", "--remote"])).toEqual([{ _tag: "RemoteThread", action: "new" }])
    expect(yield* capture(["thread", "continue", "thread-1"])).toEqual([
      { _tag: "LocalForeground", threadId: "thread-1" },
    ])
    expect(yield* capture(["hello", "world"])).toEqual([{ _tag: "LocalForeground" }])
    expect(yield* capture(["--execute", "hello", "--thread", "e2b_thread-1", "--mode", "low"])).toEqual([
      { _tag: "RemoteRun", threadId: "e2b_thread-1", request: { prompt: ["hello"], mode: "low" } },
    ])
  }),
)

it.effect("rejects the removed local executor role flag", () => failsWithoutDispatch(["--internal-local-executor"]))

it.effect("rejects noninteractive local execution before dispatch", () =>
  Effect.gen(function* () {
    const exit = yield* failsWithoutDispatch(["--execute", "echo", "--thread", "local_thread-1"])
    expect(exit._tag).toBe("Failure")
  }),
)

it.effect("rejects unsupported authority commands without dispatch", () =>
  Effect.gen(function* () {
    yield* failsWithoutDispatch(["diagnostics"])
    yield* failsWithoutDispatch(["credential", "list"])
    yield* failsWithoutDispatch(["--stream-json"])
  }),
)

it("parses JSONL prompt input and reports malformed physical source lines", () => {
  expect(parseJsonLines('\n"one"\n  \n{"prompt":"two"}\n')).toEqual(["one", "two"])
  expect(() => parseJsonLines('\n"one"\n  \nnot-json\n')).toThrow("Invalid JSON on stdin line 4")
  expect(() => parseJsonLines("\n\n42")).toThrow("JSON on stdin line 3 must be a string or prompt object")
})
