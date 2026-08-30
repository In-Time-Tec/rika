import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect } from "@effect/vitest"
import * as ExecutionProjection from "@rika/product/execution-projection"
import {
  CommandId,
  IdempotencyKey,
  RequestId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
} from "@rika/product/hosted-model"
import { protocolVersion, type HostedThreadSnapshot } from "@rika/product/client-protocol"
import type { InteractiveCommand } from "@rika/product/interactive-command"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { TurnId } from "@rika/product/turn-record"
import { drizzle } from "drizzle-orm/node-postgres"
import { Context, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { HostedThreadApplication } from "../../../src/hosted/thread/application"
import { layer as hostedThreadCommandWorkerLayer } from "../../../src/hosted/thread/command-worker"
import { HostedProduct, type HostedProductService } from "../../../src/hosted/product"
import {
  HostedThreadProtocol,
  layer as hostedThreadProtocolLayer,
  threadWebSocketAudience,
} from "../../../src/hosted/thread/protocol"
import { HostedToolPolicy } from "../../../src/hosted/execution/tool-policy"
import { HostedWorkspace } from "../../../src/hosted/environment/workspace"
import { layerTest as hostedWorkerRuntimeLayerTest } from "../../../src/hosted/worker-runtime"
import { testToolPolicy } from "../execution/tool-policy.fixture"
import { attachedPayload, completeMockPrompt } from "./protocol/commands.harness"
import { setup } from "./protocol/database.harness"
import { fakeApplication, fakeProduct, fakeWorkspace } from "./protocol/fakes.harness"
import {
  actor,
  assignmentId,
  clientId,
  deviceId,
  later,
  ownerId,
  snapshot,
  threadId,
  userId,
} from "./protocol/values.harness"

import type { Pool } from "pg"

export interface ConvergenceState {
  currentSnapshot: HostedThreadSnapshot
}

export const setupConvergence = (pool: Pool) =>
  Effect.gen(function* () {
    const protocolStore = yield* setup(pool)
    const db = drizzle({ client: pool })
    const checkpoint = {
      version: ExecutionProjection.projectionVersion,
      cursor: "authorization-cursor",
      state: '{"operation":"shell","arguments":"bun test"}',
    }
    const state: ConvergenceState = { currentSnapshot: snapshot }
    const effects: Array<InteractiveCommand> = []
    const runs: Array<Pick<Parameters<HostedProductService["admitRun"]>[0], "threadId" | "operationKey" | "prompt">> =
      []
    const product = fakeProduct({
      projects: () => Effect.succeed([]),
      activatePrincipal: () => Effect.void,
      authorizeThread: () => Effect.succeed({ ownerId, actor }),
      threadExecutionContext: () =>
        Effect.succeed({
          workspaceId: "workspace-protocol",
          repository: {
            repositoryId: "repository-1",
            owner: "In-Time-Tec",
            name: "rika",
            branch: "feature/thread-controls",
          },
          branch: "feature/thread-controls",
          executor: {
            assignmentId,
            kind: "orb",
            generation: "7",
            lifecycle: "active",
            executorInstanceId: "executor-1",
          },
        }),
      admitRun: (input) =>
        Effect.sync(() => {
          if (!runs.some((run) => run.operationKey === input.operationKey)) runs.push(input)
          return {
            _tag: "Admitted" as const,
            commandId: input.operationKey,
            turnId: `turn-${input.operationKey}`,
            status: "queued" as const,
          }
        }),
      admitAuthorizedRun: (input) =>
        Effect.sync(() => {
          if (!runs.some((run) => run.operationKey === input.operationKey))
            runs.push({ threadId: input.threadId, operationKey: input.operationKey, prompt: input.prompt })
        }).pipe(Effect.andThen(completeMockPrompt(protocolStore, input, "queued", state.currentSnapshot))),
    })
    const operations = fakeApplication({
      thread: () => Effect.succeed(state.currentSnapshot.view.thread),
      snapshot: () => Effect.succeed(state.currentSnapshot),
      interactive: (input, persist) =>
        Effect.suspend(() => {
          effects.push(input.command)
          if (input.command._tag === "ApproveAuthorization" || input.command._tag === "DenyAuthorization") {
            state.currentSnapshot = {
              ...state.currentSnapshot,
              pendingAuthorizations: [],
            }
            return persist({ events: [], snapshot: state.currentSnapshot })
          }
          return persist({
            events: [
              {
                _tag: "ExecutionControlled" as const,
                action: "cancelled" as const,
              },
            ],
            snapshot: state.currentSnapshot,
          })
        }),
    })
    const dependencies = Layer.mergeAll(
      Layer.succeed(HostedProduct, product),
      Layer.succeed(HostedThreadApplication, operations),
      Layer.succeed(HostedWorkspace, fakeWorkspace(Effect.void, Effect.void)),
      Layer.succeed(ThreadProtocolStore, protocolStore),
      Layer.succeed(HostedToolPolicy, testToolPolicy),
      BunCrypto.layer,
    )
    yield* Layer.build(
      hostedThreadCommandWorkerLayer({
        claimMillis: 10_000,
        fallbackIntervalMillis: 250,
        concurrency: 8,
      }).pipe(Layer.provide(hostedWorkerRuntimeLayerTest), Layer.provide(dependencies)),
    )
    const protocols = yield* Effect.all(
      [
        Layer.build(hostedThreadProtocolLayer.pipe(Layer.provide(dependencies))),
        Layer.build(hostedThreadProtocolLayer.pipe(Layer.provide(dependencies))),
      ].map((builtLayer) => builtLayer.pipe(Effect.map((context) => Context.get(context, HostedThreadProtocol)))),
      { concurrency: "unbounded" },
    )
    const protocolA = protocols[0]!
    const protocolB = protocols[1]!
    const principal = { userId, clientId, deviceId }
    const open = (protocol: HostedThreadProtocol["Service"]) =>
      Effect.gen(function* () {
        const ticket = yield* protocol.issueTicket(principal)
        return yield* protocol.connect(ticket.ticket, threadWebSocketAudience)
      })
    const [controllerA, controllerB] = yield* Effect.all([open(protocolA), open(protocolB)], {
      concurrency: "unbounded",
    })
    const awaitCompletion = Effect.fn("ThreadProtocolStoreLiveTest.awaitCompletion")(function* (
      session: typeof controllerA,
      message: Parameters<typeof controllerA.receive>[0],
    ) {
      let response = yield* session.receive(message)
      for (let attempt = 0; attempt < 40 && response[0]?.payload._tag === "CommandAdmitted"; attempt += 1) {
        yield* TestClock.adjust("250 millis")
        yield* Effect.yieldNow
        response = yield* session.receive({
          ...message,
          requestId: RequestId.make(`${message.requestId}:${attempt}`),
        })
      }
      return response
    })
    for (const [session, requestId] of [
      [controllerA, "attach-a"],
      [controllerB, "attach-b"],
    ] as const)
      expect(
        yield* session.receive({
          protocolVersion,
          requestId: RequestId.make(requestId),
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
            threadVersion: "0",
            cursor: "0",
            events: [],
            participants: [{ status: "viewing" }],
          },
        },
      ])

    const duplicate = {
      protocolVersion,
      requestId: RequestId.make("duplicate-a"),
      command: {
        _tag: "SubmitPrompt" as const,
        threadId,
        commandId: CommandId.make("duplicate-submit"),
        idempotencyKey: IdempotencyKey.make("duplicate-submit-key"),
        expectedThreadVersion: ThreadVersion.make("0"),
        text: "queue once",
      },
    }
    const duplicateResponses = yield* Effect.all(
      [
        controllerA.receive(duplicate),
        controllerB.receive({
          ...duplicate,
          requestId: RequestId.make("duplicate-b"),
        }),
      ],
      { concurrency: "unbounded" },
    )
    expect(
      duplicateResponses
        .flat()
        .filter((frame) => frame.payload._tag === "CommandAdmitted" || frame.payload._tag === "CommandRejected"),
    ).toHaveLength(2)
    expect(yield* awaitCompletion(controllerA, duplicate)).toMatchObject([
      {
        payload: {
          _tag: "CommandAccepted",
          threadVersion: "1",
          cursor: "1",
        },
      },
    ])
    expect(runs.filter((input) => input.operationKey === "duplicate-submit")).toHaveLength(1)
    expect(
      yield* controllerA.receive({
        ...duplicate,
        requestId: RequestId.make("duplicate-after-completion"),
      }),
    ).toMatchObject([
      {
        payload: {
          _tag: "CommandAccepted",
          threadVersion: "1",
          cursor: "1",
        },
      },
    ])
    expect(
      yield* controllerA.receive({
        ...duplicate,
        requestId: RequestId.make("duplicate-payload-mismatch"),
        command: { ...duplicate.command, text: "changed payload" },
      }),
    ).toMatchObject([{ payload: { _tag: "CommandRejected", reason: "conflict" } }])
    expect(effects).toHaveLength(0)

    const contender = (id: string, requestId: string) => ({
      protocolVersion,
      requestId: RequestId.make(requestId),
      command: {
        _tag: "SubmitPrompt" as const,
        threadId,
        commandId: CommandId.make(id),
        idempotencyKey: IdempotencyKey.make(`${id}-key`),
        expectedThreadVersion: ThreadVersion.make("1"),
        text: id,
      },
    })
    const contenders = [
      contender("controller-a", "controller-a-request"),
      contender("controller-b", "controller-b-request"),
    ]
    const raced = yield* Effect.all([controllerA.receive(contenders[0]!), controllerB.receive(contenders[1]!)], {
      concurrency: "unbounded",
    })
    const racedPayloads = raced.flat().map((frame) => frame.payload)
    expect(racedPayloads.filter((payload) => payload._tag === "CommandAdmitted")).toHaveLength(1)
    const stale = racedPayloads.find((payload) => payload._tag === "CommandRejected")
    expect(stale).toMatchObject({
      _tag: "CommandRejected",
      reason: "stale-version",
      currentThreadVersion: "2",
    })
    expect(["1", "2"]).toContain(stale?.currentCursor)
    const staleIndex = stale?.requestId === "controller-a-request" ? 0 : 1
    const delayed = contenders[staleIndex]!
    const delayedSession = staleIndex === 0 ? controllerA : controllerB
    expect(
      yield* awaitCompletion(delayedSession, {
        ...delayed,
        requestId: RequestId.make("delayed-resync"),
        command: {
          ...delayed.command,
          expectedThreadVersion: ThreadVersion.make("2"),
        },
      }),
    ).toMatchObject([
      {
        payload: {
          _tag: "CommandAccepted",
          threadVersion: "3",
          cursor: "3",
        },
      },
    ])
    expect(
      runs.filter((input) => input.operationKey === "controller-a" || input.operationKey === "controller-b"),
    ).toHaveLength(2)

    state.currentSnapshot = {
      ...state.currentSnapshot,
      pendingAuthorizations: [
        {
          threadId,
          turnId: TurnId.make("approval-turn"),
          authorizationId: "authorization-1",
          operation: "shell",
          capability: "process",
          input: "bun test",
          inputTruncated: false,
          checkpoint,
        },
      ],
    }
    yield* protocolStore.checkpoint({
      ownerId,
      threadId,
      threadVersion: ThreadVersion.make("3"),
      cursor: ThreadEventCursor.make("3"),
      snapshot: state.currentSnapshot,
      createdAt: later,
    })
    const approvalController = yield* open(protocolA)
    const approvalAttachment = yield* approvalController.receive({
      protocolVersion,
      requestId: RequestId.make("approval-attach"),
      command: {
        _tag: "AttachThread",
        threadId,
        afterCursor: ThreadEventCursor.make("3"),
      },
    })
    expect(approvalAttachment).toMatchObject([
      {
        payload: {
          _tag: "ThreadAttached",
          threadVersion: "3",
          cursor: "3",
          checkpoint: {
            cursor: "3",
            snapshot: {
              pendingAuthorizations: [
                {
                  authorizationId: "authorization-1",
                  turnId: "approval-turn",
                },
              ],
            },
          },
          events: [],
        },
      },
    ])
    const attached = attachedPayload(approvalAttachment[0])
    expect(attached._tag).toBe("ThreadAttached")
    expect(Array.isArray(attached.participants)).toBe(true)
    const approval = {
      protocolVersion,
      requestId: RequestId.make("approval-request"),
      command: {
        _tag: "Approve" as const,
        threadId,
        commandId: CommandId.make("approval-command"),
        idempotencyKey: IdempotencyKey.make("approval-key"),
        expectedThreadVersion: ThreadVersion.make("3"),
        turnId: TurnId.make("approval-turn"),
        authorizationId: "authorization-1",
        checkpoint,
      },
    }
    expect(yield* awaitCompletion(approvalController, approval)).toMatchObject([
      {
        payload: {
          _tag: "CommandAccepted",
          threadVersion: "4",
          result: { _tag: "Applied" },
        },
      },
    ])
    expect(
      yield* approvalController.receive({
        ...approval,
        requestId: RequestId.make("approval-retry"),
      }),
    ).toMatchObject([{ payload: { _tag: "CommandAccepted", threadVersion: "4" } }])
    expect(
      effects.filter((input) => input._tag === "ApproveAuthorization" && input.authorizationId === "authorization-1"),
    ).toHaveLength(1)

    state.currentSnapshot = {
      ...state.currentSnapshot,
      pendingAuthorizations: [
        {
          threadId: ThreadId.make("cross-thread"),
          turnId: approval.command.turnId,
          authorizationId: approval.command.authorizationId,
          operation: "shell",
          capability: "process",
          input: "bun test",
          inputTruncated: false,
          checkpoint,
        },
      ],
    }
    expect(
      yield* awaitCompletion(approvalController, {
        ...approval,
        requestId: RequestId.make("cross-thread-approval"),
        command: {
          ...approval.command,
          commandId: CommandId.make("cross-thread-approval"),
          idempotencyKey: IdempotencyKey.make("cross-thread-approval-key"),
          expectedThreadVersion: ThreadVersion.make("4"),
        },
      }),
    ).toMatchObject([{ payload: { _tag: "CommandRejected", reason: "conflict" } }])
    expect(effects.filter((input) => input._tag === "ApproveAuthorization")).toHaveLength(1)

    return {
      approvalController,
      awaitCompletion,
      checkpoint,
      controllerA,
      controllerB,
      db,
      effects,
      open,
      protocolB,
      protocolStore,
      state,
    }
  })
