import "./protocol.harness"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer } from "effect"
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
import type { AuthorizationAction } from "@rika/product/hosted-authorization"
import { protocolVersion, type HostedThreadSnapshot } from "@rika/product/client-protocol"
import type { InteractiveCommand } from "@rika/product/interactive-command"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import {
  ThreadProtocolStore,
  type CommandAdmission,
  type ThreadProtocolCommand,
  type ThreadProtocolStoreService,
} from "@rika/product/thread-protocol-store"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { TurnId } from "@rika/product/turn-record"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import { HostedThreadApplication, type HostedThreadApplicationService } from "../../../src/hosted/thread/application"
import {
  HostedProduct,
  HostedProductError,
  type HostedProductService,
  type OwnerSelection,
} from "../../../src/hosted/product"
import {
  HostedThreadProtocol,
  type HostedThreadConnection,
  layer as hostedThreadProtocolLayer,
  layerWithOptions as hostedThreadProtocolLayerWithOptions,
} from "../../../src/hosted/thread/protocol"
import { makeThreadProtocolNotifications } from "../../../src/hosted/thread/notifications"
import { layer as hostedStoreLayer } from "@rika/product-store/memory-store"
import { HostedToolPolicy } from "../../../src/hosted/execution/tool-policy"
import { HostedWorkspace, HostedWorkspaceError } from "../../../src/hosted/environment/workspace"
import { testToolPolicy } from "../execution/tool-policy.fixture"

const timestamp = Timestamp.make("2026-08-21T00:00:00.000Z")
const userId = BetterAuthUserId.make("user-1")
const ownerId = OwnerId.make("owner-1")
const threadId = ThreadId.make("thread-1")
const assignmentId = "assignment-1"
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
  executorKind: "runner" as const,
  view: {
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
    revision: 0,
    source: { projectionVersion: ExecutionProjection.projectionVersion },
    turns: [],
    pending: [],
    hasOlder: false,
    hasNewer: false,
    usage: { state: ExecutionProjection.emptyUsageState() },
  },
  pendingAuthorizations: [],
}

const memoryStore = () => {
  let version = 0n
  let cursor = 0n
  const commands = new Map<string, ThreadProtocolCommand>()
  const keys = new Map<string, string>()
  const admissions: Array<{
    readonly threadId: string
    readonly commandId: string
  }> = []
  let latestSnapshot: HostedThreadSnapshot | undefined
  let latestSnapshotCursor = 0n
  let latestSnapshotVersion = 0n
  let snapshotSaves = 0
  const claims = new Map<string, string>()
  const acknowledgements: Array<{
    readonly threadId: string
    readonly cursor: string
  }> = []
  const events: Array<{
    readonly event: InteractiveEvent
    readonly cursor: string
    readonly threadVersion: string
  }> = []
  const service: ThreadProtocolStoreService = {
    initializeThread: () => Effect.void,
    admitCommand: (input) =>
      Effect.suspend((): Effect.Effect<CommandAdmission, StoreError> => {
        admissions.push({
          threadId: input.threadId,
          commandId: input.commandId,
        })
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
    claimNextCommand: () => Effect.die("unused"),
    renewCommandClaim: (input) => Effect.sync(() => claims.get(input.commandId) === input.claimToken),
    releaseCommandClaim: (input) =>
      Effect.sync(() => {
        if (claims.get(input.commandId) === input.claimToken) claims.delete(input.commandId)
      }),
    completeCommand: (input) =>
      Effect.sync(() => {
        const admitted = commands.get(input.commandId)!
        if (admitted.state === "completed") return { _tag: "Duplicate" as const, command: admitted }
        for (const event of input.events) {
          cursor += 1n
          events.push({
            event,
            cursor: String(cursor),
            threadVersion: admitted.threadVersion,
          })
        }
        if (input.snapshot !== undefined) {
          latestSnapshot = input.snapshot
          latestSnapshotCursor = cursor
          latestSnapshotVersion = BigInt(admitted.threadVersion)
        }
        const completed: ThreadProtocolCommand = {
          ...admitted,
          state: "completed",
          result: input.result,
          cursor: ThreadEventCursor.make(String(cursor)),
          completedAt: input.completedAt,
        }
        commands.set(input.commandId, completed)
        return { _tag: "Completed" as const, command: completed }
      }),
    appendEvents: (input) =>
      Effect.sync(() => {
        const written = input.events.map((event) => {
          cursor += 1n
          events.push({
            event,
            cursor: String(cursor),
            threadVersion: String(version),
          })
          return {
            ownerId,
            threadId,
            sequence: String(cursor),
            cursor: ThreadEventCursor.make(String(cursor)),
            threadVersion: ThreadVersion.make(String(version)),
            event,
            createdAt: input.createdAt,
          }
        })
        latestSnapshot = input.snapshot
        latestSnapshotCursor = cursor
        latestSnapshotVersion = version
        return written
      }),
    saveSnapshot: (input) =>
      Effect.sync(() => {
        snapshotSaves += 1
        latestSnapshot = input.snapshot
        latestSnapshotCursor = BigInt(input.cursor)
        latestSnapshotVersion = BigInt(input.threadVersion)
      }),
    replay: (input) =>
      Effect.sync(() => {
        const targetCursor =
          input.throughCursor === undefined || BigInt(input.throughCursor) > cursor
            ? cursor
            : BigInt(input.throughCursor)
        const includeSnapshot =
          input.includeSnapshot !== false && latestSnapshot !== undefined && latestSnapshotCursor <= targetCursor
        const replayCursor = includeSnapshot ? latestSnapshotCursor : BigInt(input.afterCursor)
        const replay = {
          threadVersion: ThreadVersion.make(String(version)),
          cursor: ThreadEventCursor.make(String(cursor)),
          events: events
            .filter((event) => BigInt(event.cursor) > replayCursor && BigInt(event.cursor) <= targetCursor)
            .slice(0, input.limit)
            .map((event) => ({
              ownerId,
              threadId,
              sequence: event.cursor,
              cursor: ThreadEventCursor.make(event.cursor),
              threadVersion: ThreadVersion.make(event.threadVersion),
              event: event.event,
              createdAt: timestamp,
            })),
        }
        if (includeSnapshot && latestSnapshot !== undefined)
          return {
            ...replay,
            snapshot: {
              ownerId,
              threadId,
              threadVersion: ThreadVersion.make(String(latestSnapshotVersion)),
              cursor: ThreadEventCursor.make(String(latestSnapshotCursor)),
              snapshot: latestSnapshot,
              createdAt: timestamp,
            },
          }
        return replay
      }),
    acknowledgeCursor: (input) =>
      Effect.sync(() => {
        acknowledgements.push({
          threadId: input.threadId,
          cursor: input.cursor,
        })
        return input.cursor
      }),
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
  return Object.assign(service, {
    admissions: () => admissions,
    acknowledgements: () => acknowledgements,
    command: (id: string) => commands.get(id),
    snapshotSaves: () => snapshotSaves,
    dropSnapshot: () => {
      latestSnapshot = undefined
      latestSnapshotCursor = 0n
      latestSnapshotVersion = 0n
    },
    dropEventsThrough: (throughCursor: string) => {
      const retained = events.filter((event) => BigInt(event.cursor) > BigInt(throughCursor))
      events.splice(0, events.length, ...retained)
    },
  })
}

it.effect("derives personal authority, admits a retried submission once, and resyncs stale controllers", () => {
  const store = memoryStore()
  const notifications = makeThreadProtocolNotifications()
  let selectedOwner: OwnerSelection | undefined
  const applied: Array<string> = []
  const admittedRuns: Array<Parameters<HostedProductService["admitRun"]>[0]> = []
  const authorizedActions: Array<AuthorizationAction> = []
  const workspaceRequests: Array<string> = []
  const workspaceLifecycle: Array<"paused" | "resumed"> = []
  let pauseAttempts = 0
  const product: HostedProductService = {
    ready: Effect.void,
    projects: () => Effect.succeed([]),
    createProject: () => Effect.die("unused"),
    activatePrincipal: () => Effect.void,
    authorizeThread: (_principal, _threadId, action) =>
      Effect.sync(() => {
        authorizedActions.push(action)
        return { ownerId, actor }
      }),
    threadExecutionContext: () =>
      Effect.succeed({
        repository: { identity: "repository-1", branch: "main" },
        branch: "main",
        executor: { assignmentId, kind: "runner", generation: "1" },
      }),
    registerRunner: () => Effect.die("unused"),
    setRemoteThreadCreation: () => Effect.die("unused"),
    pollRunner: () => Effect.die("unused"),
    createConnection: (input) =>
      input.threadId === "create-failed"
        ? Effect.fail(
            HostedProductError.make({
              kind: "unavailable",
              message: "creation unavailable",
            }),
          )
        : Effect.sync(() => {
            selectedOwner = input.owner
            return { threadId }
          }),
    admitRun: (input) =>
      Effect.sync(() => {
        if (input.operationKey === "submit-cancelled")
          return {
            _tag: "Cancelled" as const,
            commandId: input.operationKey,
          }
        if (!admittedRuns.some((admitted) => admitted.operationKey === input.operationKey)) admittedRuns.push(input)
        return {
          _tag: "Admitted" as const,
          commandId: input.operationKey,
          turnId: `turn-${input.operationKey}`,
          status: "queued" as const,
        }
      }),
    admitAuthorizedRun: () => Effect.die("unused"),
    cancelRunAdmission: (input) =>
      input.targetCommandId === "submit-cancelled" ? Effect.succeed({}) : Effect.die("unused"),
    cancelAuthorizedRunAdmission: () => Effect.die("unused"),
  }
  const operations: HostedThreadApplicationService = {
    thread: () => Effect.succeed(snapshot.view.thread),
    snapshot: () => Effect.succeed(snapshot),
    interactive: (input, persist) => {
      applied.push(input.commandId)
      return persist({
        events: [{ _tag: "ExecutionControlled", action: "cancelled" as const }],
        snapshot,
      })
    },
  }
  const dependencies = Layer.mergeAll(
    Layer.succeed(HostedProduct, product),
    Layer.succeed(HostedThreadApplication, operations),
    Layer.succeed(
      HostedWorkspace,
      HostedWorkspace.of({
        execute: (_threadId, request) =>
          Effect.sync(() => {
            workspaceRequests.push(request._tag)
            if (request._tag === "WorkspaceFileInspect")
              return {
                _tag: "WorkspaceFileContent" as const,
                requestId: request.requestId,
                path: request.path,
                sizeBytes: 2,
                contentBase64: "e30=",
              }
            return {
              _tag:
                request._tag === "RepositoryServiceEnsure"
                  ? ("RepositoryServiceRunning" as const)
                  : ("RepositoryServiceStopped" as const),
              requestId: request.requestId,
              serviceId: request._tag === "RepositoryServiceEnsure" ? request.service.serviceId : request.serviceId,
            }
          }),
        pause: () =>
          Effect.suspend(() => {
            pauseAttempts += 1
            if (pauseAttempts === 1)
              return Effect.fail(
                HostedWorkspaceError.make({
                  kind: "unavailable",
                  message: "pause interrupted",
                }),
              )
            return Effect.sync(() => void workspaceLifecycle.push("paused"))
          }),
        resume: () => Effect.sync(() => void workspaceLifecycle.push("resumed")),
        portal: (_threadId, port) => Effect.succeed(`https://${port}-orb.e2b.app`),
      }),
    ),
    Layer.succeed(ThreadProtocolStore, store),
    hostedStoreLayer,
    Layer.succeed(HostedToolPolicy, testToolPolicy),
    BunCrypto.layer,
  )
  return Effect.scoped(
    Effect.gen(function* () {
      const protocol = Context.get(
        yield* Layer.build(hostedThreadProtocolLayerWithOptions({ notifications }).pipe(Layer.provide(dependencies))),
        HostedThreadProtocol,
      )
      const first = yield* protocol.connect("ticket", "/api/v1/threads/socket")
      const created = yield* first.receive({
        protocolVersion,
        requestId: RequestId.make("request-create"),
        command: {
          _tag: "CreateThread",
          commandId: CommandId.make(threadId),
          idempotencyKey: IdempotencyKey.make("create-key"),
          expectedThreadVersion: ThreadVersion.make("0"),
          owner: { kind: "personal" },
          executorKind: "runner",
          runnerTarget: {
            deviceId,
            checkoutFingerprint: CheckoutFingerprint.make("checkout-1"),
          },
        },
      })
      expect(created[0]?.payload).toMatchObject({
        _tag: "CommandAdmitted",
        threadVersion: "1",
      })
      const creationCompletion = yield* Effect.forkChild(first.outbound, {
        startImmediately: true,
      })
      yield* store.completeCommand({
        ownerId,
        threadId,
        commandId: CommandId.make(threadId),
        claimToken: "create-claim",
        result: { _tag: "ThreadCreated", threadId },
        events: [],
        completedAt: timestamp,
      })
      notifications.recover()
      expect(yield* Fiber.join(creationCompletion)).toMatchObject([
        {
          payload: {
            _tag: "CommandAccepted",
            requestId: "request-create",
            commandId: threadId,
            result: { _tag: "ThreadCreated", threadId },
          },
        },
      ])
      expect(selectedOwner).toEqual({
        _tag: "PersonalOwner",
        userId: "user-1",
      })
      store.dropSnapshot()
      expect(
        yield* first.receive({
          protocolVersion,
          requestId: RequestId.make("request-bootstrap"),
          command: {
            _tag: "AttachThread",
            threadId,
            afterCursor: ThreadEventCursor.make("0"),
          },
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "ThreadAttached",
            threadVersion: "1",
            cursor: "0",
            snapshotThreadVersion: "1",
            snapshotCursor: "0",
            snapshot,
            events: [],
          },
        },
      ])

      expect(
        (yield* first.receive({
          protocolVersion,
          requestId: RequestId.make("request-inspect"),
          command: {
            _tag: "InspectWorkspaceFile",
            threadId,
            path: "src/main.ts",
            maximumBytes: 1024,
          },
        }))[0]?.payload,
      ).toMatchObject({
        _tag: "WorkspaceFileInspected",
        inspection: {
          _tag: "WorkspaceFileContent",
          path: "src/main.ts",
          contentBase64: "e30=",
        },
      })
      expect(authorizedActions).toContain("workspace:file:view")

      const submit = {
        protocolVersion,
        requestId: RequestId.make("request-submit"),
        command: {
          _tag: "SubmitPrompt" as const,
          threadId,
          commandId: CommandId.make("submit-1"),
          idempotencyKey: IdempotencyKey.make("submit-key"),
          expectedThreadVersion: ThreadVersion.make("1"),
          text: "queued while busy",
          mode: "high",
          attachments: [
            {
              mediaType: "image/png",
              data: "aW1hZ2U=",
              filename: "evidence.png",
            },
          ],
        },
      }
      const submitted = yield* first.receive(submit)
      expect(submitted[0]?.payload).toMatchObject({
        _tag: "CommandAdmitted",
        threadVersion: "2",
      })
      expect(submitted).toHaveLength(1)
      expect(
        yield* first.receive({
          ...submit,
          requestId: RequestId.make("request-retry"),
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "CommandAdmitted",
            requestId: "request-retry",
            threadVersion: "2",
          },
        },
      ])
      expect(admittedRuns).toEqual([])
      expect(applied).toEqual([])

      const cancel = {
        protocolVersion,
        requestId: RequestId.make("request-cancel"),
        command: {
          _tag: "Cancel" as const,
          threadId,
          commandId: CommandId.make("cancel-1"),
          idempotencyKey: IdempotencyKey.make("cancel-key"),
          expectedThreadVersion: ThreadVersion.make("2"),
          target: { _tag: "Turn" as const, turnId: TurnId.make("turn-1") },
        },
      }
      expect((yield* first.receive(cancel))[0]?.payload).toMatchObject({
        _tag: "CommandAdmitted",
        threadVersion: "3",
      })
      expect(
        (yield* first.receive({
          ...cancel,
          requestId: RequestId.make("request-cancel-retry"),
        }))[0]?.payload,
      ).toMatchObject({
        _tag: "CommandAdmitted",
        requestId: "request-cancel-retry",
        threadVersion: "3",
      })
      expect(applied).toEqual([])

      const second = yield* protocol.connect("ticket-2", "/api/v1/threads/socket")
      expect(
        yield* second.receive({
          protocolVersion,
          requestId: RequestId.make("request-attach"),
          command: {
            _tag: "AttachThread",
            threadId,
            afterCursor: ThreadEventCursor.make("0"),
          },
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "ThreadAttached",
            cursor: "0",
            snapshotCursor: "0",
            events: [],
            participants: [],
          },
        },
      ])
      expect(
        (yield* second.receive({
          protocolVersion,
          requestId: RequestId.make("request-attach-thread-2"),
          command: {
            _tag: "AttachThread",
            threadId: ThreadId.make("thread-2"),
            afterCursor: ThreadEventCursor.make("0"),
          },
        }))[0]?.payload,
      ).toMatchObject({ _tag: "ThreadAttached", threadId: "thread-2" })
      expect(
        (yield* second.receive({
          protocolVersion,
          requestId: RequestId.make("request-create-failed"),
          command: {
            _tag: "CreateThread",
            commandId: CommandId.make("create-failed"),
            idempotencyKey: IdempotencyKey.make("create-failed"),
            expectedThreadVersion: ThreadVersion.make("0"),
            owner: { kind: "personal" },
            executorKind: "runner",
            runnerTarget: {
              deviceId,
              checkoutFingerprint: CheckoutFingerprint.make("checkout-1"),
            },
          },
        }))[0]?.payload,
      ).toEqual({
        _tag: "CommandRejected",
        requestId: "request-create-failed",
        commandId: "create-failed",
        reason: "unavailable",
        message: "creation unavailable",
        details: {},
      })
      expect(
        (yield* second.receive({
          protocolVersion,
          requestId: RequestId.make("request-acknowledge-thread-1"),
          command: {
            _tag: "AcknowledgeCursor",
            threadId,
            cursor: ThreadEventCursor.make("0"),
          },
        }))[0]?.payload,
      ).toMatchObject({
        _tag: "CommandAccepted",
        threadId,
      })
      expect(store.acknowledgements()).toEqual([{ threadId, cursor: "0" }])
      expect(
        (yield* second.receive({
          ...submit,
          requestId: RequestId.make("request-submit-while-attached-thread-2"),
        }))[0]?.payload,
      ).toMatchObject({ _tag: "CommandAdmitted", threadId })
      expect(store.admissions().at(-1)).toEqual({
        threadId,
        commandId: "submit-1",
      })
      const submitCompletion = yield* Effect.forkChild(second.outbound, { startImmediately: true })
      yield* store.completeCommand({
        ownerId,
        threadId,
        commandId: CommandId.make("submit-1"),
        claimToken: "submit-claim",
        result: { _tag: "PromptAdmitted", status: "queued" },
        events: [],
        completedAt: timestamp,
      })
      notifications.publish(threadId)
      expect(yield* Fiber.join(submitCompletion)).toMatchObject([
        {
          payload: {
            _tag: "CommandAccepted",
            requestId: "request-submit-while-attached-thread-2",
            commandId: "submit-1",
            threadId,
            result: { _tag: "PromptAdmitted", status: "queued" },
          },
        },
      ])
      expect(
        (yield* second.receive({
          ...submit,
          requestId: RequestId.make("request-stale"),
          command: {
            ...submit.command,
            commandId: CommandId.make("stale"),
            idempotencyKey: IdempotencyKey.make("stale-key"),
          },
        }))[0]?.payload,
      ).toMatchObject({
        _tag: "CommandRejected",
        threadId,
        reason: "stale-version",
        currentThreadVersion: "3",
        currentCursor: "0",
      })

      const approval = {
        protocolVersion,
        requestId: RequestId.make("request-approval"),
        command: {
          _tag: "Approve" as const,
          threadId,
          commandId: CommandId.make("approval-1"),
          idempotencyKey: IdempotencyKey.make("approval-key"),
          expectedThreadVersion: ThreadVersion.make("3"),
          turnId: TurnId.make("turn-1"),
          authorizationId: "authorization-1",
          checkpoint: ExecutionProjection.Checkpoint.make({
            version: ExecutionProjection.projectionVersion,
            cursor: "approval-cursor",
            state: "{}",
          }),
        },
      }
      expect((yield* first.receive(approval))[0]?.payload).toMatchObject({
        _tag: "CommandAdmitted",
        threadVersion: "4",
      })
      expect(
        (yield* first.receive({
          ...approval,
          requestId: RequestId.make("request-approval-retry"),
        }))[0]?.payload,
      ).toMatchObject({
        _tag: "CommandAdmitted",
        requestId: "request-approval-retry",
        threadVersion: "4",
      })
      expect(applied).toEqual([])

      const ensureService = {
        protocolVersion,
        requestId: RequestId.make("request-service"),
        command: {
          _tag: "EnsureRepositoryService" as const,
          threadId,
          commandId: CommandId.make("service-1"),
          idempotencyKey: IdempotencyKey.make("service-key"),
          expectedThreadVersion: ThreadVersion.make("4"),
          service: {
            serviceId: "docs",
            command: "bun",
            args: ["run", "dev"],
            cwd: ".",
          },
        },
      }
      expect((yield* first.receive(ensureService))[0]?.payload).toMatchObject({
        _tag: "CommandAdmitted",
        threadVersion: "5",
      })
      expect(
        (yield* first.receive({
          ...ensureService,
          requestId: RequestId.make("request-service-retry"),
        }))[0]?.payload,
      ).toMatchObject({ _tag: "CommandAdmitted", threadVersion: "5" })
      expect(authorizedActions).toContain("workspace:service:control")
      expect(workspaceRequests).toEqual(["WorkspaceFileInspect"])
      expect(
        (yield* first.receive({
          protocolVersion,
          requestId: RequestId.make("request-portal"),
          command: { _tag: "OpenPortal", threadId, port: 3000 },
        }))[0]?.payload,
      ).toMatchObject({
        _tag: "PortalOpened",
        port: 3000,
        url: "https://3000-orb.e2b.app",
      })
      expect(workspaceLifecycle).toEqual([])
      const cancellationFirst = yield* first.receive({
        protocolVersion,
        requestId: RequestId.make("request-cancel-before-submit"),
        command: {
          _tag: "Cancel",
          threadId,
          commandId: CommandId.make("cancel-before-submit"),
          idempotencyKey: IdempotencyKey.make("cancel-before-submit-key"),
          expectedThreadVersion: ThreadVersion.make("5"),
          target: {
            _tag: "Command",
            commandId: CommandId.make("submit-cancelled"),
          },
        },
      })
      expect(cancellationFirst).toMatchObject([{ payload: { _tag: "CommandAdmitted", threadVersion: "6" } }])
      expect(
        yield* first.receive({
          protocolVersion,
          requestId: RequestId.make("request-submit-after-cancel"),
          command: {
            _tag: "SubmitPrompt",
            threadId,
            commandId: CommandId.make("submit-cancelled"),
            idempotencyKey: IdempotencyKey.make("submit-cancelled-key"),
            expectedThreadVersion: ThreadVersion.make("6"),
            text: "must not create a Turn",
          },
        }),
      ).toMatchObject([{ payload: { _tag: "CommandAdmitted", threadVersion: "7" } }])
      expect(admittedRuns.some((run) => run.operationKey === "submit-cancelled")).toBe(false)
      expect(applied).toEqual([])
    }),
  )
})

it.effect("admits authorization decisions without applying them in the socket session", () => {
  const store = memoryStore()
  const decisions: Array<Parameters<typeof testToolPolicy.recordDecision>[0]> = []
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
        operation: "rika.tool.processes.start",
        capability: "terminal.execute",
        input: '{"exact":"request"}',
        inputTruncated: false,
        checkpoint,
      },
    ],
  }
  const delivered: Array<InteractiveCommand> = []
  const product: HostedProductService = {
    ready: Effect.void,
    projects: () => Effect.succeed([]),
    createProject: () => Effect.die("unused"),
    activatePrincipal: () => Effect.void,
    createConnection: () => Effect.die("unused"),
    authorizeThread: () => Effect.succeed({ ownerId, actor }),
    threadExecutionContext: () =>
      Effect.succeed({
        repository: {
          identity: "In-Time-Tec/rika",
          branch: "feature/thread-controls",
        },
        branch: "feature/thread-controls",
        executor: { assignmentId, kind: "orb", generation: "7" },
      }),
    registerRunner: () => Effect.die("unused"),
    setRemoteThreadCreation: () => Effect.die("unused"),
    pollRunner: () => Effect.die("unused"),
    admitRun: () => Effect.die("unused"),
    admitAuthorizedRun: () => Effect.die("unused"),
    cancelRunAdmission: () => Effect.die("unused"),
    cancelAuthorizedRunAdmission: () => Effect.die("unused"),
  }
  const operations: HostedThreadApplicationService = {
    thread: () => Effect.succeed(currentSnapshot.view.thread),
    interactive: (input, persist) =>
      Effect.suspend(() => {
        delivered.push(input.command)
        currentSnapshot = { ...currentSnapshot, pendingAuthorizations: [] }
        return persist({ events: [], snapshot: currentSnapshot })
      }),
    snapshot: () => Effect.succeed(currentSnapshot),
  }

  const dependencies = Layer.mergeAll(
    Layer.succeed(HostedProduct, product),
    Layer.succeed(HostedThreadApplication, operations),
    Layer.succeed(
      HostedWorkspace,
      HostedWorkspace.of({
        execute: () => Effect.die("unused"),
        pause: () => Effect.void,
        resume: () => Effect.void,
        portal: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(ThreadProtocolStore, store),
    hostedStoreLayer,
    Layer.succeed(HostedToolPolicy, {
      ...testToolPolicy,
      recordDecision: (input) => Effect.sync(() => void decisions.push(input)),
    }),
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
        protocolVersion,
        requestId: RequestId.make("attach-authorization"),
        command: {
          _tag: "AttachThread",
          threadId,
          afterCursor: ThreadEventCursor.make("0"),
        },
      })
      expect(attached).toMatchObject([
        {
          payload: {
            _tag: "ThreadAttached",
            snapshot: currentSnapshot,
            events: [],
            participants: [],
          },
        },
      ])

      const approve = {
        protocolVersion,
        requestId: RequestId.make("approve-request"),
        command: {
          _tag: "Approve" as const,
          threadId,
          commandId: CommandId.make("approve-command"),
          idempotencyKey: IdempotencyKey.make("approve-key"),
          expectedThreadVersion: ThreadVersion.make("0"),
          turnId: TurnId.make("turn-authorization"),
          authorizationId: "authorization-1",
          checkpoint,
        },
      }
      expect(yield* session.receive(approve)).toMatchObject([
        { payload: { _tag: "CommandAdmitted", threadVersion: "1" } },
      ])
      expect(yield* session.receive(approve)).toMatchObject([
        { payload: { _tag: "CommandAdmitted", threadVersion: "1" } },
      ])
      expect(delivered).toEqual([])
      expect(store.command("approve-command")?.result).toBeUndefined()
      expect(decisions).toEqual([])
      const repaired = yield* protocol.connect("ticket-repaired", "/api/v1/threads/socket")
      expect(
        yield* repaired.receive({
          protocolVersion,
          requestId: RequestId.make("attach-repaired"),
          command: {
            _tag: "AttachThread",
            threadId,
            afterCursor: ThreadEventCursor.make("0"),
          },
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "ThreadAttached",
            threadVersion: "1",
            cursor: "0",
            snapshotThreadVersion: "1",
            snapshotCursor: "0",
            snapshot: currentSnapshot,
            events: [],
          },
        },
      ])

      expect(
        yield* session.receive({
          protocolVersion,
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
            _tag: "CommandAdmitted",
            threadVersion: "2",
          },
        },
      ])
      expect(delivered).toHaveLength(0)

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
          protocolVersion,
          requestId: RequestId.make("deny-request"),
          command: {
            _tag: "Deny",
            threadId,
            commandId: CommandId.make("deny-command"),
            idempotencyKey: IdempotencyKey.make("deny-key"),
            expectedThreadVersion: ThreadVersion.make("2"),
            turnId: TurnId.make("turn-denial"),
            authorizationId: "authorization-2",
            checkpoint: denialCheckpoint,
          },
        }),
      ).toMatchObject([{ payload: { _tag: "CommandAdmitted", threadVersion: "3" } }])
      expect(delivered).toHaveLength(0)
      expect(store.command("deny-command")?.result).toBeUndefined()
    }),
  )
})

it.effect("labels outbound snapshots with durable cursors and resets compacted gaps", () => {
  const store = memoryStore()
  let currentSnapshot: HostedThreadSnapshot = snapshot
  const product: HostedProductService = {
    ready: Effect.void,
    projects: () => Effect.succeed([]),
    createProject: () => Effect.die("unused"),
    activatePrincipal: () => Effect.void,
    createConnection: () => Effect.die("unused"),
    authorizeThread: () => Effect.succeed({ ownerId, actor }),
    threadExecutionContext: () => Effect.die("unused"),
    registerRunner: () => Effect.die("unused"),
    setRemoteThreadCreation: () => Effect.die("unused"),
    pollRunner: () => Effect.die("unused"),
    admitRun: () => Effect.die("unused"),
    admitAuthorizedRun: () => Effect.die("unused"),
    cancelRunAdmission: () => Effect.die("unused"),
    cancelAuthorizedRunAdmission: () => Effect.die("unused"),
  }
  const operations: HostedThreadApplicationService = {
    thread: () => Effect.succeed(currentSnapshot.view.thread),
    interactive: () => Effect.die("unused"),
    snapshot: () => Effect.succeed(currentSnapshot),
  }
  const dependencies = Layer.mergeAll(
    Layer.succeed(HostedProduct, product),
    Layer.succeed(HostedThreadApplication, operations),
    Layer.succeed(
      HostedWorkspace,
      HostedWorkspace.of({
        execute: () => Effect.die("unused"),
        pause: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        portal: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(ThreadProtocolStore, store),
    hostedStoreLayer,
    Layer.succeed(HostedToolPolicy, testToolPolicy),
    BunCrypto.layer,
  )
  const snapshotWithTitle = (title: string): HostedThreadSnapshot => ({
    ...snapshot,
    view: { ...snapshot.view, thread: { ...snapshot.view.thread, title } },
  })
  const notifications = makeThreadProtocolNotifications()
  const pollOutbound = (connection: Pick<HostedThreadConnection, "outbound">) =>
    Effect.gen(function* () {
      const polling = yield* Effect.forkChild(connection.outbound, {
        startImmediately: true,
      })
      notifications.recover()
      return yield* Fiber.join(polling)
    })

  return Effect.scoped(
    Effect.gen(function* () {
      yield* store.saveSnapshot({
        ownerId,
        threadId,
        threadVersion: ThreadVersion.make("0"),
        cursor: ThreadEventCursor.make("0"),
        snapshot,
        createdAt: timestamp,
      })
      const protocol = Context.get(
        yield* Layer.build(hostedThreadProtocolLayerWithOptions({ notifications }).pipe(Layer.provide(dependencies))),
        HostedThreadProtocol,
      )
      const connection = yield* protocol.connect("ticket", "/api/v1/threads/socket")
      yield* connection.receive({
        protocolVersion,
        requestId: RequestId.make("attach-snapshot-race"),
        command: {
          _tag: "AttachThread",
          threadId,
          afterCursor: ThreadEventCursor.make("0"),
        },
      })

      currentSnapshot = snapshotWithTitle("Materialized ahead")
      const durableAhead = snapshotWithTitle("Durable one")
      yield* store.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        snapshot: durableAhead,
        createdAt: timestamp,
      })
      expect(yield* pollOutbound(connection)).toMatchObject([
        { payload: { _tag: "ThreadEvent", event: { cursor: "1" } } },
        {
          payload: {
            _tag: "ThreadSnapshot",
            cursor: "1",
            threadVersion: "0",
            snapshot: currentSnapshot,
          },
        },
      ])

      currentSnapshot = snapshotWithTitle("Materialized behind")
      const durableBehind = snapshotWithTitle("Durable two")
      yield* store.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        snapshot: durableBehind,
        createdAt: timestamp,
      })
      expect(yield* pollOutbound(connection)).toMatchObject([
        { payload: { _tag: "ThreadEvent", event: { cursor: "2" } } },
        {
          payload: {
            _tag: "ThreadSnapshot",
            cursor: "2",
            threadVersion: "0",
            snapshot: currentSnapshot,
          },
        },
      ])

      currentSnapshot = snapshotWithTitle("Materialized after compaction")
      const durableCompacted = snapshotWithTitle("Durable compacted")
      yield* store.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        snapshot: durableCompacted,
        createdAt: timestamp,
      })
      store.dropEventsThrough("3")
      expect(yield* pollOutbound(connection)).toMatchObject([
        {
          payload: {
            _tag: "ThreadSnapshot",
            cursor: "3",
            threadVersion: "0",
            snapshot: currentSnapshot,
          },
        },
      ])

      currentSnapshot = snapshotWithTitle("Projection at the same cursor")
      const savesBeforeProjection = store.snapshotSaves()
      expect(yield* pollOutbound(connection)).toMatchObject([
        {
          payload: {
            _tag: "ThreadSnapshot",
            cursor: "3",
            threadVersion: "0",
            snapshot: currentSnapshot,
          },
        },
      ])
      expect(store.snapshotSaves()).toBe(savesBeforeProjection + 1)
      expect(yield* pollOutbound(connection)).toEqual([])
      expect(store.snapshotSaves()).toBe(savesBeforeProjection + 1)
    }),
  )
})
