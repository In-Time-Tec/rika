import "./protocol.harness"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Schema } from "effect"
import * as ExecutionProjection from "@rika/product/execution-projection"
import {
  BetterAuthUserId,
  ClientId,
  CommitCursor,
  CommandId,
  DeviceId,
  IdempotencyKey,
  OwnerId,
  RequestId,
  Sequence,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { HostedPresence } from "@rika/product/hosted-presence"
import type { AuthorizationAction } from "@rika/product/hosted-authorization"
import { PendingAuthorization, protocolVersion, type HostedThreadSnapshot } from "@rika/product/client-protocol"
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
import { makeHostedPreviewBus } from "../../../src/hosted/thread/previews"
import { HostedToolPolicy } from "../../../src/hosted/execution/tool-policy"
import { HostedWorkspace, HostedWorkspaceError } from "../../../src/hosted/environment/workspace"
import { testToolPolicy } from "../execution/tool-policy.fixture"

const timestamp = Timestamp.make("2026-08-21T00:00:00.000Z")
const pendingAuthorizationsEquivalent = Schema.toEquivalence(Schema.Array(PendingAuthorization))
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

const presenceLayer = Layer.succeed(HostedPresence, {
  upsert: (input) =>
    Effect.succeed({
      ownerId: input.ownerId,
      threadId: input.threadId,
      actor: input.actor,
      status: input.status,
      lastSeenAt: input.now,
      expiresAt: input.expiresAt,
    }),
  list: () => Effect.succeed([]),
})

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
  let latestSnapshotReplayRequired = false
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
      Effect.suspend((): Effect.Effect<CommandAdmission, HostedPersistenceError> => {
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
          return Effect.fail(HostedPersistenceError.make({ reason: "stale-version", message: "stale" }))
        version += 1n
        const admitted: ThreadProtocolCommand = {
          ...input,
          threadVersion: ThreadVersion.make(String(version)),
          sequence: Sequence.make(String(version)),
          commitCursor: CommitCursor.make(String(version)),
          state: "admitted",
        }
        commands.set(input.commandId, admitted)
        keys.set(input.idempotencyKey, input.commandId)
        return Effect.succeed({ _tag: "Admitted" as const, command: admitted })
      }),
    admitServerCommand: () => Effect.die("unused"),
    applyPrompt: () => Effect.die("unused"),
    cancelPrompt: () => Effect.die("unused"),
    claimNextCommand: () => Effect.die("unused"),
    oldestRunnableCommandAt: Effect.map(Effect.void, (): number | undefined => undefined),
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
          const replayRequired =
            latestSnapshot !== undefined &&
            !pendingAuthorizationsEquivalent(latestSnapshot.pendingAuthorizations, input.snapshot.pendingAuthorizations)
          latestSnapshot = input.snapshot
          latestSnapshotCursor = cursor
          latestSnapshotVersion = BigInt(admitted.threadVersion)
          latestSnapshotReplayRequired ||= replayRequired
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
        return written
      }),
    checkpoint: (input) =>
      Effect.sync(() => {
        latestSnapshot = input.snapshot
        latestSnapshotCursor = BigInt(input.cursor)
        latestSnapshotVersion = BigInt(input.threadVersion)
        latestSnapshotReplayRequired = true
        return true
      }),
    saveSnapshot: (input) =>
      Effect.sync(() => {
        snapshotSaves += 1
        latestSnapshot = input.snapshot
        latestSnapshotCursor = BigInt(input.cursor)
        latestSnapshotVersion = BigInt(input.threadVersion)
        latestSnapshotReplayRequired = false
      }),
    replay: (input) =>
      Effect.sync(() => {
        const targetCursor =
          input.throughCursor === undefined || BigInt(input.throughCursor) > cursor
            ? cursor
            : BigInt(input.throughCursor)
        const afterCursor = BigInt(input.afterCursor)
        const firstEvent = events.find(
          (event) => BigInt(event.cursor) > afterCursor && BigInt(event.cursor) <= targetCursor,
        )
        const directTail = afterCursor === targetCursor || BigInt(firstEvent?.cursor ?? "-1") === afterCursor + 1n
        const checkpointBehind = BigInt(input.afterCheckpointCursor ?? "-1") < latestSnapshotCursor
        const includeSnapshot =
          input.includeSnapshot !== false &&
          latestSnapshot !== undefined &&
          latestSnapshotCursor <= targetCursor &&
          (input.afterCursor === "0" || !directTail || (latestSnapshotReplayRequired && checkpointBehind))
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
          hasMore:
            events.filter((event) => BigInt(event.cursor) > replayCursor && BigInt(event.cursor) <= targetCursor)
              .length > input.limit,
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
      latestSnapshotReplayRequired = false
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
  let archiveThreadId: string | undefined
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
    authorizeOwner: () => Effect.die("unused"),
    authorizeThread: (_principal, _threadId, action) =>
      Effect.sync(() => {
        authorizedActions.push(action)
        return { ownerId, actor }
      }),
    threadExecutionContext: () =>
      Effect.succeed({
        workspaceId: "workspace-1",
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
            archiveThreadId = input.archiveThreadId
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
    threads: () => Effect.die("unused"),
    preview: () => Effect.die("unused"),
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
    presenceLayer,
    Layer.succeed(HostedToolPolicy, testToolPolicy),
    BunCrypto.layer,
  )
  return Effect.scoped(
    Effect.gen(function* () {
      const previews = yield* makeHostedPreviewBus()
      const protocol = Context.get(
        yield* Layer.build(
          hostedThreadProtocolLayerWithOptions({ notifications, previews: previews.bus }).pipe(
            Layer.provide(dependencies),
          ),
        ),
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
          archiveThreadId: ThreadId.make("source-thread"),
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
      expect(archiveThreadId).toBe("source-thread")
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
            baseCursor: "0",
            checkpoint: { threadVersion: "1", cursor: "0", snapshot },
            events: [],
          },
        },
      ])
      previews.bus.publish({
        threadId,
        turnId: TurnId.make("turn-preview"),
        preview: {
          _tag: "ModelPreview",
          runId: "run-preview",
          attemptFence: 1,
          turn: 0,
          modelCallId: "call-preview",
          modelAttemptId: "attempt-preview",
          attempt: 1,
          sequence: 0,
          changes: [{ channel: "text", offset: 0, delta: "Hello" }],
        },
      })
      expect(yield* first.outbound).toMatchObject([
        {
          protocolVersion,
          payload: {
            _tag: "ThreadPreview",
            threadId,
            turnId: "turn-preview",
            preview: {
              _tag: "ModelPreview",
              sequence: 0,
              changes: [{ channel: "text", offset: 0, delta: "Hello" }],
            },
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
            baseCursor: "0",
            checkpoint: { cursor: "0" },
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
      previews.bus.publish({
        threadId: ThreadId.make("thread-2"),
        turnId: TurnId.make("turn-ready-race"),
        preview: {
          _tag: "ModelPreview",
          runId: "run-ready-race",
          attemptFence: 1,
          turn: 0,
          modelCallId: "call-ready-race",
          modelAttemptId: "attempt-ready-race",
          attempt: 1,
          sequence: 0,
          changes: [{ channel: "text", offset: 0, delta: "preview" }],
        },
      })
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
      expect(yield* second.outbound).toMatchObject([
        { payload: { _tag: "ThreadPreview", threadId: "thread-2", turnId: "turn-ready-race" } },
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
    state: '{"operation":"shell","arguments":"bun test"}',
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
    authorizeOwner: () => Effect.die("unused"),
    authorizeThread: () => Effect.succeed({ ownerId, actor }),
    threadExecutionContext: () =>
      Effect.succeed({
        workspaceId: "workspace-1",
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
    threads: () => Effect.die("unused"),
    preview: () => Effect.die("unused"),
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
    presenceLayer,
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
            checkpoint: { snapshot: currentSnapshot },
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
            baseCursor: "0",
            checkpoint: { threadVersion: "0", cursor: "0", snapshot: currentSnapshot },
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

it.effect("streams a contiguous tail and resets compacted cursors from a durable checkpoint", () => {
  const store = memoryStore()
  let currentSnapshot: HostedThreadSnapshot = snapshot
  const product: HostedProductService = {
    ready: Effect.void,
    projects: () => Effect.succeed([]),
    createProject: () => Effect.die("unused"),
    activatePrincipal: () => Effect.void,
    createConnection: () => Effect.die("unused"),
    authorizeOwner: () => Effect.die("unused"),
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
    threads: () => Effect.die("unused"),
    preview: () => Effect.die("unused"),
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
    presenceLayer,
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

      const durableAhead = snapshotWithTitle("Durable one")
      const first = yield* store.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: timestamp,
      })
      expect(yield* pollOutbound(connection)).toMatchObject([
        { payload: { _tag: "ThreadEvent", event: { cursor: "1" } } },
      ])
      expect(store.snapshotSaves()).toBe(1)

      yield* store.checkpoint({
        ownerId,
        threadId,
        threadVersion: first[0]!.threadVersion,
        cursor: first[0]!.cursor,
        snapshot: durableAhead,
        createdAt: timestamp,
      })
      expect(yield* pollOutbound(connection)).toMatchObject([
        {
          payload: {
            _tag: "ThreadSnapshot",
            cursor: "1",
            threadVersion: "0",
            snapshot: durableAhead,
          },
        },
      ])

      const durableBehind = snapshotWithTitle("Durable two")
      const second = yield* store.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: timestamp,
      })
      expect(yield* pollOutbound(connection)).toMatchObject([
        { payload: { _tag: "ThreadEvent", event: { cursor: "2" } } },
      ])
      yield* store.checkpoint({
        ownerId,
        threadId,
        threadVersion: second[0]!.threadVersion,
        cursor: second[0]!.cursor,
        snapshot: durableBehind,
        createdAt: timestamp,
      })
      store.dropEventsThrough("2")
      yield* store.appendEvents({
        ownerId,
        threadId,
        events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
        createdAt: timestamp,
      })
      const compacted = yield* protocol.connect("ticket-compacted", "/api/v1/threads/socket")
      expect(
        yield* compacted.receive({
          protocolVersion,
          requestId: RequestId.make("attach-compacted"),
          command: {
            _tag: "AttachThread",
            threadId,
            afterCursor: ThreadEventCursor.make("1"),
            afterCheckpointCursor: ThreadEventCursor.make("1"),
          },
        }),
      ).toMatchObject([
        {
          payload: {
            _tag: "ThreadAttached",
            baseCursor: "2",
            cursor: "3",
            checkpoint: { cursor: "2", snapshot: durableBehind },
            events: [{ cursor: "3" }],
          },
        },
      ])

      const current = yield* protocol.connect("ticket-current", "/api/v1/threads/socket")
      expect(
        yield* current.receive({
          protocolVersion,
          requestId: RequestId.make("attach-current"),
          command: {
            _tag: "AttachThread",
            threadId,
            afterCursor: ThreadEventCursor.make("3"),
            afterCheckpointCursor: ThreadEventCursor.make("2"),
          },
        }),
      ).toMatchObject([{ payload: { _tag: "ThreadAttached", baseCursor: "3", cursor: "3", events: [] } }])
      expect(store.snapshotSaves()).toBe(1)
    }),
  )
})
