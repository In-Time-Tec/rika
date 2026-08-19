import * as BunServices from "@effect/platform-bun/BunServices"
import type { Input as ProductInput } from "@rika/product/product-operation"
import { Service as ProductService } from "@rika/product/product-operation-service"
import { Effect, Layer, Ref } from "effect"
import { TestConsole } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { expect, it } from "@effect/vitest"
import { run } from "../src/command/root/rika-command"
import * as HostedCommand from "../src/command/root/hosted-command-dispatch"

it.effect("routes hosted execution without calling the local server operation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const productCalls = yield* Ref.make<ReadonlyArray<ProductInput>>([])
      const hostedCalls = yield* Ref.make<ReadonlyArray<HostedCommand.Input>>([])
      const context = yield* Layer.build(
        Layer.mergeAll(
          BunServices.layer,
          FetchHttpClient.layer,
          TestConsole.layer,
          Layer.succeed(
            ProductService,
            ProductService.of({ run: (input) => Ref.update(productCalls, (current) => [...current, input]) }),
          ),
          Layer.succeed(
            HostedCommand.Service,
            HostedCommand.Service.of({ run: (input) => Ref.update(hostedCalls, (current) => [...current, input]) }),
          ),
        ),
      )
      const invoke = (argv: ReadonlyArray<string>) => run(argv).pipe(Effect.provide(context))
      yield* invoke(["auth", "login"])
      yield* invoke(["auth", "login", "--server", "https://hosted.example.test/base", "--no-open"])
      yield* invoke(["auth", "status", "--json"])
      yield* invoke(["auth", "logout"])
      yield* invoke(["auth", "devices"])
      yield* invoke(["auth", "revoke-device"])
      yield* invoke(["auth", "revoke-device", "device-2"])
      yield* invoke(["org", "list"])
      yield* invoke(["org", "use", "engineering"])
      yield* invoke(["org", "invite", "dev@example.test"])
      yield* invoke(["thread", "new"])
      yield* invoke(["thread", "new", "--remote"])
      yield* invoke(["--execute", "hello", "--thread", "e2b_thread-1", "--mode", "low"])
      yield* invoke(["credential", "set", "openai"])
      yield* invoke(["credential", "list", "openrouter"])
      yield* invoke(["credential", "rotate", "openai", "--device-code"])
      yield* invoke(["credential", "revoke", "openrouter"])
      expect(yield* Ref.get(productCalls)).toEqual([
        { _tag: "Thread", action: "new" },
        { _tag: "Auth", action: "login", provider: "openai", deviceCode: false },
        { _tag: "Auth", action: "status", provider: "openrouter" },
        { _tag: "Auth", action: "login", provider: "openai", deviceCode: true },
        { _tag: "Auth", action: "logout", provider: "openrouter" },
      ])
      expect(yield* Ref.get(productCalls)).not.toContainEqual(
        expect.objectContaining({ _tag: "Run", threadId: "e2b_thread-1" }),
      )
      expect(yield* Ref.get(hostedCalls)).toEqual([
        { _tag: "Auth", action: "login", noOpen: false },
        { _tag: "Auth", action: "login", server: "https://hosted.example.test/base", noOpen: true },
        { _tag: "Auth", action: "status", json: true },
        { _tag: "Auth", action: "logout" },
        { _tag: "Auth", action: "devices" },
        { _tag: "Auth", action: "revoke-device" },
        { _tag: "Auth", action: "revoke-device", device: "device-2" },
        { _tag: "Organization", action: "list" },
        { _tag: "Organization", action: "use", organization: "engineering" },
        { _tag: "Organization", action: "invite", email: "dev@example.test" },
        { _tag: "RemoteThread", action: "new" },
        { _tag: "RemoteRun", threadId: "e2b_thread-1", request: { prompt: ["hello"], mode: "low" } },
      ])
      expect((yield* Effect.exit(invoke(["credential", "list", "--scope", "user"])))._tag).toBe("Failure")
      expect(yield* Ref.get(productCalls)).toHaveLength(5)
    }),
  ),
)
