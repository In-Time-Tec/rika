import { describe, expect, test } from "bun:test"
import * as ThreadView from "@rika/product/thread-view"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import type * as InteractiveEvent from "@rika/product/interactive-event"
import { Result, Schema } from "effect"
import { projectSnapshot } from "./projection"
import { translateInteractiveEvent, type ProjectionState } from "./projection-events"

const usage = {
  pricedAttempts: 0,
  unpricedAttempts: 0,
  countedAttempts: 0,
  uncountedAttempts: 0,
  sourceComplete: false,
  contextPending: false,
  active: { _tag: "Unavailable" },
}

const unit = (key: string, sequence: number, content: unknown, revision = 1) => ({
  key,
  turnId: "turn-1",
  order: [{ sequence, part: 0, key }],
  revision,
  content,
})

const snapshot = (units: ReadonlyArray<unknown>, status = "running", revision = 1): ThreadView.ThreadViewSnapshot =>
  Schema.decodeUnknownSync(ThreadView.ThreadViewSnapshot)({
    thread: {
      id: "thread-1",
      workspace: "/workspace",
      title: "Projection test",
      labels: ["desktop"],
      pinned: false,
      archived: false,
      lineage: { _tag: "Original" },
      createdAt: 100,
      updatedAt: 200,
    },
    source: { projectionVersion: 1 },
    pending: [],
    hasOlder: false,
    hasNewer: false,
    usage: { state: usage },
    revision,
    turns: [
      {
        turn: {
          id: "turn-1",
          threadId: "thread-1",
          prompt: "hello",
          status,
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          createdAt: 110,
          updatedAt: 190,
          kind: "agent",
        },
        units,
        projectionRevision: revision,
        usage,
      },
    ],
  })

const initial = (value: ThreadView.ThreadViewSnapshot) =>
  translateInteractiveEvent({}, { _tag: "ThreadViewSnapshot", snapshot: value })

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (result._tag === "Failure") throw result.failure
  return result.success
}

describe("Rika Thread View projection", () => {
  test("projects every Turn to paired messages and orders parts by canonical Unit.order", () => {
    const value = snapshot([
      unit("assistant-late", 3, { _tag: "Entry", role: "assistant", text: "late" }),
      unit("user", 1, { _tag: "Entry", role: "user", text: "hello" }),
      unit("assistant-early", 2, { _tag: "Entry", role: "assistant", text: "early" }),
    ])
    const projected = projectSnapshot(value)

    expect(projected.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(projected.messages[1]?.role === "assistant" && projected.messages[1].parentID).toBe(
      projected.messages[0]?.id,
    )
    expect(
      projected.parts
        .filter((part) => part.messageID === projected.messages[1]?.id)
        .map((part) => part.type === "text" && part.text),
    ).toEqual(["early", "late"])
    expect(projected.status).toEqual({ type: "busy" })
    expect(projected.session.metadata).toEqual({
      labels: ["desktop"],
      pinned: false,
      lineage: { _tag: "Original" },
    })
  })

  test("applies full Unit upserts by revision and emits a full part replacement", () => {
    const before = snapshot([
      unit("user", 1, { _tag: "Entry", role: "user", text: "hello" }),
      unit("answer", 2, { _tag: "Entry", role: "assistant", text: "one" }),
    ])
    const started = success(initial(before))
    const replacement = Schema.decodeUnknownSync(ThreadView.ThreadViewPatch)({
      threadId: "thread-1",
      baseRevision: 1,
      revision: 2,
      upsert: [unit("answer", 2, { _tag: "Entry", role: "assistant", text: "one two" }, 2)],
      remove: [],
      turnChanges: [],
    })
    const result = success(
      translateInteractiveEvent(started.state, {
        _tag: "ThreadViewPatch",
        patch: replacement,
      }),
    )

    expect(result.state.snapshot?.revision).toBe(2)
    const updates = result.events.filter((event) => event.type === "message.part.updated")
    expect(updates).toHaveLength(1)
    expect(updates[0]?.properties.part.type === "text" && updates[0].properties.part.text).toBe("one two")
    expect(result.events.some((event) => event.type === "message.part.delta")).toBe(false)
  })

  test("rejects stale patches instead of corrupting projection state", () => {
    const before = snapshot([unit("user", 1, { _tag: "Entry", role: "user", text: "hello" })])
    const started = success(initial(before))
    const stale = Schema.decodeUnknownSync(ThreadView.ThreadViewPatch)({
      threadId: "thread-1",
      baseRevision: 0,
      revision: 2,
      upsert: [],
      remove: [],
      turnChanges: [],
    })
    const result = translateInteractiveEvent(started.state, {
      _tag: "ThreadViewPatch",
      patch: stale,
    })

    expect(Result.isFailure(result)).toBe(true)
    if (result._tag === "Failure") expect(result.failure.reason).toBe("invalid-patch")
  })

  test("indexes only pending authorizations as binary permission requests", () => {
    const value = snapshot([
      unit("user", 1, { _tag: "Entry", role: "user", text: "hello" }),
      unit("auth", 2, {
        _tag: "Block",
        block: {
          _tag: "AuthorizationCard",
          id: "auth-1",
          operation: "write file",
          capability: "filesystem.write",
          input: "/workspace/file.ts",
          inputTruncated: false,
          status: "pending",
        },
      }),
    ])
    const projected = projectSnapshot(value)

    expect(projected.permissions).toHaveLength(1)
    expect(projected.permissions[0]?.always).toEqual([])
    expect(projected.authorizationIndex.get("auth-1")).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      authorizationId: "auth-1",
    })
    const translated = success(initial(value))
    expect(translated.events.some((event) => event.type === "permission.asked")).toBe(true)
  })

  test("projects retry scheduling without inventing snapshot content", () => {
    const value = snapshot([unit("user", 1, { _tag: "Entry", role: "user", text: "hello" })])
    const started = success(initial(value))
    const retry = success(
      translateInteractiveEvent(started.state, {
        _tag: "TurnRetryScheduled",
        threadId: value.thread.id,
        turnId: value.turns[0]!.turn.id,
        attempt: 2,
        budget: 3,
        retryTurnId: value.turns[0]!.turn.id,
        nextAt: 500,
        message: "rate limited",
      } satisfies InteractiveEvent.InteractiveEvent),
    )

    expect(retry.state.projected?.status).toEqual({
      type: "retry",
      attempt: 2,
      next: 500,
      message: "rate limited",
    })
    expect(retry.events.at(-1)).toMatchObject({
      type: "session.status",
      properties: { status: { type: "retry" } },
    })
  })

  test("projects the configured OpenRouter model onto messages", () => {
    const projected = projectSnapshot(
      snapshot([unit("user", 1, { _tag: "Entry", role: "user", text: "hello" })]),
      { providerID: "openrouter", modelID: "openrouter/free" },
    )

    expect(projected.messages).toEqual([
      expect.objectContaining({ role: "user", model: { providerID: "openrouter", modelID: "openrouter/free" } }),
      expect.objectContaining({ role: "assistant", providerID: "openrouter", modelID: "openrouter/free" }),
    ])
  })

  test("requires a snapshot before a patch", () => {
    const patch = Schema.decodeUnknownSync(ThreadView.ThreadViewPatch)({
      threadId: "thread-1",
      baseRevision: 0,
      revision: 1,
      upsert: [],
      remove: [],
      turnChanges: [],
    })
    const state: ProjectionState = {}
    const result = translateInteractiveEvent(state, {
      _tag: "ThreadViewPatch",
      patch,
    })

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.reason).toBe("missing-snapshot")
  })
})

test("submission admission removes the matching optimistic message", () => {
  const state: ProjectionState = {}
  const result = translateInteractiveEvent(state, {
    _tag: "SubmissionAdmitted",
    threadId: Thread.ThreadId.make("thread-1"),
    turnId: Turn.TurnId.make("turn-1"),
    status: "active",
    submissionId: "message-1",
  })
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) return
  expect(result.success.state).toBe(state)
  expect(result.success.events).toEqual([
    {
      id: "rika-event:thread-1:submission:message-1",
      type: "message.removed",
      properties: { sessionID: "thread-1", messageID: "message-1" },
    },
  ])
})
