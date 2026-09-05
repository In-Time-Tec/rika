import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Schema } from "effect"
import { ClientMessage, protocolVersion } from "@rika/product/client-protocol"
import { ThreadEventCursor, ThreadVersion } from "@rika/product/hosted-model"
import { HostedPresence } from "@rika/product/hosted-presence"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { HostedProduct, HostedProductError } from "../../../../src/hosted/product"
import { HostedThreadApplication } from "../../../../src/hosted/thread/application"
import { HostedWorkspace } from "../../../../src/hosted/environment/workspace"
import { HostedThreadProtocol, layerWithOptions } from "../../../../src/hosted/thread/protocol"
import { makeThreadProtocolNotifications } from "../../../../src/hosted/thread/notifications"
import { fakeApplication, fakeProduct, fakeWorkspace } from "../protocol/fakes.harness"
import { memoryStore, ownerId, snapshot, threadId, timestamp } from "../protocol/memory.fixture"

it.effect("browser reads use the durable replay, deny every non-read command, and revoke midstream", () =>
  Effect.gen(function* () {
    const store = memoryStore()
    let sessionActive = true
    let access = true
    const notifications = makeThreadProtocolNotifications()
    const layer = layerWithOptions({ notifications }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            HostedProduct,
            fakeProduct({
              authorizeReadThread: () =>
                access
                  ? Effect.succeed({ ownerId })
                  : Effect.fail(HostedProductError.make({ kind: "forbidden", message: "revoked" })),
            }),
          ),
          Layer.succeed(HostedThreadApplication, fakeApplication({ snapshot: () => Effect.succeed(snapshot) })),
          Layer.succeed(HostedWorkspace, fakeWorkspace()),
          Layer.succeed(ThreadProtocolStore, {
            ...store,
            acknowledgeCursor: () => Effect.die("Browser wrote an acknowledgement"),
            admitCommand: () => Effect.die("Browser admitted a mutation"),
          }),
          Layer.succeed(HostedPresence, {
            upsert: () => Effect.die("Browser wrote presence"),
            list: () => Effect.die("Browser listed device presence"),
          }),
          BunCrypto.layer,
        ),
      ),
    )
    const protocol = Context.get(yield* Layer.build(layer), HostedThreadProtocol)
    const principal = { _tag: "BrowserRead" as const, userId: "user-1", validate: Effect.sync(() => sessionActive) }
    const connection = yield* protocol.connectBrowser(principal)
    const message = (command: Schema.Json) =>
      Schema.decodeUnknownSync(ClientMessage)({ protocolVersion, requestId: "browser-test", command })
    const attached = yield* connection.receive(message({ _tag: "AttachThread", threadId, afterCursor: "0" }))
    expect(attached).toMatchObject([
      { payload: { _tag: "ThreadAttached", participants: [], checkpoint: { snapshot } } },
    ])
    const common = { threadId, commandId: "command", idempotencyKey: "key", expectedThreadVersion: "0" }
    for (const command of [
      { _tag: "AcknowledgeCursor", threadId, cursor: "0" },
      { _tag: "UpdatePresence", threadId, status: "viewing" },
      { _tag: "SubmitPrompt", ...common, text: "must not run" },
      { _tag: "Cancel", ...common, target: { _tag: "Turn", turnId: "turn" } },
      { _tag: "ArchiveThread", ...common },
      { _tag: "OpenPortal", threadId, port: 3000 },
      { _tag: "InspectWorkspaceFile", threadId, path: "/private", maximumBytes: 100 },
      {
        _tag: "CreateThread",
        commandId: "command",
        idempotencyKey: "key",
        expectedThreadVersion: "0",
        executorKind: "orb",
        owner: { kind: "personal" },
      },
    ])
      expect(yield* connection.receive(message(command))).toMatchObject([
        { payload: { _tag: "CommandRejected", reason: "forbidden" } },
      ])
    yield* store.appendEvents({
      ownerId,
      threadId,
      events: [{ _tag: "ThreadViewSnapshot", snapshot: snapshot.view }],
      createdAt: timestamp,
    })
    const waiting = yield* Effect.forkChild(connection.outbound, { startImmediately: true })
    notifications.recover()
    expect(yield* Fiber.join(waiting)).toMatchObject([{ payload: { _tag: "ThreadEvent", event: { cursor: "1" } } }])
    yield* store.checkpoint({
      ownerId,
      threadId,
      threadVersion: ThreadVersion.make("0"),
      cursor: ThreadEventCursor.make("1"),
      snapshot,
      createdAt: timestamp,
    })
    const reset = yield* Effect.forkChild(connection.outbound, { startImmediately: true })
    notifications.recover()
    expect(yield* Fiber.join(reset)).toMatchObject([{ payload: { _tag: "ThreadSnapshot", cursor: "1" } }])
    yield* connection.receive(message({ _tag: "Detach" }))
    expect(
      yield* connection.receive(message({ _tag: "AttachThread", threadId: "another-thread", afterCursor: "0" })),
    ).toMatchObject([{ payload: { _tag: "CommandRejected", reason: "forbidden" } }])
    access = false
    expect(yield* connection.validate!).toBe(false)
    expect(yield* connection.receive(message({ _tag: "AttachThread", threadId, afterCursor: "1" }))).toMatchObject([
      { payload: { _tag: "CommandRejected" } },
    ])
    access = true
    sessionActive = false
    expect(yield* connection.validate!).toBe(false)
    expect((yield* Effect.result(protocol.connectBrowser(principal)))._tag).toBe("Failure")
    yield* connection.detach
  }),
)
