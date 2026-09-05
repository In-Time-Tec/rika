import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { RequestId } from "@rika/product/hosted-model"
import { protocolVersion } from "@rika/product/client-protocol"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { TurnId } from "@rika/product/turn-record"
import { HostedThreadApplication } from "../../../../../src/hosted/thread/application"
import { HostedProduct, HostedProductError } from "../../../../../src/hosted/product"
import { HostedThreadProtocol, layer } from "../../../../../src/hosted/thread/protocol"
import { HostedWorkspace } from "../../../../../src/hosted/environment/workspace"
import { fakeApplication, fakeProduct, fakeWorkspace } from "../fakes.harness"
import { actor, memoryStore, ownerId, presenceLayer, snapshot, threadId } from "../memory.fixture"

it.effect("authorizes every historical read as thread:view and never reads after access is revoked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let allowed = true
      let reads = 0
      const before = { createdAt: 1, turnId: TurnId.make("turn-history"), orderKey: "order" }
      const dependencies = Layer.mergeAll(
        Layer.succeed(
          HostedProduct,
          fakeProduct({
            authorizeThread: (_principal, requested, action) => {
              expect(requested).toBe(threadId)
              expect(action).toBe("thread:view")
              return allowed
                ? Effect.succeed({ ownerId, actor })
                : Effect.fail(HostedProductError.make({ kind: "forbidden", message: "Unavailable" }))
            },
          }),
        ),
        Layer.succeed(
          HostedThreadApplication,
          fakeApplication({
            history: (owner, requested, cursor) => {
              reads++
              expect(owner).toBe(ownerId)
              expect(String(requested)).toBe(String(threadId))
              expect(cursor).toEqual(before)
              return Effect.succeed(snapshot.view)
            },
          }),
        ),
        Layer.succeed(HostedWorkspace, fakeWorkspace()),
        Layer.succeed(ThreadProtocolStore, memoryStore()),
        presenceLayer,
        BunCrypto.layer,
      )
      const protocol = Context.get(yield* Layer.build(layer.pipe(Layer.provide(dependencies))), HostedThreadProtocol)
      const connection = yield* protocol.connect("ticket", "/api/v1/threads/socket")
      const request = {
        protocolVersion,
        requestId: RequestId.make("history"),
        command: { _tag: "ReadThreadHistory" as const, threadId, before },
      }
      expect(yield* connection.receive(request)).toMatchObject([
        { payload: { _tag: "ThreadHistory", before, view: snapshot.view } },
      ])
      allowed = false
      expect(yield* connection.receive(request)).toMatchObject([
        { payload: { _tag: "CommandRejected", reason: "forbidden" } },
      ])
      expect(reads).toBe(1)
    }),
  ),
)
