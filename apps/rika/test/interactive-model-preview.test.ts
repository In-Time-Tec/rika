import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { createTestRenderer } from "@opentui/core/testing"
import { Surface } from "@rika/terminal/opentui-surface"
import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as ExecutionProjection from "@rika/product/execution-projection"
import type * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as ThreadView from "@rika/product/thread-view"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TerminalState from "@rika/terminal/terminal-state"
import { formatActivity, type TranscriptItem } from "@rika/terminal/terminal-message"
import * as ModelPreview from "../src/interactive/controller/interactive-model-preview"

const threadId = Thread.ThreadId.make("thread")
const turnId = Turn.TurnId.make("turn")
const thread: Thread.Thread = {
  id: threadId,
  workspace: "/workspace",
  title: "Thread",
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
const turn: ThreadView.ThreadViewTurnRecord = {
  kind: "agent",
  id: turnId,
  threadId,
  prompt: "prompt",
  status: "running",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
const promptKey = "turn:user"
const snapshot = (): ThreadView.ThreadViewSnapshot => ({
  thread,
  revision: 0,
  source: { projectionVersion: 1 },
  turns: [
    {
      turn,
      projectionRevision: 0,
      usage: ExecutionProjection.emptyUsageState(),
      units: [
        {
          key: promptKey,
          turnId,
          order: TranscriptOrdering.unitOrder(promptKey, -1),
          revision: 0,
          content: { _tag: "Entry", role: "user", text: "prompt" },
        },
      ],
    },
  ],
  pending: [],
  hasOlder: false,
  hasNewer: false,
  usage: { state: ExecutionProjection.emptyUsageState() },
})
const preview = (
  revision: number,
  text: string,
  options: Partial<ExecutionGateway.ModelPreviewed["key"]> = {},
  reasoning = "reasoning",
): Extract<
  import("@rika/product/interactive-event").InteractiveEvent,
  { readonly _tag: "ExecutionModelPreviewed" }
> => ({
  _tag: "ExecutionModelPreviewed",
  threadId,
  turnId,
  preview: {
    _tag: "ModelPreviewed",
    key: {
      runId: "run",
      attemptFence: 1,
      turn: 0,
      modelCallId: "call",
      modelAttemptId: "attempt-1",
      attempt: 1,
      ...options,
    },
    revision,
    text,
    reasoning,
    truncated: false,
  },
})
const loaded = () =>
  InteractiveController.update(
    { model: TerminalState.initial("/workspace", "medium") },
    { _tag: "ThreadViewSnapshot", snapshot: snapshot() },
  ).state
const assistantText = (state: InteractiveController.State): string | undefined =>
  state.model.entries.findLast((entry) => entry.role === "assistant")?.text
const reasoningText = (state: InteractiveController.State): string | undefined =>
  (state.model.blocks as ReadonlyArray<{ readonly _tag?: string; readonly text?: string }>).findLast(
    (block) => block._tag === "Reasoning",
  )?.text
const ids = (state: InteractiveController.State): ReadonlyArray<string> =>
  (state.model.items as ReadonlyArray<TranscriptItem>).flatMap((item) => (item.id === undefined ? [] : [item.id]))

const timelineUnit = (key: string, content: TranscriptUnit.Unit["content"], revision = 1): TranscriptUnit.Unit => ({
  key,
  turnId,
  order: TranscriptOrdering.unitOrder(key, revision),
  revision,
  content,
})

const toolCall = (status: "running" | "complete" = "running"): TranscriptUnit.Unit["content"] => ({
  _tag: "Block",
  block: {
    _tag: "ToolCall",
    id: "tool",
    name: "read",
    input: "{}",
    status,
    presentation: {
      family: "explore",
      action: "read",
      activeLabel: "Reading",
      completeLabel: "Read",
    },
    detail: "file.ts",
    files: [],
  },
})

const withUnits = (units: ReadonlyArray<TranscriptUnit.Unit>): ThreadView.ThreadViewSnapshot => {
  const view = snapshot()
  return {
    ...view,
    turns: view.turns.map((entry) => ({ ...entry, units: [...entry.units, ...units] })),
  }
}

interface PatchOptions {
  readonly upsert?: ReadonlyArray<TranscriptUnit.Unit>
  readonly status?: ThreadView.ThreadViewTurnRecord["status"]
  readonly turnUsage?: ExecutionProjection.UsageState
  readonly threadUsage?: ExecutionProjection.UsageState
}

const applyPatch = (state: InteractiveController.State, options: PatchOptions): InteractiveController.State => {
  const view = state.view!
  const entry = view.turns.find((candidate) => candidate.turn.id === turnId)!
  const patch: ThreadView.ThreadViewPatch = {
    threadId,
    baseRevision: view.revision,
    revision: view.revision + 1,
    upsert: options.upsert ?? [],
    remove: [],
    turnChanges:
      options.status === undefined && options.turnUsage === undefined
        ? []
        : [
            {
              _tag: "UpsertTurn",
              turn: {
                ...entry.turn,
                ...(options.status === undefined ? {} : { status: options.status }),
                updatedAt: entry.turn.updatedAt + 1,
              },
              projectionRevision: entry.projectionRevision + 1,
              usage: options.turnUsage ?? entry.usage,
            },
          ],
    ...(options.threadUsage === undefined
      ? {}
      : {
          header: {
            thread: view.thread,
            source: view.source,
            pending: view.pending,
            hasOlder: view.hasOlder,
            hasNewer: view.hasNewer,
            usage: { ...view.usage, state: options.threadUsage },
          },
        }),
  }
  return InteractiveController.update(state, { _tag: "ThreadViewPatch", patch }).state
}

describe("tentative model preview overlay", () => {
  it("reports cumulative reasoning and answer previews as thinking and streaming activity", () => {
    let state = InteractiveController.update(loaded(), preview(1, "", {}, "12345678")).state
    expect(state.model.activity).toEqual({ _tag: "Thinking", bytes: 8 })
    expect(formatActivity(state.model.activity)).toBe("Thinking 2 tok")

    state = InteractiveController.update(state, preview(2, "123456789012", {}, "12345678")).state
    expect(state.model.activity).toEqual({ _tag: "Streaming", bytes: 12 })
    expect(formatActivity(state.model.activity)).toBe("Streaming 3 tok")

    state = InteractiveController.update(state, preview(3, "1234567890123456", {}, "12345678")).state
    expect(state.model.activity).toEqual({ _tag: "Streaming", bytes: 16 })
    expect(formatActivity(state.model.activity)).toBe("Streaming 4 tok")
  })

  it("keeps ten thousand cumulative revisions to two bounded native transcript units", () => {
    let state = loaded()
    for (let revision = 1; revision <= 10_000; revision += 1)
      state = InteractiveController.update(state, preview(revision, `answer ${revision}`)).state
    expect(assistantText(state)).toBe("answer 10000")
    expect(reasoningText(state)).toBe("reasoning")
    expect(state.modelPreview?.preview.revision).toBe(10_000)
    expect(state.model.items).toHaveLength(3)
    expect(ids(state).filter((id) => id.startsWith("tentative:"))).toHaveLength(2)
  })

  it("rejects stale revisions and retired attempts", () => {
    let state = loaded()
    state = InteractiveController.update(state, preview(2, "current")).state
    state = InteractiveController.update(state, preview(1, "stale revision")).state
    expect(assistantText(state)).toBe("current")
    state = InteractiveController.update(
      state,
      preview(1, "new attempt", { attemptFence: 2, modelAttemptId: "attempt-2", attempt: 2 }),
    ).state
    expect(assistantText(state)).toBe("new attempt")
    state = InteractiveController.update(state, preview(99, "retired attempt")).state
    expect(assistantText(state)).toBe("new attempt")
  })

  it("uses the current bounded view as the baseline when a second model call starts in the same turn", () => {
    let state = InteractiveController.update(loaded(), preview(1, "first answer", {}, "first thought")).state
    expect(state.modelPreview).toBeDefined()
    const priorUnits = [
      timelineUnit("first:reasoning", {
        _tag: "Block",
        block: { _tag: "Reasoning", text: "first durable thought" },
      }),
      timelineUnit("first:tool", toolCall()),
      timelineUnit("first:answer", { _tag: "Entry", role: "assistant", text: "first durable answer" }),
    ]
    state = applyPatch(state, { upsert: priorUnits })
    expect(state.modelPreview).toBeUndefined()
    expect(state.view?.turns[0]?.units.map((unit) => unit.key)).toEqual(
      expect.arrayContaining(priorUnits.map((unit) => unit.key)),
    )

    state = InteractiveController.update(
      state,
      preview(1, "second answer", { turn: 1, modelCallId: "call-2", modelAttemptId: "attempt-2" }, "second thought"),
    ).state
    expect(state.modelPreview?.baselineAuthoritativeUnitKeys).toEqual(new Set(priorUnits.map((unit) => unit.key)))
    expect(assistantText(state)).toBe("second answer")
    expect(reasoningText(state)).toBe("second thought")

    const baseline = state.modelPreview?.baselineAuthoritativeUnitKeys
    state = InteractiveController.update(
      state,
      preview(
        2,
        "second answer revised",
        { turn: 1, modelCallId: "call-2", modelAttemptId: "attempt-2" },
        "second thought revised",
      ),
    ).state
    expect(state.modelPreview?.baselineAuthoritativeUnitKeys).toBe(baseline)
    expect(state.modelPreview?.preview.revision).toBe(2)
    expect(assistantText(state)).toBe("second answer revised")
    expect(reasoningText(state)).toBe("second thought revised")
  })

  it.each([
    {
      name: "assistant text",
      content: { _tag: "Entry", role: "assistant", text: "durable text" } as const,
      previewText: "tentative text",
      previewReasoning: "",
    },
    {
      name: "reasoning",
      content: { _tag: "Block", block: { _tag: "Reasoning", text: "durable thought" } } as const,
      previewText: "",
      previewReasoning: "tentative thought",
    },
    {
      name: "tool-only output",
      content: toolCall(),
      previewText: "tentative text",
      previewReasoning: "tentative thought",
    },
    {
      name: "cell",
      content: {
        _tag: "Block",
        block: {
          _tag: "Cell",
          id: "cell",
          status: "running",
          visual: "ts",
          summary: "Running cell",
          source: { text: "1 + 1", lines: 1, truncated: false },
          output: { stdout: "", stderr: "", droppedBytes: 0, droppedEvents: 0 },
          epoch: 1,
          notices: [],
          files: [],
        },
      } as const,
      previewText: "tentative text",
      previewReasoning: "tentative thought",
    },
    {
      name: "subagent card",
      content: {
        _tag: "Block",
        block: {
          _tag: "SubagentCard",
          id: "child",
          name: "reviewer",
          prompt: "review",
          promptTruncated: false,
          summary: "Reviewing",
          status: "running",
          activity: [],
        },
      } as const,
      previewText: "tentative text",
      previewReasoning: "tentative thought",
    },
    {
      name: "file-source notification",
      content: {
        _tag: "Block",
        block: { _tag: "Notification", title: "File source unavailable", detail: "file.ts" },
      } as const,
      previewText: "tentative text",
      previewReasoning: "tentative thought",
    },
    {
      name: "model error",
      content: {
        _tag: "Block",
        block: { _tag: "Error", title: "Model failed", detail: "provider rejected the request" },
      } as const,
      previewText: "tentative text",
      previewReasoning: "tentative thought",
    },
  ])("clears on a new $name unit", ({ name, content, previewText, previewReasoning }) => {
    let state = InteractiveController.update(loaded(), preview(1, previewText, {}, previewReasoning)).state
    expect(state.modelPreview).toBeDefined()
    const key = `new:${name}`
    state = applyPatch(state, { upsert: [timelineUnit(key, content)] })
    expect(state.view?.turns[0]?.units.some((unit) => unit.key === key)).toBe(true)
    expect(state.modelPreview).toBeUndefined()
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(false)
  })

  it("keeps the preview across same-key tool progress, ToolResult, usage, and non-terminal status patches", () => {
    const toolKey = "baseline:tool"
    let state = applyPatch(loaded(), { upsert: [timelineUnit(toolKey, toolCall())] })
    state = InteractiveController.update(state, preview(1, "still streaming", {}, "still thinking")).state
    const overlay = state.modelPreview
    expect(overlay?.baselineAuthoritativeUnitKeys).toEqual(new Set([toolKey]))

    state = applyPatch(state, { upsert: [timelineUnit(toolKey, toolCall("complete"), 2)] })
    expect(state.modelPreview).toBe(overlay)
    expect(assistantText(state)).toBe("still streaming")

    const resultKey = "tool:result"
    state = applyPatch(state, {
      upsert: [
        timelineUnit(resultKey, {
          _tag: "Block",
          block: { _tag: "ToolResult", id: "tool", output: "done", failed: false },
        }),
      ],
    })
    expect(state.view?.turns[0]?.units.some((unit) => unit.key === resultKey)).toBe(true)
    expect(state.modelPreview).toBe(overlay)

    const usage = {
      ...ExecutionProjection.emptyUsageState(),
      costNanoUsd: 12,
      pricedAttempts: 1,
      active: { _tag: "Available" as const, accumulatedMillis: 5 },
    }
    state = applyPatch(state, { status: "waiting", turnUsage: usage, threadUsage: usage })
    expect(state.view?.turns[0]?.turn.status).toBe("waiting")
    expect(state.view?.usage.state.costNanoUsd).toBe(12)
    expect(state.modelPreview).toBe(overlay)
    expect(assistantText(state)).toBe("still streaming")
  })

  it.each(["completed", "failed", "cancelled"] as const)("clears on terminal %s status", (status) => {
    let state = InteractiveController.update(loaded(), preview(1, "tentative answer")).state
    expect(state.modelPreview).toBeDefined()
    state = applyPatch(state, { status })
    expect(state.view?.turns[0]?.turn.status).toBe(status)
    expect(state.modelPreview).toBeUndefined()
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(false)
  })

  it("bounds the baseline to the view and replaces it for a new preview identity", () => {
    const authoritativeUnits = (prefix: string, count: number): ReadonlyArray<TranscriptUnit.Unit> =>
      Array.from({ length: count }, (_, index) =>
        timelineUnit(`${prefix}:${index}`, {
          _tag: "Entry",
          role: "assistant",
          text: `${prefix} ${index}`,
        }),
      )
    const firstUnits = authoritativeUnits("first-window", 40)
    const secondUnits = authoritativeUnits("second-window", 12)
    const firstView = withUnits(firstUnits)
    const secondView = withUnits(secondUnits)
    const firstPreview = preview(1, "first").preview
    const firstOverlay = ModelPreview.replace(undefined, firstView, String(turnId), firstPreview, [])!
    expect(firstOverlay.baselineAuthoritativeUnitKeys.size).toBe(firstUnits.length)
    expect(firstOverlay.baselineAuthoritativeUnitKeys.size).toBeLessThan(firstView.turns[0]!.units.length)

    const revised = ModelPreview.replace(
      firstOverlay,
      firstView,
      String(turnId),
      {
        ...firstPreview,
        revision: 2,
        text: "first revised",
      },
      [],
    )!
    expect(revised.baselineAuthoritativeUnitKeys).toBe(firstOverlay.baselineAuthoritativeUnitKeys)

    const nextPreview = preview(1, "second", {
      attemptFence: 2,
      turn: 1,
      modelCallId: "call-2",
      modelAttemptId: "attempt-2",
      attempt: 2,
    }).preview
    const nextOverlay = ModelPreview.replace(revised, secondView, String(turnId), nextPreview, [])!
    expect(nextOverlay.baselineAuthoritativeUnitKeys).toEqual(new Set(secondUnits.map((unit) => unit.key)))
    expect(nextOverlay.baselineAuthoritativeUnitKeys.size).toBe(secondUnits.length)
    expect(firstUnits.some((unit) => nextOverlay.baselineAuthoritativeUnitKeys.has(unit.key))).toBe(false)
  })

  it("replaces tentative text and reasoning with durable semantic units", () => {
    let state = InteractiveController.update(loaded(), preview(1, "tentative answer", {}, "tentative thought")).state
    const reasoningKey = "turn:reasoning"
    const answerKey = "turn:answer"
    const patch: ThreadView.ThreadViewPatch = {
      threadId,
      baseRevision: 0,
      revision: 1,
      upsert: [
        {
          key: reasoningKey,
          turnId,
          order: TranscriptOrdering.unitOrder(reasoningKey, 1),
          revision: 1,
          content: { _tag: "Block", block: { _tag: "Reasoning", text: "durable thought" } },
        },
        {
          key: answerKey,
          turnId,
          order: TranscriptOrdering.unitOrder(answerKey, 2),
          revision: 1,
          content: { _tag: "Entry", role: "assistant", text: "durable answer" },
        },
      ],
      remove: [],
      turnChanges: [
        {
          _tag: "UpsertTurn",
          turn: { ...turn, status: "completed", updatedAt: 2 },
          projectionRevision: 1,
          usage: ExecutionProjection.emptyUsageState(),
        },
      ],
    }
    state = InteractiveController.update(state, { _tag: "ThreadViewPatch", patch }).state
    expect(assistantText(state)).toBe("durable answer")
    expect(reasoningText(state)).toBe("durable thought")
    expect(state.model.entries.filter((entry) => entry.role === "assistant")).toHaveLength(1)
    expect(ids(state).some((id) => id.startsWith("tentative:"))).toBe(false)
    expect(state.modelPreview).toBeUndefined()
  })

  it("clears tentative rows on terminal control and ignores foreign turns", () => {
    const state = InteractiveController.update(loaded(), preview(1, "tentative")).state
    const foreign = InteractiveController.update(state, { ...preview(2, "foreign"), turnId: Turn.TurnId.make("other") })
    expect(foreign.state).toBe(state)
    const cleared = InteractiveController.clearPreview(state, String(turnId))
    expect(cleared.modelPreview).toBeUndefined()
    expect(ids(cleared).some((id) => id.startsWith("tentative:"))).toBe(false)
  })

  it("clears the overlay on a Baton clear tombstone and rejects the retired preview afterwards", () => {
    let state = InteractiveController.update(loaded(), preview(1, "tentative answer")).state
    expect(state.modelPreview).toBeDefined()
    state = InteractiveController.update(state, {
      _tag: "ExecutionModelPreviewCleared",
      threadId: turn.threadId,
      turnId,
      runId: "run-1",
      attemptFence: 1,
      generation: 2,
    }).state
    expect(state.modelPreview).toBeUndefined()
    // A late stale frame for the retired attempt must not resurrect the overlay.
    state = InteractiveController.update(state, preview(1, "stale answer")).state
    expect(state.modelPreview).toBeUndefined()
  })

  it("clears the overlay when durable authoritative units arrive and rejects the retired preview afterwards", () => {
    let state = InteractiveController.update(loaded(), preview(1, "tentative answer", {}, "tentative thought")).state
    expect(state.modelPreview).toBeDefined()
    const patch: ThreadView.ThreadViewPatch = {
      threadId: turn.threadId,
      baseRevision: state.view!.revision,
      revision: state.view!.revision + 1,
      upsert: [
        {
          key: "durable-answer",
          turnId: String(turnId),
          order: [{ sequence: 0, part: 0, key: "durable-answer" }],
          revision: 1,
          content: { _tag: "Entry", role: "assistant", text: "durable answer" },
        },
      ],
      remove: [],
      turnChanges: [],
      header: {
        thread: state.view!.thread,
        source: state.view!.source,
        pending: state.view!.pending,
        hasOlder: state.view!.hasOlder,
        hasNewer: state.view!.hasNewer,
        usage: state.view!.usage,
      },
    }
    state = InteractiveController.update(state, { _tag: "ThreadViewPatch", patch }).state
    expect(state.modelPreview).toBeUndefined()
    state = InteractiveController.update(state, preview(1, "stale answer")).state
    expect(state.modelPreview).toBeUndefined()
  })

  it("allows a fresh second model call in the same turn after a durable clear", () => {
    let state = InteractiveController.update(loaded(), preview(1, "first answer")).state
    const patch: ThreadView.ThreadViewPatch = {
      threadId: turn.threadId,
      baseRevision: state.view!.revision,
      revision: state.view!.revision + 1,
      upsert: [
        {
          key: "first-tool",
          turnId: String(turnId),
          order: [{ sequence: 0, part: 0, key: "first-tool" }],
          revision: 1,
          content: {
            _tag: "Block",
            block: {
              _tag: "ToolCall",
              id: "first-tool",
              name: "read",
              input: "{}",
              status: "complete",
              presentation: {
                family: "explore",
                action: "read",
                activeLabel: "Reading",
                completeLabel: "Read",
              },
              detail: "file.ts",
              files: [],
            },
          },
        },
      ],
      remove: [],
      turnChanges: [],
      header: {
        thread: state.view!.thread,
        source: state.view!.source,
        pending: state.view!.pending,
        hasOlder: state.view!.hasOlder,
        hasNewer: state.view!.hasNewer,
        usage: state.view!.usage,
      },
    }
    state = InteractiveController.update(state, { _tag: "ThreadViewPatch", patch }).state
    expect(state.modelPreview).toBeUndefined()
    state = InteractiveController.update(
      state,
      preview(1, "second answer", { turn: 1, modelCallId: "call-2", modelAttemptId: "attempt-2", attempt: 2 }),
    ).state
    expect(state.modelPreview?.preview.text).toBe("second answer")
  })

  it.effect(
    "reuses a bounded set of physical OpenTUI rows across preview revisions",
    () =>
      Effect.gen(function* () {
        const setup = yield* Effect.promise(() => createTestRenderer({ width: 100, height: 30 }))
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            surface.destroy()
            setup.renderer.destroy()
          }),
        )
        let state = InteractiveController.update(loaded(), preview(1, "answer 1")).state
        surface.update(state.model)
        const initialRows = [...surface.transcriptDiagnostics().rows]
        for (let revision = 2; revision <= 10_000; revision += 1) {
          state = InteractiveController.update(state, preview(revision, `answer ${revision}`)).state
          surface.update(state.model)
        }
        yield* Effect.promise(() => setup.flush())
        const diagnostics = surface.transcriptDiagnostics()
        expect(state.model.items).toHaveLength(3)
        expect(diagnostics.rows).toHaveLength(3)
        expect(diagnostics.rows).toEqual(initialRows)
        expect(diagnostics.mountedPhysicalRows).toBeLessThanOrEqual(3)
      }),
    { timeout: 60_000 },
  )
})
