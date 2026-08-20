import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer, Ref } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { expect, it } from "@effect/vitest"
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
it.effect("routes hosted operations without a local authority service", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<HostedCommand.Input>>([])
    const service = HostedCommand.Service.of({
      run: (input) => Ref.update(calls, (current) => [...current, input]),
    })
    const invoke = (argv: ReadonlyArray<string>) =>
      execute(run(argv).pipe(Effect.provideService(HostedCommand.Service, service)), Layer.merge(BunServices.layer, FetchHttpClient.layer))

    yield* invoke(["auth", "login"])
    yield* invoke(["auth", "logout", "--all"])
    yield* invoke(["org", "list"])
    yield* invoke(["thread", "new", "--remote"])
    yield* invoke(["--execute", "hello", "--thread", "opaque-thread", "--mode", "low"])

    expect(yield* Ref.get(calls)).toEqual([
      { _tag: "Auth", action: "login", noOpen: false },
      { _tag: "Auth", action: "logout", all: true },
      { _tag: "Organization", action: "list" },
      { _tag: "RemoteThread", action: "new" },
      { _tag: "RemoteRun", threadId: "opaque-thread", request: { prompt: ["hello"], mode: "low" } },
    ])
  }),
)
