import "./harness"
import { expect, it } from "@effect/vitest"
import { makeSessionFixture } from "./session.fixture"
import { Context, Effect, Fiber, Layer } from "effect"
import * as ExecutionProjection from "@rika/product/execution-projection"
import {
  CommandId,
  IdempotencyKey,
  RequestId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
} from "@rika/product/hosted-model"
import { protocolVersion } from "@rika/product/client-protocol"
import { TurnId } from "@rika/product/turn-record"
import { CheckoutFingerprint } from "@rika/product/runner-registration"
import {
  HostedThreadProtocol,
  layerWithOptions as hostedThreadProtocolLayerWithOptions,
} from "../../../../src/hosted/thread/protocol"
import { makeHostedPreviewBus } from "../../../../src/hosted/thread/previews"

import { deviceId, ownerId, snapshot, threadId, timestamp } from "./memory.fixture"

const firstPayload = <A>(messages: ReadonlyArray<{ readonly payload: A }>) => messages[0]?.payload

it.effect("derives personal authority, admits a retried submission once, and resyncs stale controllers", () => {
  const {
    store,
    notifications,
    applied,
    admittedRuns,
    authorizedActions,
    workspaceRequests,
    workspaceLifecycle,
    dependencies,
    selectedOwner,
    archiveThreadId,
  } = makeSessionFixture()
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
      expect(firstPayload(created)).toMatchObject({
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
      expect(selectedOwner()).toEqual({
        _tag: "PersonalOwner",
        userId: "user-1",
      })
      expect(archiveThreadId()).toBe("source-thread")
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
      expect(admittedRuns.map((run) => run.operationKey)).not.toContain("submit-cancelled")
      expect(applied).toEqual([])
    }),
  )
})
