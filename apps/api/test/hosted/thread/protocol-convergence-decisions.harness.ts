import { expect } from "@effect/vitest"
import { CommandId, IdempotencyKey, RequestId, ThreadEventCursor, ThreadVersion } from "@rika/product/hosted-model"
import { protocolVersion } from "@rika/product/client-protocol"
import { TurnId } from "@rika/product/turn-record"
import {
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolSnapshots,
} from "@rika/product-store/database-schema"
import { and, eq, gt } from "drizzle-orm"
import { Effect } from "effect"
import { attachedPayload } from "./protocol/commands.harness"
import { actor, later, ownerId, threadId } from "./protocol/values.harness"

import { setupConvergence } from "./protocol-convergence-setup.harness"

type ConvergenceContext = Effect.Success<ReturnType<typeof setupConvergence>>

export const continueConvergence = Effect.fn("ProtocolTest.continueConvergence")(function* (
  context: ConvergenceContext,
) {
  const {
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
  } = context
  const denialCheckpoint = { ...checkpoint, cursor: "denial-cursor" }
  state.currentSnapshot = {
    ...state.currentSnapshot,
    pendingAuthorizations: [
      {
        threadId,
        turnId: TurnId.make("denial-turn"),
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
    yield* awaitCompletion(approvalController, {
      protocolVersion,
      requestId: RequestId.make("denial-request"),
      command: {
        _tag: "Deny",
        threadId,
        commandId: CommandId.make("denial-command"),
        idempotencyKey: IdempotencyKey.make("denial-key"),
        expectedThreadVersion: ThreadVersion.make("5"),
        turnId: TurnId.make("denial-turn"),
        authorizationId: "authorization-2",
        checkpoint: denialCheckpoint,
      },
    }),
  ).toMatchObject([{ payload: { _tag: "CommandAccepted", threadVersion: "6" } }])
  expect(
    effects.filter((input) => input._tag === "DenyAuthorization" && input.authorizationId === "authorization-2"),
  ).toHaveLength(1)

  const audit = yield* Effect.tryPromise(() =>
    db
      .select({
        actor: rikaHostedThreadProtocolCommands.actor,
        command: rikaHostedThreadProtocolCommands.command,
        result: rikaHostedThreadProtocolCommands.result,
      })
      .from(rikaHostedThreadProtocolCommands)
      .where(eq(rikaHostedThreadProtocolCommands.commandId, "approval-command")),
  )
  expect(audit).toMatchObject([
    {
      actor,
      command: {
        _tag: "Approve",
        turnId: "approval-turn",
        authorizationId: "authorization-1",
        checkpoint,
      },
      result: { _tag: "Applied" },
    },
  ])
  const denialAudit = yield* Effect.tryPromise(() =>
    db
      .select({ result: rikaHostedThreadProtocolCommands.result })
      .from(rikaHostedThreadProtocolCommands)
      .where(eq(rikaHostedThreadProtocolCommands.commandId, "denial-command")),
  )
  expect(denialAudit).toMatchObject([
    {
      result: { _tag: "Applied" },
    },
  ])

  yield* protocolStore.saveSnapshot({
    ownerId,
    threadId,
    threadVersion: ThreadVersion.make("6"),
    cursor: ThreadEventCursor.make("3"),
    snapshot: state.currentSnapshot,
    createdAt: later,
  })
  const replayCommandId = CommandId.make("cursor-replay-command")
  const replayIdempotencyKey = IdempotencyKey.make("cursor-replay-key")
  yield* protocolStore.admitCommand({
    ownerId,
    threadId,
    actor,
    commandId: replayCommandId,
    turnId: TurnId.make("turn-cursor-replay-command"),
    idempotencyKey: replayIdempotencyKey,
    expectedThreadVersion: ThreadVersion.make("6"),
    command: {
      _tag: "SubmitPrompt",
      threadId,
      commandId: replayCommandId,
      idempotencyKey: replayIdempotencyKey,
      expectedThreadVersion: "6",
      text: "exercise cursor replay",
    },
    admittedAt: later,
  })
  const replayClaimToken = "cursor-replay-claim"
  expect(
    yield* protocolStore.claimNextCommand({
      claimToken: replayClaimToken,
      claimMillis: 60_000,
    }),
  ).toMatchObject({ commandId: replayCommandId })
  yield* protocolStore.completeCommand({
    ownerId,
    threadId,
    commandId: replayCommandId,
    claimToken: replayClaimToken,
    result: { _tag: "PromptAdmitted", status: "accepted" },
    events: Array.from({ length: 1_002 }, () => ({
      _tag: "ExecutionControlled" as const,
      action: "cancelled" as const,
    })),
    completedAt: later,
  })
  yield* Effect.tryPromise(() =>
    db
      .delete(rikaHostedThreadProtocolSnapshots)
      .where(
        and(eq(rikaHostedThreadProtocolSnapshots.threadId, threadId), gt(rikaHostedThreadProtocolSnapshots.cursor, 3)),
      ),
  )
  const replayController = yield* open(protocolB)
  const replay = yield* replayController.receive({
    protocolVersion,
    requestId: RequestId.make("replay-attach"),
    command: {
      _tag: "AttachThread",
      threadId,
      afterCursor: ThreadEventCursor.make("0"),
    },
  })
  expect(replay).toHaveLength(1)
  const attachedReplay = attachedPayload(replay[0])
  expect(attachedReplay).toMatchObject({
    _tag: "ThreadAttached",
    baseCursor: "3",
    checkpoint: { cursor: "3" },
    threadVersion: "7",
    cursor: "1005",
  })
  expect(Array.isArray(attachedReplay.participants)).toBe(true)
  expect(attachedReplay.events).toHaveLength(1_002)
  expect(attachedReplay.events[0]?.cursor).toBe("4")
  expect(attachedReplay.events.at(-1)?.cursor).toBe("1005")
  expect(
    (yield* replayController.receive({
      protocolVersion,
      requestId: RequestId.make("large-replay-ack"),
      command: {
        _tag: "AcknowledgeCursor",
        threadId,
        cursor: ThreadEventCursor.make("1005"),
      },
    }))[0]?.payload,
  ).toMatchObject({ _tag: "CommandAccepted", cursor: "1005" })

  yield* protocolStore.appendEvents({
    ownerId,
    threadId,
    events: [{ _tag: "ExecutionControlled", action: "cancelled" }],
    createdAt: later,
  })
  yield* Effect.tryPromise(() =>
    db
      .delete(rikaHostedThreadProtocolSnapshots)
      .where(
        and(eq(rikaHostedThreadProtocolSnapshots.threadId, threadId), gt(rikaHostedThreadProtocolSnapshots.cursor, 3)),
      ),
  )
  const appendOnlyReplay = yield* replayController.receive({
    protocolVersion,
    requestId: RequestId.make("append-only-replay"),
    command: {
      _tag: "AttachThread",
      threadId,
      afterCursor: ThreadEventCursor.make("1005"),
    },
  })
  expect(appendOnlyReplay).toHaveLength(1)
  const appendOnlyAttachment = attachedPayload(appendOnlyReplay[0])
  expect(appendOnlyAttachment).toMatchObject({
    _tag: "ThreadAttached",
    baseCursor: "1005",
    cursor: "1006",
    events: [{ cursor: "1006" }],
  })

  const duplicateControl = {
    protocolVersion,
    requestId: RequestId.make("duplicate-control-a"),
    command: {
      _tag: "Cancel" as const,
      threadId,
      commandId: CommandId.make("duplicate-control"),
      idempotencyKey: IdempotencyKey.make("duplicate-control-key"),
      expectedThreadVersion: ThreadVersion.make("7"),
      target: {
        _tag: "Turn" as const,
        turnId: TurnId.make("denial-turn"),
      },
    },
  }
  const duplicateControlResponses = yield* Effect.all(
    [
      controllerA.receive(duplicateControl),
      controllerB.receive({
        ...duplicateControl,
        requestId: RequestId.make("duplicate-control-b"),
      }),
    ],
    { concurrency: "unbounded" },
  )
  const duplicateControlFrames = duplicateControlResponses.flat()
  expect(duplicateControlFrames.filter((frame) => frame.payload._tag === "CommandAdmitted")).toHaveLength(2)
  expect(yield* awaitCompletion(controllerA, duplicateControl)).toMatchObject([
    { payload: { _tag: "CommandAccepted", threadVersion: "8" } },
  ])

  const durableInteractiveCommands = [
    {
      _tag: "EditQueued" as const,
      commandId: CommandId.make("edit-queued-command"),
      idempotencyKey: IdempotencyKey.make("edit-queued-key"),
      expectedThreadVersion: ThreadVersion.make("8"),
      turnId: TurnId.make("queued-turn"),
      prompt: "rewritten prompt",
    },
    {
      _tag: "Dequeue" as const,
      commandId: CommandId.make("dequeue-command"),
      idempotencyKey: IdempotencyKey.make("dequeue-key"),
      expectedThreadVersion: ThreadVersion.make("9"),
      turnId: TurnId.make("queued-turn"),
    },
    {
      _tag: "ArchiveThread" as const,
      commandId: CommandId.make("archive-command"),
      idempotencyKey: IdempotencyKey.make("archive-key"),
      expectedThreadVersion: ThreadVersion.make("10"),
    },
  ]
  for (const durableCommand of durableInteractiveCommands)
    expect(
      yield* awaitCompletion(controllerA, {
        protocolVersion,
        requestId: RequestId.make(`${durableCommand._tag}-request`),
        command: { ...durableCommand, threadId },
      }),
    ).toMatchObject([
      {
        payload: {
          _tag: "CommandAccepted",
          threadVersion: String(BigInt(durableCommand.expectedThreadVersion) + 1n),
          result: { _tag: "Applied" },
        },
      },
    ])
  expect(effects.slice(-3)).toMatchObject([
    { _tag: "EditQueued", turnId: "queued-turn", prompt: "rewritten prompt" },
    { _tag: "Dequeue", turnId: "queued-turn" },
    { _tag: "ArchiveThread" },
  ])
})
