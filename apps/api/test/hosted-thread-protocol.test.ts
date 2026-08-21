import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import {
  BetterAuthUserId,
  ClientId,
  CommandId,
  DeviceId,
  OwnerId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { StoreError } from "@rika/product/hosted-store"
import type { HostedThreadSnapshot } from "@rika/product/client-protocol"
import {
  ThreadProtocolStore,
  type CommandAdmission,
  type ThreadProtocolCommand,
  type ThreadProtocolStoreService,
} from "@rika/product/thread-protocol-store"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { HostedOperations, type HostedOperationsService } from "../src/hosted-operations"
import { HostedProduct, type HostedProductService, type OwnerSelection } from "../src/hosted-product"
import { HostedThreadProtocol, layer as hostedThreadProtocolLayer } from "../src/hosted-thread-protocol"

const timestamp = Timestamp.make("2026-08-21T00:00:00.000Z")
const userId = BetterAuthUserId.make("user-1")
const ownerId = OwnerId.make("owner-1")
const threadId = ThreadId.make("thread-1")
const clientId = ClientId.make("client-1")
const deviceId = DeviceId.make("device-1")
const actor = {
  _tag: "PersonalActor" as const,
  owner: { _tag: "PersonalOwner" as const, userId },
  userId,
  clientId,
  deviceId,
}
const snapshot = {
  thread: {
    id: ProductThreadId.make(threadId),
    workspace: WorkspaceId.make("workspace-1"),
    title: "Thread",
    labels: [],
    pinned: false,
    archived: false,
    lineage: { _tag: "Original" as const },
    createdAt: 1,
    updatedAt: 1,
  },
  turns: [],
  units: [],
  queue: { revision: 0, turns: [] },
  pendingAuthorizations: [],
}

const memoryStore = () => {
  let version = 0n
  let cursor = 0n
  const commands = new Map<string, ThreadProtocolCommand>()
  const keys = new Map<string, string>()
  let latestSnapshot: HostedThreadSnapshot | undefined
  const events: Array<{
    readonly event: {
      readonly _tag: "ExecutionControlled"
      readonly selectionEpoch: number
      readonly action: "cancelled"
    }
    readonly cursor: string
    readonly threadVersion: string
  }> = []
  const service: ThreadProtocolStoreService = {
    initializeThread: () => Effect.void,
    admitCommand: (input) =>
      Effect.suspend((): Effect.Effect<CommandAdmission, StoreError> => {
        const found = commands.get(input.commandId) ?? commands.get(keys.get(input.idempotencyKey) ?? "")
        if (found !== undefined)
          return Effect.succeed({
            _tag: "Duplicate" as const,
            command: found,
          })
        if (input.expectedThreadVersion !== String(version))
          return Effect.fail(StoreError.make({ reason: "stale-version", message: "stale" }))
        version += 1n
        const admitted: ThreadProtocolCommand = {
          ...input,
          threadVersion: ThreadVersion.make(String(version)),
          state: "admitted",
        }
        commands.set(input.commandId, admitted)
        keys.set(input.idempotencyKey, input.commandId)
        return Effect.succeed({ _tag: "Admitted" as const, command: admitted })
      }),
    completeCommand: (input) =>
      Effect.sync(() => {
        const admitted = commands.get(input.commandId)!
        if (admitted.state === "completed") return admitted
        for (const event of input.events) {
          cursor += 1n
          events.push({
            event: event as (typeof events)[number]["event"],
            cursor: String(cursor),
            threadVersion: admitted.threadVersion,
          })
        }
        latestSnapshot = input.snapshot
        const completed: ThreadProtocolCommand = {
          ...admitted,
          state: "completed",
          result: input.result,
          cursor: ThreadEventCursor.make(String(cursor)),
          completedAt: input.completedAt,
        }
        commands.set(input.commandId, completed)
        return completed
      }),
    appendEvents: () => Effect.succeed([]),
    replay: (input) =>
      Effect.succeed({
        threadVersion: ThreadVersion.make(String(version)),
        cursor: ThreadEventCursor.make(String(cursor)),
        ...(latestSnapshot === undefined || BigInt(input.afterCursor) >= cursor
          ? {}
          : {
              snapshot: {
                ownerId,
                threadId,
                threadVersion: ThreadVersion.make(String(version)),
                cursor: ThreadEventCursor.make(String(cursor)),
                snapshot: latestSnapshot,
                createdAt: timestamp,
              },
            }),
        events: events
          .filter((event) => BigInt(event.cursor) > BigInt(input.afterCursor))
          .map((event) => ({
            ownerId,
            threadId,
            sequence: event.cursor,
            cursor: ThreadEventCursor.make(event.cursor),
            threadVersion: ThreadVersion.make(event.threadVersion),
            event: event.event,
            createdAt: timestamp,
          })),
      }),
    acknowledgeCursor: (input) => Effect.succeed(input.cursor),
    issueTicket: () => Effect.void,
    redeemTicket: () =>
      Effect.succeed({
        ticketId: "ticket",
        userId,
        clientId,
        deviceId,
        audience: "/api/v1/threads/socket",
        expiresAt: timestamp,
      }),
    revokeTicket: () => Effect.void,
  }
  return service
}

it.effect("derives personal authority and returns committed outcomes for retries and stale controllers", () => {
  const store = memoryStore()
  let selectedOwner: OwnerSelection | undefined
  const applied: Array<string> = []
  const product: HostedProductService = {
    ready: Effect.void,
    projects: () => Effect.succeed([]),
    activatePrincipal: () => Effect.void,
    authorizeThread: () => Effect.succeed({ ownerId, actor }),
    createConnection: (input) => {
      selectedOwner = input.owner
      return Effect.succeed({ threadId })
    },
    admitRun: () => Effect.die("unused"),
  }
  const operations: HostedOperationsService = {
    run: () => Effect.void,
    thread: () => Effect.succeed(snapshot.thread),
    snapshot: () => Effect.succeed(snapshot),
    interactive: (input) => {
      applied.push(input.commandId)
      return Effect.succeed([{ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" as const }])
    },
  }
  const dependencies = Layer.mergeAll(
    Layer.succeed(HostedProduct, product),
    Layer.succeed(HostedOperations, operations),
    Layer.succeed(ThreadProtocolStore, store),
    BunCrypto.layer,
  )
  return Effect.scoped(
    Effect.gen(function* () {
      const protocol = Context.get(
        yield* Layer.build(hostedThreadProtocolLayer.pipe(Layer.provide(dependencies))),
        HostedThreadProtocol,
      )
      const first = yield* protocol.connect("ticket", "/api/v1/threads/socket")
      const created = yield* first.receive({
        protocolVersion: 1,
        requestId: "request-create" as never,
        command: {
          _tag: "CreateThread",
          commandId: CommandId.make(threadId),
          idempotencyKey: "create-key" as never,
          expectedThreadVersion: ThreadVersion.make("0"),
          owner: { kind: "personal" },
          placement: "local",
        },
      })
      expect(created[0]?.payload).toMatchObject({ _tag: "CommandAccepted", threadVersion: "1" })
      expect(selectedOwner).toEqual({ _tag: "PersonalOwner", userId: "user-1" })

      const cancel = {
        protocolVersion: 1 as const,
        requestId: "request-cancel" as never,
        command: {
          _tag: "Cancel" as const,
          commandId: CommandId.make("cancel-1"),
          idempotencyKey: "cancel-key" as never,
          expectedThreadVersion: ThreadVersion.make("1"),
        },
      }
      expect((yield* first.receive(cancel))[0]?.payload).toMatchObject({ _tag: "CommandAccepted", threadVersion: "2" })
      expect((yield* first.receive({ ...cancel, requestId: "request-retry" as never }))[0]?.payload).toMatchObject({
        _tag: "CommandAccepted",
        requestId: "request-retry",
        threadVersion: "2",
      })
      expect(applied).toEqual(["cancel-1"])

      const second = yield* protocol.connect("ticket-2", "/api/v1/threads/socket")
      yield* second.receive({
        protocolVersion: 1,
        requestId: "request-attach" as never,
        command: { _tag: "AttachThread", threadId, afterCursor: ThreadEventCursor.make("0") },
      })
      expect(
        (yield* second.receive({
          ...cancel,
          requestId: "request-stale" as never,
          command: { ...cancel.command, commandId: CommandId.make("stale"), idempotencyKey: "stale-key" as never },
        }))[0]?.payload,
      ).toMatchObject({ _tag: "CommandRejected", reason: "stale-version", currentThreadVersion: "2" })

      const approval = {
        protocolVersion: 1 as const,
        requestId: "request-approval" as never,
        command: {
          _tag: "Approve" as const,
          commandId: CommandId.make("approval-1"),
          idempotencyKey: "approval-key" as never,
          expectedThreadVersion: ThreadVersion.make("2"),
          turnId: "turn-1" as never,
          authorizationId: "authorization-1",
          checkpoint: { epoch: 1, sequence: 1 } as never,
        },
      }
      expect((yield* first.receive(approval))[0]?.payload).toMatchObject({
        _tag: "CommandRejected",
        reason: "conflict",
      })
      expect(
        (yield* first.receive({ ...approval, requestId: "request-approval-retry" as never }))[0]?.payload,
      ).toMatchObject({
        _tag: "CommandRejected",
        requestId: "request-approval-retry",
        reason: "conflict",
      })
      expect(applied).toEqual(["cancel-1"])
    }),
  )
})
