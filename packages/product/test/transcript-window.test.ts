import * as ExecutionProjection from "@rika/product/execution-projection"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { recordedShellProjection } from "@rika/transcript/recorded-shell-presentation"
import { initialTranscriptWindow } from "../src/operation/interactive/transcript-window"
import { makeSelectionState } from "../src/operation/interactive/interactive-thread-selection"

const thread: Thread.Thread = {
  id: Thread.ThreadId.make("thread-shell-window"),
  workspace: "/work",
  title: "shell",
  pinned: false,
  archived: false,
  labels: [],
  createdAt: 1,
  updatedAt: 1,
}
const turn = {
  _tag: "RecordedShell" as const,
  id: Turn.TurnId.make("shell-window"),
  threadId: thread.id,
  prompt: "$ echo done",
  command: "echo done",
  status: "completed" as const,
  result: { text: "done", truncated: false, exitCode: 0 },
  author: { _tag: "Human" as const },
  lineage: { _tag: "Original" as const },
  createdAt: 2,
  updatedAt: 3,
}

it.effect("derives a terminal recorded shell from its authoritative Turn instead of a stale running read model", () =>
  Effect.gen(function* () {
    const stale = recordedShellProjection({ id: turn.id, command: turn.command, status: "running" })
    const window = yield* initialTranscriptWindow({
      state: makeSelectionState(thread, 1),
      turns: {
        page: () =>
          Effect.succeed({ turns: [turn], hasOlder: false, oldestCursor: undefined, newestCursor: undefined }),
      },
      transcripts: {
        get: () =>
          Effect.succeed({
            turn,
            units: stale.units,
            revision: stale.revision,
            checkpointGeneration: 0,
            projectionVersion: 1,
            state: {
              status: "running",
              usage: ExecutionProjection.emptyUsageState(),
              steering: { steeringMessages: 0, followUpMessages: 0 },
            },
          }),
        usage: () => Effect.succeed({ usage: { ...ExecutionProjection.emptyUsageState(), sourceComplete: true } }),
      },
      encodeJson: (value) => JSON.stringify(value),
      fail: (message) => Effect.die(message),
    })
    expect(window.entries).toHaveLength(1)
    expect(window.entries[0]?.unit.content).toMatchObject({ block: { status: "complete", output: "done" } })
  }),
)

it.effect("keeps every SubagentCard whose children are retained when a 125-unit Turn exceeds the window", () =>
  Effect.gen(function* () {
    const windowTurn: Turn.AgentExecutionTurn = {
      _tag: "AgentExecution",
      id: Turn.TurnId.make("window-agent"),
      threadId: thread.id,
      prompt: "Use subagents to explore this project.",
      executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
      status: "failed",
      author: { _tag: "Human" },
      lineage: { _tag: "Original" },
      createdAt: 2,
      updatedAt: 3,
    }
    const card = (id: string, name: string, status: "complete" | "failed") => ({
      _tag: "Block" as const,
      block: {
        _tag: "SubagentCard" as const,
        id,
        name,
        prompt: name,
        promptTruncated: false,
        summary: "",
        status,
        activity: [],
      },
    })
    const units: Array<TranscriptUnit.Unit> = [
      {
        key: "prompt",
        turnId: String(windowTurn.id),
        order: [{ sequence: 0, part: 0, key: "prompt" }],
        revision: 1,
        content: { _tag: "Entry" as const, role: "user" as const, text: "Use subagents to explore this project." },
      },
      {
        key: "root-reasoning",
        turnId: String(windowTurn.id),
        order: [{ sequence: 1, part: 0, key: "root-reasoning" }],
        revision: 1,
        content: { _tag: "Block" as const, block: { _tag: "Reasoning" as const, text: "plan", hidden: false } },
      },
      {
        key: "task-card",
        turnId: String(windowTurn.id),
        order: [{ sequence: 2, part: 0, key: "task-card" }],
        revision: 1,
        content: card("card-task", "Task", "complete"),
      },
    ]
    for (let index = 0; index < 15; index += 1)
      units.push({
        key: `task-child-${index}`,
        turnId: String(windowTurn.id),
        order: [{ sequence: 3 + index, part: 0, key: `task-child-${index}` }],
        revision: 1,
        parentId: "card-task",
        content: { _tag: "Entry" as const, role: "assistant" as const, text: `task ${index}` },
      })
    units.push(
      {
        key: "librarian-card",
        turnId: String(windowTurn.id),
        order: [{ sequence: 18, part: 0, key: "librarian-card" }],
        revision: 1,
        content: card("card-librarian", "Librarian", "complete"),
      },
      {
        key: "review-card",
        turnId: String(windowTurn.id),
        order: [{ sequence: 25, part: 0, key: "review-card" }],
        revision: 1,
        content: card("card-review", "Review", "failed"),
      },
      {
        key: "review-retry-card",
        turnId: String(windowTurn.id),
        order: [{ sequence: 72, part: 0, key: "review-retry-card" }],
        revision: 1,
        content: card("card-review-retry", "Review", "failed"),
      },
    )
    for (let index = 73; index < 125; index += 1)
      units.push({
        key: `retry-child-${index}`,
        turnId: String(windowTurn.id),
        order: [{ sequence: index, part: 0, key: `retry-child-${index}` }],
        revision: 1,
        parentId: "card-review-retry",
        content: { _tag: "Entry" as const, role: "assistant" as const, text: `retry ${index}` },
      })
    const window = yield* initialTranscriptWindow({
      state: makeSelectionState(thread, 1),
      turns: {
        page: () =>
          Effect.succeed({ turns: [windowTurn], hasOlder: false, oldestCursor: undefined, newestCursor: undefined }),
      },
      transcripts: {
        get: () =>
          Effect.succeed({
            turn: windowTurn,
            units,
            revision: 1,
            checkpointGeneration: 0,
            projectionVersion: ExecutionProjection.projectionVersion,
            state: {
              status: "failed",
              usage: ExecutionProjection.emptyUsageState(),
              steering: { steeringMessages: 0, followUpMessages: 0 },
            },
          }),
        usage: () => Effect.succeed({ usage: { ...ExecutionProjection.emptyUsageState(), sourceComplete: true } }),
      },
      encodeJson: (value) => JSON.stringify(value),
      fail: (message) => Effect.die(message),
    })
    const keys = window.entries.map((entry) => entry.unit.key)
    for (const cardKey of ["task-card", "librarian-card", "review-card", "review-retry-card"])
      expect(keys).toContain(cardKey)
    expect(keys).toContain("prompt")
    expect(window.entries.length).toBe(units.length)
    const parentIds = new Set(units.filter((value) => value.parentId !== undefined).map((value) => value.parentId))
    const retainedParents = new Set(
      window.entries
        .filter((entry) => entry.unit.content._tag === "Block")
        .flatMap((entry) => (entry.unit.content.block._tag === "SubagentCard" ? [entry.unit.content.block.id] : [])),
    )
    for (const entry of window.entries)
      if (entry.unit.parentId !== undefined) expect(retainedParents.has(entry.unit.parentId)).toBe(true)
    expect(Array.from(parentIds).every((id) => retainedParents.has(id))).toBe(true)
  }),
)

it.effect("pages every Turn page and delivers the full timeline oldest-first with edge cursors", () =>
  Effect.gen(function* () {
    const turnFor = (id: string, createdAt: number): Turn.AgentExecutionTurn => ({
      _tag: "AgentExecution",
      id: Turn.TurnId.make(id),
      threadId: thread.id,
      prompt: `prompt ${id}`,
      executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
      status: "completed",
      author: { _tag: "Human" },
      lineage: { _tag: "Original" },
      createdAt,
      updatedAt: createdAt,
    })
    const oldest = turnFor("turn-a", 1)
    const middle = turnFor("turn-b", 2)
    const newest = turnFor("turn-c", 3)
    const projection = (agentTurn: Turn.AgentExecutionTurn, key: string) => ({
      turn: agentTurn,
      units: [
        {
          key,
          turnId: String(turn.id),
          order: [{ sequence: 0, part: 0, key }],
          revision: 1,
          content: { _tag: "Entry" as const, role: "assistant" as const, text: `answer ${key}` },
        },
      ],
      revision: 1,
      checkpointGeneration: 0,
      projectionVersion: ExecutionProjection.projectionVersion,
      state: {
        status: "completed" as const,
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    })
    const window = yield* initialTranscriptWindow({
      state: makeSelectionState(thread, 1),
      turns: {
        page: (threadId, options) => {
          if (options?.before === undefined)
            return Effect.succeed({
              turns: [middle, newest],
              hasOlder: true,
              oldestCursor: { createdAt: middle.createdAt, id: middle.id },
              newestCursor: { createdAt: newest.createdAt, id: newest.id },
            })
          expect(options.before).toEqual({ createdAt: middle.createdAt, id: middle.id })
          return Effect.succeed({
            turns: [oldest],
            hasOlder: false,
            oldestCursor: { createdAt: oldest.createdAt, id: oldest.id },
            newestCursor: { createdAt: oldest.createdAt, id: oldest.id },
          })
        },
      },
      transcripts: {
        get: (turnId) => {
          if (String(turnId) === String(oldest.id)) return Effect.succeed(projection(oldest, "oldest-unit"))
          if (String(turnId) === String(middle.id)) return Effect.succeed(projection(middle, "middle-unit"))
          return Effect.succeed(projection(newest, "newest-unit"))
        },
        usage: () => Effect.succeed({ usage: { ...ExecutionProjection.emptyUsageState(), sourceComplete: true } }),
      },
      encodeJson: (value) => JSON.stringify(value),
      fail: (message) => Effect.die(message),
    })
    expect(window.entries.map((entry) => entry.unit.key)).toEqual(["oldest-unit", "middle-unit", "newest-unit"])
    expect(window.hasOlder).toBe(false)
    expect(window.oldestCursor).toMatchObject({ createdAt: 1 })
    expect(window.newestCursor).toMatchObject({ createdAt: 3 })
  }),
)

it.effect("assembles pages newest-first so the byte cap retains the newest tail in chronological output", () =>
  Effect.gen(function* () {
    const total = 120
    const makeTurn = (createdAt: number): Turn.RecordedShellTurn => ({
      _tag: "RecordedShell",
      id: Turn.TurnId.make(`shell-${createdAt}`),
      threadId: thread.id,
      prompt: `$ echo ${createdAt}`,
      command: `echo ${createdAt}`,
      status: "completed",
      result: { text: `${createdAt}`.repeat(200_000), truncated: false, exitCode: 0 },
      author: { _tag: "Human" },
      lineage: { _tag: "Original" },
      createdAt,
      updatedAt: createdAt,
    })
    const all = Array.from({ length: total }, (_, index) => makeTurn(index + 1))
    const pageSize = 50
    const pages: Array<{ turns: Array<Turn.Turn>; hasOlder: boolean; oldestCursor: Turn.TurnId }> = []
    for (let end = total; end > 0; end -= pageSize) {
      const start = Math.max(1, end - pageSize + 1)
      pages.push({
        turns: all.slice(start - 1, end),
        hasOlder: start > 1,
        oldestCursor: all[start - 1]!.id,
      })
    }
    let pageIndex = 0
    const window = yield* initialTranscriptWindow({
      state: makeSelectionState(thread, 1),
      turns: {
        page: () => Effect.succeed(pages[pageIndex++]!),
      },
      transcripts: {
        get: () => Effect.void,
        usage: () => Effect.succeed({ usage: { ...ExecutionProjection.emptyUsageState(), sourceComplete: true } }),
      },
      encodeJson: (value) => JSON.stringify(value),
      fail: (message) => Effect.die(message),
    })
    // Chronological ascending output that retains the newest turns only.
    const firstId = window.entries[0]?.turn.id
    const lastId = window.entries.at(-1)?.turn.id
    expect(String(lastId)).toBe("shell-120")
    expect(window.hasOlder).toBe(true)
    const ordered = window.entries.map((entry) => entry.turn.createdAt)
    expect([...ordered].toSorted((a, b) => a - b)).toEqual(ordered)
    // The retained window is the newest tail (turn 120 present, turn 1 absent).
    expect(window.entries.some((entry) => String(entry.turn.id) === "shell-1")).toBe(false)
    expect(window.entries.length).toBeGreaterThanOrEqual(2)
    expect(firstId).toBeDefined()
  }),
)
