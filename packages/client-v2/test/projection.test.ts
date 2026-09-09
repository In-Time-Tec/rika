/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- ConnectionSnapshot is a public tagged event without a runtime codec export. */
/* oxlint-disable typescript/no-unsafe-assignment -- decoded Generalist event fixtures are intentionally refined by the reducer. */
import { expect, it } from "@effect/vitest"
import { Prompt } from "effect/unstable/ai"
import { Schema } from "effect"
import { Server, type ConnectionEvent } from "generalist/server"
import { applyConnectionEvent, applyConnectionStatus, projectSnapshot, promptText } from "../src/projection"

const snapshot = Schema.decodeSync(Server.SessionSnapshot)({
  version: 1,
  session: {
    id: "session",
    title: "Hosted thread",
    createdAt: "2026-09-09T00:00:00.000Z",
    queue: [],
  },
  cursor: 0,
  runs: [],
  conversation: { leafId: null, entries: [] },
})

it("projects Generalist conversation entries without maintaining a transcript-shaped source", () => {
  const prompt = Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "hello" })] })
  expect(promptText(Prompt.make([prompt]))).toBe("hello")
  const current = {
    ...snapshot,
    conversation: {
      leafId: "leaf",
      entries: [{ id: "entry", parentId: null, messages: [prompt] }],
    },
  }
  const projection = projectSnapshot({ sessionId: "session", snapshot: current })
  expect(projection.thread.items).toEqual([
    { id: "entry:message:0:part:0", kind: "user", title: "user", text: "hello", status: "working" },
  ])
  expect(projection.committedCursor).toBe(0)
})

it("rejects gaps and stale previews without changing the committed projection", () => {
  const projection = projectSnapshot({ sessionId: "session", snapshot })
  const preview = Schema.decodeSync(Server.ServerEvent)({
    _tag: "PreviewDelivery",
    sessionId: "session",
    runId: "run",
    authorityAttemptFence: 2,
    event: {
      _tag: "ModelPreview",
      runId: "run",
      attemptFence: 2,
      turn: 1,
      modelCallId: "call",
      modelAttemptId: "attempt",
      attempt: 1,
      generation: 0,
      sequence: 1,
      changes: [{ channel: "text", offset: 0, delta: "hello" }],
    },
  })
  const appliedPreview = applyConnectionEvent(projection, preview)
  expect(appliedPreview._tag).toBe("Applied")
  if (appliedPreview._tag !== "Applied") return
  expect(appliedPreview.state.thread.items.at(-1)?.text).toBe("hello")
  const gap = Schema.decodeSync(Server.ServerEvent)({
    _tag: "Conversation",
    sessionId: "session",
    cursor: 2,
    update: { previousLeafId: null, leafId: null, afterEntryId: null, entries: [] },
  })
  const rejected = applyConnectionEvent(appliedPreview.state, gap)
  expect(rejected._tag).toBe("Rejected")
  if (rejected._tag === "Rejected") expect(rejected.state.committedCursor).toBe(0)
  const stale = Schema.decodeSync(Server.ServerEvent)({
    _tag: "PreviewDelivery",
    sessionId: "session",
    runId: "run",
    authorityAttemptFence: 1,
    event: {
      _tag: "ModelPreview",
      runId: "run",
      attemptFence: 1,
      turn: 1,
      modelCallId: "call",
      modelAttemptId: "attempt",
      attempt: 1,
      generation: 0,
      sequence: 99,
      changes: [{ channel: "text", offset: 0, delta: "stale" }],
    },
  })
  const ignored = applyConnectionEvent(appliedPreview.state, stale)
  expect(ignored._tag).toBe("Ignored")
  if (ignored._tag === "Ignored") expect(ignored.state.thread.items.at(-1)?.text).toBe("hello")
})

it("maps reconnect status to waiting without clearing committed content", () => {
  const projection = projectSnapshot({ sessionId: "session", snapshot })
  const waiting = applyConnectionStatus(projection, { _tag: "Retrying", epoch: 1, attempt: 1 })
  expect(waiting.thread.activity).toBe("waiting")
  expect(waiting.snapshot).toBe(snapshot)
})

it("keeps preview authority fences across replacement snapshots", () => {
  const projection = projectSnapshot({ sessionId: "session", snapshot })
  const preview = Schema.decodeSync(Server.ServerEvent)({
    _tag: "PreviewDelivery",
    sessionId: "session",
    runId: "run",
    authorityAttemptFence: 2,
    event: {
      _tag: "ModelPreview",
      runId: "run",
      attemptFence: 2,
      turn: 1,
      modelCallId: "call",
      modelAttemptId: "attempt",
      attempt: 1,
      generation: 3,
      sequence: 1,
      changes: [{ channel: "text", offset: 0, delta: "fresh" }],
    },
  })
  const applied = applyConnectionEvent(projection, preview)
  expect(applied._tag).toBe("Applied")
  if (applied._tag !== "Applied") return
  const replacement = {
    _tag: "ConnectionSnapshot",
    epoch: 1,
    snapshot: { ...snapshot, cursor: 1 },
  } as ConnectionEvent
  const reconnected = applyConnectionEvent(applied.state, replacement)
  expect(reconnected._tag).toBe("Applied")
  if (reconnected._tag !== "Applied") return
  expect(reconnected.state.previews.size).toBe(0)
  const stale = Schema.decodeSync(Server.ServerEvent)({
    _tag: "PreviewDelivery",
    sessionId: "session",
    runId: "run",
    authorityAttemptFence: 1,
    event: {
      _tag: "ModelPreview",
      runId: "run",
      attemptFence: 1,
      turn: 1,
      modelCallId: "call",
      modelAttemptId: "attempt",
      attempt: 1,
      generation: 9,
      sequence: 1,
      changes: [{ channel: "text", offset: 0, delta: "stale" }],
    },
  })
  const ignored = applyConnectionEvent(reconnected.state, stale)
  expect(ignored._tag).toBe("Ignored")
  const newer = Schema.decodeSync(Server.ServerEvent)({
    _tag: "PreviewDelivery",
    sessionId: "session",
    runId: "run",
    authorityAttemptFence: 3,
    event: {
      _tag: "ModelPreview",
      runId: "run",
      attemptFence: 3,
      turn: 1,
      modelCallId: "call",
      modelAttemptId: "attempt",
      attempt: 1,
      generation: 0,
      sequence: 1,
      changes: [{ channel: "text", offset: 0, delta: "new" }],
    },
  })
  const accepted = applyConnectionEvent(reconnected.state, newer)
  expect(accepted._tag).toBe("Applied")
})

it("uses retained Session ids for loaded and unloaded collaborators", () => {
  const withChildRun = Schema.decodeSync(Server.SessionSnapshot)({
    ...snapshot,
    runs: [
      {
        runId: "child-run",
        rootRunId: "child-run",
        parentRunId: "parent-run",
        status: "succeeded",
        cursor: 1,
        turn: 1,
      },
    ],
  })
  const family = {
    rootSessionId: "session",
    at: 17,
    sessions: [
      {
        id: "loaded-child",
        rootSessionId: "session",
        parentSessionId: "session",
        parentRunId: "parent-run",
        initialRunId: "child-run",
        depth: 1,
      },
      {
        id: "unloaded-child",
        rootSessionId: "session",
        parentSessionId: "session",
        parentRunId: "parent-run-2",
        initialRunId: "missing-run",
        depth: 1,
      },
    ],
    nextBefore: 3,
  } as const
  const projection = projectSnapshot({ sessionId: "session", snapshot: withChildRun, family })
  expect(projection.thread.items.filter((item) => item.kind === "child")).toEqual([
    {
      id: "child-session:loaded-child",
      kind: "child",
      title: "loaded-child",
      text: "succeeded",
      status: "idle",
      childSessionId: "loaded-child",
    },
    {
      id: "child-session:unloaded-child",
      kind: "child",
      title: "unloaded-child",
      text: "",
      childSessionId: "unloaded-child",
    },
  ])
})
