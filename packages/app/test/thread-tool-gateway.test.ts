import { describe, expect, it } from "@effect/vitest"
import * as ThreadInteractionRepository from "@rika/persistence/thread-interaction-repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Effect, Exit, Ref, Scope } from "effect"
import type { ThreadTools, ToolInvocation } from "@rika/tools"
import * as ThreadToolService from "../src/thread-tool-service"

const invocation: ToolInvocation.Value = {
  executionId: "execution",
  callId: "call",
  toolName: "create_thread",
  eventSequence: 1,
  createdAt: 1,
  idempotencyKeyDigest: "digest",
}

const input: typeof ThreadTools.CreateThreadInput.Type = { prompt: "Coordinate this work" }

const sourceThread: Thread.Thread = {
  id: Thread.ThreadId.make("source"),
  workspace: "/work",
  title: "Source",
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}

const sourceTurn: Turn.Turn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("source-turn"),
  threadId: sourceThread.id,
  prompt: "Coordinate",
  status: "running",
  stopIntent: "none",
  executionRoute: Turn.testExecutionRoute(),
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}

const authority: ExecutionBackend.InvocationSource = {
  rootTurnId: sourceTurn.id,
  threadId: sourceThread.id,
  callerProfile: "Root",
  threadCreationDepth: 0,
}

const serviceHarness = Effect.gen(function* () {
  const interactions = yield* ThreadInteractionRepository.makeMemory({ threads: [sourceThread], turns: [sourceTurn] })
  const turns = yield* TurnRepository.makeMemory([sourceTurn])
  const scheduled = yield* Ref.make<ReadonlyArray<string>>([])
  const controls = yield* Ref.make<ReadonlyArray<ReadonlyArray<unknown>>>([])
  const settled = yield* Ref.make<ReadonlyArray<Turn.Turn>>([])
  const identifiers = [
    "target",
    "target-turn",
    "duplicate-thread",
    "duplicate-turn",
    "conflict-thread",
    "conflict-turn",
    "queued-turn",
  ]
  const backend = ExecutionBackend.Service.of({
    invokeChild: (child) => Effect.succeed({ ...child, type: "accepted" }),
    createFanOut: () => Effect.die("unused"),
    inspectFanOut: () => Effect.die("unused"),
    cancelFanOut: () => Effect.die("unused"),
    registerWorkflows: () => Effect.die("unused"),
    startWorkflow: () => Effect.die("unused"),
    inspectWorkflow: () => Effect.die("unused"),
    cancelWorkflow: () => Effect.die("unused"),
    start: () => Effect.die("unused"),
    replay: () => Effect.die("unused"),
    cancel: (turnId) =>
      Ref.update(controls, (items) => [...items, ["cancel", turnId]]).pipe(
        Effect.as({ turnId, status: "cancelled" as const, events: [] }),
      ),
    inspect: () => Effect.die("unused"),
    steer: (turnId, text, identity) =>
      Ref.update(controls, (items) => [...items, ["steer", turnId, text, identity]]).pipe(
        Effect.as({ steeringMessageId: "steering", sequence: 1 }),
      ),
    resolveInvocationSource: () => Effect.succeed(authority),
  })
  const service = yield* ThreadToolService.make({
    scheduler: {
      accepted: (turnId) => Ref.update(scheduled, (items) => [...items, turnId]),
    },
    settled: (turn) => Ref.update(settled, (items) => [...items, turn]),
    id: () => identifiers.shift() ?? "exhausted",
  }).pipe(
    Effect.provideService(ThreadInteractionRepository.Service, interactions),
    Effect.provideService(TurnRepository.Service, turns),
    Effect.provideService(ExecutionBackend.Service, backend),
  )
  return { service, interactions, turns, scheduled, controls, settled }
})

describe("ThreadToolService gateway", () => {
  it.effect("fails before installation and delegates after installation", () =>
    Effect.gen(function* () {
      const gateway = yield* ThreadToolService.makeGateway
      const unavailable = yield* Effect.flip(gateway.createThread(invocation, input))
      expect(unavailable).toMatchObject({ _tag: "ThreadToolGatewayUnavailable", state: "uninstalled" })

      yield* gateway.install({
        createThread: () =>
          Effect.succeed({
            schemaVersion: 2,
            threadId: "thread",
            turnId: "turn",
            resultDelivery: "reply",
            state: "running",
          }),
        interact: () => Effect.die("unused"),
        waitForThreads: () => Effect.die("unused"),
      })

      expect(yield* gateway.createThread(invocation, input)).toMatchObject({ threadId: "thread", turnId: "turn" })
    }),
  )

  it.effect("closes with its resident scope", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const gateway = yield* ThreadToolService.makeGateway.pipe(Effect.provideService(Scope.Scope, scope))
      yield* Scope.close(scope, Exit.void)

      const unavailable = yield* Effect.flip(gateway.createThread(invocation, input))
      expect(unavailable).toMatchObject({ _tag: "ThreadToolGatewayUnavailable", state: "closed" })
      expect(
        yield* Effect.flip(
          gateway.install({
            createThread: () => Effect.die("unused"),
            interact: () => Effect.die("unused"),
            waitForThreads: () => Effect.die("unused"),
          }),
        ),
      ).toMatchObject({ state: "closed" })
    }),
  )

  it.effect("creates once, queues messages, previews with a cursor, and binds controls", () =>
    Effect.gen(function* () {
      const { service, turns, scheduled, controls, settled } = yield* serviceHarness
      const created = yield* service.createThread(invocation, input)
      yield* turns.createForSubmission({
        id: Turn.TurnId.make(created.turnId),
        threadId: Thread.ThreadId.make(created.threadId),
        prompt: input.prompt,
        executionRoute: Turn.testExecutionRoute(),
        queueCapacity: 64,
        now: 1,
      })
      const duplicate = yield* service.createThread({ ...invocation, createdAt: 99 }, input)
      expect(duplicate).toEqual(created)
      expect(created).toMatchObject({ threadId: "target", turnId: "target-turn", resultDelivery: "reply" })

      const conflict = yield* Effect.result(service.createThread(invocation, { prompt: "Changed" }))
      expect(conflict._tag).toBe("Failure")
      const queued = yield* service.interact(
        {
          ...invocation,
          callId: "message",
          createdAt: 2,
          idempotencyKeyDigest: "message",
          toolName: "thread_interact",
        },
        { action: "message", threadId: "target", message: "Follow up", resultDelivery: "manual" },
      )
      expect(queued).toMatchObject({ turnId: "queued-turn", state: "queued" })
      expect(yield* Ref.get(scheduled)).toEqual(["target-turn", "target-turn"])

      const first = yield* service.interact(
        { ...invocation, callId: "preview", idempotencyKeyDigest: "preview", toolName: "thread_interact" },
        { action: "preview_messages", threadId: "target", limit: 1 },
      )
      expect(first).toMatchObject({ action: "preview_messages", nextCursor: "queued-turn", truncated: true })
      if (!("action" in first) || first.action !== "preview_messages" || first.nextCursor === undefined)
        return yield* Effect.die("missing cursor")
      const cursor = first.nextCursor
      const second = yield* service.interact(
        { ...invocation, callId: "preview-2", idempotencyKeyDigest: "preview-2", toolName: "thread_interact" },
        { action: "preview_messages", threadId: "target", cursor, limit: 1 },
      )
      expect(second).toMatchObject({ action: "preview_messages", truncated: false })
      if ("action" in second && second.action === "preview_messages")
        expect(second.messages.map((message) => message.messageId)).toEqual(["target-turn"])

      yield* service.interact(
        { ...invocation, callId: "steer", idempotencyKeyDigest: "steer-key", toolName: "thread_interact" },
        { action: "steer", threadId: "target", message: "Focus" },
      )
      yield* service.interact(
        { ...invocation, callId: "cancel", idempotencyKeyDigest: "cancel-key", toolName: "thread_interact" },
        { action: "cancel", threadId: "target" },
      )
      expect(yield* Ref.get(controls)).toEqual([["steer", "target-turn", "Focus", "steer-key"]])
      expect(yield* turns.get(Turn.TurnId.make("target-turn"))).toEqual(
        expect.objectContaining({ id: "target-turn", status: "cancelled" }),
      )
      expect(yield* Ref.get(settled)).toContainEqual(
        expect.objectContaining({ id: "target-turn", status: "cancelled" }),
      )
    }),
  )

  it.effect("waits for exact manual and reply results without treating result text as pending state", () =>
    Effect.gen(function* () {
      const { service, interactions } = yield* serviceHarness
      const manual = yield* service.createThread(
        { ...invocation, idempotencyKeyDigest: "manual-create" },
        { prompt: "Manual", resultDelivery: "manual" },
      )
      const timedOut = yield* service.waitForThreads(
        { ...invocation, createdAt: -2_000, idempotencyKeyDigest: "wait", toolName: "wait_for_threads" },
        { targets: [{ threadId: manual.threadId, turnId: manual.turnId }], timeoutSeconds: 1 },
      )
      expect(timedOut).toMatchObject({ timedOut: true, targets: [{ text: "Waiting" }] })
      yield* interactions.settleResult({
        targetTurnId: Turn.TurnId.make(manual.turnId),
        result: { status: "completed", cursor: "done", sequence: 2, output: "Finished" },
        now: 3,
      })
      const completed = yield* service.waitForThreads(
        { ...invocation, idempotencyKeyDigest: "wait-2", toolName: "wait_for_threads" },
        { targets: [{ threadId: manual.threadId, turnId: manual.turnId }], timeoutSeconds: 1 },
      )
      expect(completed).toMatchObject({ timedOut: false, targets: [{ text: "Finished" }] })

      const reply = yield* service.createThread(
        { ...invocation, idempotencyKeyDigest: "reply-create" },
        { prompt: "Reply" },
      )
      yield* interactions.settleResult({
        targetTurnId: Turn.TurnId.make(reply.turnId),
        result: { status: "completed", cursor: "reply", sequence: 3, output: "Waiting" },
        now: 4,
      })
      expect(
        yield* service.waitForThreads(
          { ...invocation, idempotencyKeyDigest: "wait-reply", toolName: "wait_for_threads" },
          { targets: [{ threadId: reply.threadId, turnId: reply.turnId }], timeoutSeconds: 1 },
        ),
      ).toMatchObject({ timedOut: false, targets: [{ resultDelivery: "reply", text: "Waiting" }] })

      expect(
        yield* Effect.result(
          service.waitForThreads(
            { ...invocation, idempotencyKeyDigest: "wait-mismatch", toolName: "wait_for_threads" },
            { targets: [{ threadId: sourceThread.id, turnId: manual.turnId }], timeoutSeconds: 1 },
          ),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "ThreadWorkspaceMismatch" } })
      expect(
        yield* Effect.result(
          service.waitForThreads(
            { ...invocation, idempotencyKeyDigest: "wait-self", toolName: "wait_for_threads" },
            { targets: [{ threadId: sourceThread.id, turnId: sourceTurn.id }], timeoutSeconds: 1 },
          ),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "ThreadWaitSelfTarget" } })
    }),
  )
})
