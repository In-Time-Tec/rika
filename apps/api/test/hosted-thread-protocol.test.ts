import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import * as ExecutionProjection from "@rika/product/execution-projection"
import {
  BetterAuthUserId,
  ClientId,
  CommandId,
  DeviceId,
  IdempotencyKey,
  OwnerId,
  RequestId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { StoreError } from "@rika/product/hosted-store"
import type { HostedThreadSnapshot } from "@rika/product/client-protocol"
import type { InteractiveCommand } from "@rika/product/interactive-command"
import {
  ThreadProtocolStore,
  type CommandAdmission,
  type ThreadProtocolCommand,
  type ThreadProtocolStoreService,
} from "@rika/product/thread-protocol-store"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { TurnId } from "@rika/product/turn-record"
import { HostedOperations, type HostedOperationsService } from "../src/hosted-operations"
import { HostedProduct, type HostedProductService, type OwnerSelection } from "../src/hosted-product"
import { HostedThreadProtocol, layer as hostedThreadProtocolLayer } from "../src/hosted-thread-protocol"
import { layer as hostedStoreLayer } from "@rika/product-store/memory-store"

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
  return Object.assign(service, { command: (id: string) => commands.get(id) })
}

it.effect("derives personal authority, admits a retried submission once, and resyncs stale controllers", () => {
  const store = memoryStore()
  let selectedOwner: OwnerSelection | undefined
  const applied: Array<string> = []
  const product: HostedProductService = {
    ready: Effect.void,
    projects: () => Effect.succeed([]),
    activatePrincipal: () => Effect.void,
    authorizeThread: () => Effect.succeed({ ownerId, actor }),
    threadExecutionContext: () =>
      Effect.succeed({
        repository: { identity: "repository-1", branch: "main" },
        branch: "main",
        executor: { assignmentId: threadId, kind: "local_device", generation: "1" },
      }),
    registerLocalRunner: () => Effect.die("unused"),
    setRemoteThreadCreation: () => Effect.die("unused"),
    pollLocalRunner: () => Effect.die("unused"),
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
    hostedStoreLayer,
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
          localRunnerTarget: { deviceId: "device-1" as never, checkoutFingerprint: "checkout-1" as never },
        },
      })
      expect(created[0]?.payload).toMatchObject({ _tag: "CommandAccepted", threadVersion: "1" })
      expect(selectedOwner).toEqual({ _tag: "PersonalOwner", userId: "user-1" })

      const submit = {
        protocolVersion: 1 as const,
        requestId: "request-submit" as never,
        command: {
          _tag: "SubmitPrompt" as const,
          commandId: CommandId.make("submit-1"),
          idempotencyKey: "submit-key" as never,
          expectedThreadVersion: ThreadVersion.make("1"),
          text: "queued while busy",
        },
      }
      expect((yield* first.receive(submit))[0]?.payload).toMatchObject({ _tag: "CommandAccepted", threadVersion: "2" })
      expect((yield* first.receive({ ...submit, requestId: "request-retry" as never }))[0]?.payload).toMatchObject({
        _tag: "CommandAccepted",
        requestId: "request-retry",
        threadVersion: "2",
      })
      expect(applied).toEqual(["submit-1"])

      const cancel = {
        protocolVersion: 1 as const,
        requestId: "request-cancel" as never,
        command: {
          _tag: "Cancel" as const,
          commandId: CommandId.make("cancel-1"),
          idempotencyKey: "cancel-key" as never,
          expectedThreadVersion: ThreadVersion.make("2"),
        },
      }
      expect((yield* first.receive(cancel))[0]?.payload).toMatchObject({
        _tag: "CommandAccepted",
        threadVersion: "3",
      })
      expect(
        (yield* first.receive({ ...cancel, requestId: "request-cancel-retry" as never }))[0]?.payload,
      ).toMatchObject({
        _tag: "CommandAccepted",
        requestId: "request-cancel-retry",
        threadVersion: "3",
      })
      expect(applied).toEqual(["submit-1", "cancel-1"])

      const second = yield* protocol.connect("ticket-2", "/api/v1/threads/socket")
      yield* second.receive({
        protocolVersion: 1,
        requestId: "request-attach" as never,
        command: { _tag: "AttachThread", threadId, afterCursor: ThreadEventCursor.make("0") },
      })
      expect(
        (yield* second.receive({
          ...submit,
          requestId: "request-stale" as never,
          command: { ...submit.command, commandId: CommandId.make("stale"), idempotencyKey: "stale-key" as never },
        }))[0]?.payload,
      ).toMatchObject({
        _tag: "CommandRejected",
        reason: "stale-version",
        currentThreadVersion: "3",
        currentCursor: "2",
      })

      const approval = {
        protocolVersion: 1 as const,
        requestId: "request-approval" as never,
        command: {
          _tag: "Approve" as const,
          commandId: CommandId.make("approval-1"),
          idempotencyKey: "approval-key" as never,
          expectedThreadVersion: ThreadVersion.make("3"),
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
      expect(applied).toEqual(["submit-1", "cancel-1"])
    }),
  )
})

it.effect("binds authorization decisions to one durable checkpoint", () => {
  const store = memoryStore()
  const checkpoint = {
    version: ExecutionProjection.projectionVersion,
    cursor: "authorization-cursor",
    state: JSON.stringify({ operation: "shell", arguments: "bun test" }),
  }
  let currentSnapshot: HostedThreadSnapshot = {
    ...snapshot,
    pendingAuthorizations: [
      {
        threadId,
        turnId: TurnId.make("turn-authorization"),
        authorizationId: "authorization-1",
        operation: "shell",
        capability: "process",
        input: "bun test",
        inputTruncated: false,
        checkpoint,
      },
    ],
  }
  const delivered: Array<InteractiveCommand> = []
  const product: HostedProductService = {
    ready: Effect.void,
    projects: () => Effect.succeed([]),
    activatePrincipal: () => Effect.void,
    createConnection: () => Effect.die("unused"),
    authorizeThread: () => Effect.succeed({ ownerId, actor }),
    threadExecutionContext: () =>
      Effect.succeed({
        repository: { identity: "In-Time-Tec/rika", branch: "feature/thread-controls" },
        branch: "feature/thread-controls",
        executor: { assignmentId: threadId, kind: "e2b", generation: "7" },
      }),
    registerLocalRunner: () => Effect.die("unused"),
    setRemoteThreadCreation: () => Effect.die("unused"),
    pollLocalRunner: () => Effect.die("unused"),
    admitRun: () => Effect.die("unused"),
  }
  const operations: HostedOperationsService = {
    run: () => Effect.void,
    thread: () => Effect.succeed(currentSnapshot.thread),
    interactive: (input: { readonly command: InteractiveCommand }) =>
      Effect.sync(() => {
        delivered.push(input.command)
        currentSnapshot = { ...currentSnapshot, pendingAuthorizations: [] }
        return []
      }),
    snapshot: () => Effect.succeed(currentSnapshot),
  }

  const dependencies = Layer.mergeAll(
    Layer.succeed(HostedProduct, product),
    Layer.succeed(HostedOperations, operations),
    Layer.succeed(ThreadProtocolStore, store),
    hostedStoreLayer,
    BunCrypto.layer,
  )
  return Effect.scoped(
    Effect.gen(function* () {
      const protocol = Context.get(
        yield* Layer.build(hostedThreadProtocolLayer.pipe(Layer.provide(dependencies))),
        HostedThreadProtocol,
      )
      const session = yield* protocol.connect("ticket", "/api/v1/threads/socket")
      const attached = yield* session.receive({
        protocolVersion: 1,
        requestId: RequestId.make("attach-authorization"),
        command: { _tag: "AttachThread", threadId, afterCursor: ThreadEventCursor.make("0") },
      })
      expect(attached).toMatchObject([{ payload: { _tag: "ThreadSnapshot", snapshot: currentSnapshot } }])

      const approve = {
        protocolVersion: 1 as const,
        requestId: RequestId.make("approve-request"),
        command: {
          _tag: "Approve" as const,
          commandId: CommandId.make("approve-command"),
          idempotencyKey: IdempotencyKey.make("approve-key"),
          expectedThreadVersion: ThreadVersion.make("0"),
          turnId: TurnId.make("turn-authorization"),
          authorizationId: "authorization-1",
          checkpoint,
        },
      }
      expect(yield* session.receive(approve)).toMatchObject([
        { payload: { _tag: "CommandAccepted", threadVersion: "1", result: { _tag: "Applied" } } },
      ])
      expect(yield* session.receive(approve)).toMatchObject([
        { payload: { _tag: "CommandAccepted", threadVersion: "1", result: { _tag: "Applied" } } },
      ])
      expect(delivered).toEqual([
        {
          _tag: "ApproveAuthorization",
          turnId: "turn-authorization",
          authorizationId: "authorization-1",
          checkpoint,
        },
      ])
      expect(store.command("approve-command")?.result).toEqual({
        _tag: "Applied",
        authorization: {
          actor,
          turnId: "turn-authorization",
          authorizationId: "authorization-1",
          checkpoint,
          operation: "shell",
          capability: "process",
          arguments: "bun test",
          repository: { identity: "In-Time-Tec/rika", branch: "feature/thread-controls" },
          branch: "feature/thread-controls",
          executor: { assignmentId: threadId, kind: "e2b", generation: "7" },
          decision: "approve",
          result: { _tag: "Delivered" },
        },
      })

      expect(
        yield* session.receive({
          protocolVersion: 1,
          requestId: RequestId.make("stale-request"),
          command: {
            ...approve.command,
            commandId: CommandId.make("stale-command"),
            idempotencyKey: IdempotencyKey.make("stale-key"),
            expectedThreadVersion: ThreadVersion.make("1"),
          },
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "CommandRejected",
            reason: "conflict",
            message: "Authorization checkpoint is stale or does not belong to this Thread",
          },
        },
      ])
      expect(delivered).toHaveLength(1)

      currentSnapshot = {
        ...currentSnapshot,
        pendingAuthorizations: [
          {
            threadId: ThreadId.make("another-thread"),
            turnId: approve.command.turnId,
            authorizationId: approve.command.authorizationId,
            operation: "shell",
            capability: "process",
            input: "bun test",
            inputTruncated: false,
            checkpoint,
          },
        ],
      }
      expect(
        yield* session.receive({
          protocolVersion: 1,
          requestId: RequestId.make("cross-thread-request"),
          command: {
            ...approve.command,
            commandId: CommandId.make("cross-thread-command"),
            idempotencyKey: IdempotencyKey.make("cross-thread-key"),
            expectedThreadVersion: ThreadVersion.make("2"),
          },
        }),
      ).toMatchObject([{ payload: { _tag: "CommandRejected", reason: "conflict" } }])
      expect(delivered).toHaveLength(1)

      const denialCheckpoint = { ...checkpoint, cursor: "denial-cursor" }
      currentSnapshot = {
        ...currentSnapshot,
        pendingAuthorizations: [
          {
            threadId,
            turnId: TurnId.make("turn-denial"),
            authorizationId: "authorization-2",
            operation: "write-file",
            capability: "filesystem",
            input: '{"path":"README.md"}',
            inputTruncated: false,
            checkpoint: denialCheckpoint,
          },
        ],
      }
      expect(
        yield* session.receive({
          protocolVersion: 1,
          requestId: RequestId.make("deny-request"),
          command: {
            _tag: "Deny",
            commandId: CommandId.make("deny-command"),
            idempotencyKey: IdempotencyKey.make("deny-key"),
            expectedThreadVersion: ThreadVersion.make("3"),
            turnId: TurnId.make("turn-denial"),
            authorizationId: "authorization-2",
            checkpoint: denialCheckpoint,
          },
        }),
      ).toMatchObject([{ payload: { _tag: "CommandAccepted", result: { _tag: "Applied" } } }])
      expect(delivered[1]).toEqual({
        _tag: "DenyAuthorization",
        turnId: "turn-denial",
        authorizationId: "authorization-2",
        checkpoint: denialCheckpoint,
      })
      expect(store.command("deny-command")?.result).toMatchObject({
        authorization: {
          decision: "deny",
          operation: "write-file",
          arguments: '{"path":"README.md"}',
          result: { _tag: "Delivered" },
        },
      })
    }),
  )
})
