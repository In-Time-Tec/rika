import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import * as HostedPostgres from "@rika/product-store/layer"
import { Effect, Layer, Redacted, Schema } from "effect"
import { access, authority, live, makeRunnerGateway, socket, workspaceCapabilities } from "./harness"
import { isolated } from "./database.harness"

const encodeLegacy = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

it.effect.skipIf(!live)("rejects obsolete Runner hello and reconnect frames before they acquire a session", () =>
  isolated(({ url }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 4 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority()).pipe(Effect.provide(context))
        const hello = socket()
        yield* gateway.receive(
          hello,
          encodeLegacy({
            _tag: "RunnerHello",
            hello: {
              admissionId: "legacy-admission",
              ticket: "legacy-ticket",
              processIncarnation: "legacy-process",
              capabilities: { nativeTools: true, checkpoints: false, pty: false },
              workspaceCapabilities,
              cursors: { command: 0, event: 0, pty: 0 },
            },
          }),
        )
        const reconnect = socket()
        yield* gateway.receive(reconnect, encodeLegacy({ _tag: "ExecutorReconnect", access }))
        expect(hello.closed).toEqual([[1007, "undecodable RunnerHello frame; peer protocol does not match"]])
        expect(reconnect.closed).toEqual([[1007, "undecodable ExecutorReconnect frame; peer protocol does not match"]])
      }),
    ),
  ),
)
