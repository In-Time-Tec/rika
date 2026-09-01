import { expect, it } from "@effect/vitest"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as ThreadDeletion from "@rika/product/thread-deletion"
import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"

const titledTurn = (threadId: Thread.ThreadId, id: string, titleRunId: string) =>
  Turn.AgentExecutionTurn.make({
    id: Turn.TurnId.make(id),
    threadId,
    prompt: "delete this thread",
    status: "completed",
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    executionLink: {
      runId: id,
      titleRunId,
      turnId: id,
      threadId: String(threadId),
    },
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    createdAt: 1,
    updatedAt: 2,
  })

it.effect("settles Generalist thread and title sessions before completing deletion", () =>
  Effect.gen(function* () {
    const threadId = Thread.ThreadId.make("thread-delete")
    const calls: Array<string> = []
    const sessions = ExecutionSessionLifecycle.Service.of({
      requestCancellation: ({ sessionId }) =>
        Effect.sync(() => {
          calls.push(`cancel:${sessionId}`)
        }),
      awaitTerminal: ({ sessionId }) =>
        Effect.sync(() => {
          calls.push(`terminal:${sessionId}`)
        }),
    })
    const deletion = ThreadDeletion.make({
      threads: {
        requestDeletion: () =>
          Effect.sync(() => {
            calls.push("request")
          }),
        pendingDeletions: Effect.succeed([]),
        completeDeletion: () =>
          Effect.sync(() => {
            calls.push("complete")
          }),
      },
      turns: {
        list: () =>
          Effect.succeed([
            titledTurn(threadId, "turn-delete", "turn-delete:title"),
            titledTurn(threadId, "turn-delete-retry", "turn-delete:title"),
          ]),
      },
      sessions,
      rootTurns: {
        quiesceThread: () =>
          Effect.sync(() => {
            calls.push("quiesce")
          }),
      },
      withThreadMutation: (_threadId, effect) => effect,
    })

    yield* deletion.request(threadId)

    expect(calls).toEqual([
      "request",
      "quiesce",
      "cancel:thread-delete",
      "cancel:turn-delete:title",
      "terminal:turn-delete:title",
      "terminal:thread-delete",
      "complete",
    ])
  }),
)

it.effect("keeps the tombstone pending when terminal settlement fails and reconciles it later", () =>
  Effect.gen(function* () {
    const threadId = Thread.ThreadId.make("thread-reconcile-delete")
    const calls: Array<string> = []
    let pending = false
    let terminalUnavailable = true
    const deletion = ThreadDeletion.make({
      threads: {
        requestDeletion: () =>
          Effect.sync(() => {
            pending = true
            calls.push("request")
          }),
        pendingDeletions: Effect.sync(() => (pending ? [{ threadId, requestedAt: 1 }] : [])),
        completeDeletion: () =>
          Effect.sync(() => {
            pending = false
            calls.push("complete")
          }),
      },
      turns: { list: () => Effect.succeed([]) },
      sessions: ExecutionSessionLifecycle.Service.of({
        requestCancellation: () =>
          Effect.sync(() => {
            calls.push("cancel")
          }),
        awaitTerminal: () =>
          Effect.suspend(() => {
            calls.push("terminal")
            return terminalUnavailable
              ? Effect.fail(ExecutionSessionLifecycle.Unavailable.make({ message: "runtime unavailable" }))
              : Effect.void
          }),
      }),
      rootTurns: {
        quiesceThread: () =>
          Effect.sync(() => {
            calls.push("quiesce")
          }),
      },
      withThreadMutation: (_threadId, effect) => effect,
    })

    expect((yield* Effect.exit(deletion.request(threadId)))._tag).toBe("Failure")
    expect(pending).toBe(true)
    expect(calls).not.toContain("complete")

    terminalUnavailable = false
    yield* deletion.reconcile

    expect(pending).toBe(false)
    expect(calls).toEqual(["request", "quiesce", "cancel", "terminal", "quiesce", "cancel", "terminal", "complete"])
  }),
)
