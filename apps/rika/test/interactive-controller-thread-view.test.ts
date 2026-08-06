import { describe, expect, it } from "vitest"
import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as ViewState from "@rika/terminal/terminal-state"
import * as ThreadView from "@rika/product/thread-view"
import * as ExecutionProjection from "@rika/product/execution-projection"

const snapshot = (threadId = "thread", revision = 4): ThreadView.ThreadViewSnapshot => ({
  thread: {
    id: threadId,
    workspace: "/workspace",
    title: "Thread",
    labels: [],
    pinned: false,
    archived: false,
    lineage: { _tag: "Original" },
    createdAt: 1,
    updatedAt: 1,
  },
  revision,
  source: { projectionVersion: 1 },
  turns: [],
  pending: [],
  hasOlder: false,
  hasNewer: false,
  usage: { state: ExecutionProjection.emptyUsageState() },
})

const state = (): InteractiveController.State => ({ model: ViewState.initial("/workspace", "medium") })

const patch = (changes: Partial<ThreadView.ThreadViewPatch> = {}): ThreadView.ThreadViewPatch => ({
  threadId: "thread",
  baseRevision: 4,
  revision: 5,
  upsert: [],
  remove: [],
  turnChanges: [],
  ...changes,
})

describe("interactive ThreadView controller", () => {
  it("applies only an exact-base patch", () => {
    const loaded = InteractiveController.update(state(), { _tag: "ThreadViewSnapshot", snapshot: snapshot() })
    const applied = InteractiveController.update(loaded.state, {
      _tag: "ThreadViewPatch",
      patch: patch({
        header: {
          thread: { ...snapshot().thread, title: "Renamed" },
          source: { projectionVersion: 1 },
          pending: [],
          hasOlder: false,
          hasNewer: false,
          usage: snapshot().usage,
        },
      }),
    })
    expect(applied.resync).toBeUndefined()
    expect(applied.state.view?.revision).toBe(5)
    expect(applied.state.model.currentThreadTitle).toBe("Renamed")
  })

  it("requests resync for gaps, foreign threads, and nonmonotonic revisions", () => {
    const loaded = InteractiveController.update(state(), { _tag: "ThreadViewSnapshot", snapshot: snapshot() }).state
    expect(
      InteractiveController.update(loaded, {
        _tag: "ThreadViewPatch",
        patch: patch({ baseRevision: 3, revision: 5 }),
      }),
    ).toMatchObject({ resync: true, rejection: "revision" })
    expect(
      InteractiveController.update(loaded, {
        _tag: "ThreadViewPatch",
        patch: patch({ threadId: "other" }),
      }),
    ).toMatchObject({ resync: true, rejection: "thread" })
    expect(
      InteractiveController.update(loaded, {
        _tag: "ThreadViewPatch",
        patch: patch({ revision: 4 }),
      }),
    ).toMatchObject({ resync: true, rejection: "revision" })
  })

  it("treats cancelling as a distinct active status", () => {
    const value = snapshot()
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...value,
        turns: [
          {
            turn: {
              kind: "agent",
              id: "turn",
              threadId: "thread",
              prompt: "prompt",
              status: "cancelling",
              author: { _tag: "Human" },
              lineage: { _tag: "Original" },
              createdAt: 1,
              updatedAt: 2,
            },
            projectionRevision: 2,
            usage: ExecutionProjection.emptyUsageState(),
            units: [],
          },
        ],
      },
    })
    expect(loaded.state.model.busy).toBe(true)
    expect(loaded.state.model.activeTurnId).toBe("turn")
  })

  it("derives footer cost, tokens, context, and union time only from ThreadView usage", () => {
    const loaded = InteractiveController.update(state(), {
      _tag: "ThreadViewSnapshot",
      snapshot: {
        ...snapshot(),
        usage: {
          state: {
            costNanoUsd: 375_000_000,
            tokens: {
              total: 42,
              input: { total: 30, cacheRead: 5 },
              output: { total: 12, reasoning: 2 },
              failedProviderTotal: 7,
            },
            pricedAttempts: 2,
            unpricedAttempts: 1,
            countedAttempts: 3,
            uncountedAttempts: 1,
            sourceComplete: false,
            context: { requestOrdinal: 2, purpose: "conversation", inputTokens: 30 },
            contextPending: true,
            active: { _tag: "Available", accumulatedMillis: 900, activeSince: 1_000 },
          },
          contextCapacity: { contextWindow: 100, reserveTokens: 10 },
        },
      },
    })
    expect(loaded.state.model).toMatchObject({
      costUsd: 0.375,
      usageCost: { _tag: "Available", usd: 0.375, unpricedAttempts: 1 },
      usageTokens: { _tag: "Available", total: 42, uncountedAttempts: 1 },
      usageTime: { _tag: "Available", accumulatedMillis: 900, activeSince: 1_000 },
      contextUsage: { _tag: "Available", inputTokens: 30, contextWindow: 100, reserveTokens: 10 },
    })
  })
})
