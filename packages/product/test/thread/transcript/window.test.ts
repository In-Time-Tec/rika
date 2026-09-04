import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Thread from "@rika/product/thread-record"
import type * as TranscriptPage from "@rika/product/transcript-page"
import { TurnId, type Turn } from "@rika/product/turn-record"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { completeLeadingTurn, loadTranscriptWindow } from "../../../src/thread/transcript/window"
import { maximumTranscriptPayloadBytes } from "../../../src/thread/transcript/bounds"
import { makeMemory } from "../../../src/thread/repository/transcript-memory/memory"
import { maximumTranscriptUnits } from "@rika/product/transcript-page"

const threadId = Thread.ThreadId.make("thread-window")
const olderTurnId = TurnId.make("turn-older")
const turnId = TurnId.make("turn-subagents")

const turn = (id: TurnId, createdAt: number): Turn => ({
  _tag: "RecordedShell",
  id,
  threadId,
  prompt: "$ true",
  command: "true",
  status: "completed",
  result: { text: "", truncated: false, exitCode: 0 },
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt,
  updatedAt: createdAt,
})

const projectionState: ExecutionProjection.ProjectionState = {
  status: "running",
  usage: ExecutionProjection.emptyUsageState(),
  steering: { steeringMessages: 0, followUpMessages: 0 },
}

const entryUnit = (id: TurnId, key: string, sequence: number, role: "user" | "assistant"): TranscriptUnit.Unit => ({
  key,
  turnId: id,
  order: TranscriptOrdering.unitOrder(key, sequence),
  revision: 1,
  content: { _tag: "Entry", role, text: key },
})

const card = (sequence: number, blockId: string): TranscriptUnit.Unit => ({
  key: `${blockId}:unit`,
  turnId,
  order: TranscriptOrdering.unitOrder(`${blockId}:unit`, sequence),
  revision: 1,
  content: {
    _tag: "Block",
    block: {
      _tag: "SubagentCard",
      id: blockId,
      name: "Task",
      prompt: blockId,
      promptTruncated: false,
      summary: "",
      status: "running",
      activity: [],
    },
  },
})

const childTool = (parent: TranscriptUnit.Unit, parentBlockId: string, index: number): TranscriptUnit.Unit => {
  const key = `${parentBlockId}:tool:${index}`
  return {
    key,
    turnId,
    parentId: parentBlockId,
    order: TranscriptOrdering.childOrder(parent.order, parentBlockId, TranscriptOrdering.unitOrder(key, index)),
    revision: 1,
    content: {
      _tag: "Block",
      block: {
        _tag: "ToolCall",
        id: key,
        name: "bash",
        input: "{}",
        status: "complete",
        presentation: { family: "shell", action: "shell", activeLabel: "Running", completeLabel: "Ran" },
        detail: `cmd ${index}`,
        files: [],
      },
    },
  }
}

// One turn: prompt, one assistant line, four subagent cards, each with many nested tool calls.
const prompt = entryUnit(turnId, `turn:${turnId}:user`, -1, "user")
const intro = entryUnit(turnId, "assistant:intro", 0, "assistant")
const cards = [1, 2, 3, 4].map((index) => card(index, `card-${index}`))
const children = cards.flatMap((cardUnit, cardIndex) =>
  Array.from({ length: 50 }, (_, index) => childTool(cardUnit, `card-${cardIndex + 1}`, index)),
)
const units = [prompt, intro, ...cards, ...children].toSorted((left, right) =>
  TranscriptOrdering.compareUnitOrder(left.order, right.order),
)

const entry = (unit: TranscriptUnit.Unit, record: Turn): TranscriptPage.Entry => ({
  turn: record,
  unit,
  projectionRevision: 7,
  projectionModelPhase: -1,
  projectionState,
})

const projection = (): TranscriptPage.Projection => ({
  turn: turn(turnId, 20),
  units,
  checkpointGeneration: 0,
  revision: 7,
  state: projectionState,
  projectionVersion: ExecutionProjection.projectionVersion,
})

it.effect("retains every member card when a page starts inside a grouped subagent", () =>
  Effect.gen(function* () {
    const group: TranscriptUnit.Unit = {
      ...card(1, "group"),
      content: {
        _tag: "Block",
        block: {
          _tag: "SubagentGroup",
          id: "group",
          name: "Task",
          status: "complete",
          settled: true,
          memberIds: ["card-1", "card-2", "card-3", "card-4"],
          counts: { total: 4, complete: 4, queued: 0, running: 0, waiting: 0, cancelling: 0, failed: 0, cancelled: 0 },
        },
      },
    }
    const members = cards.map((unit) => ({ ...unit, parentId: "group" }))
    const record = turn(turnId, 20)
    const page: TranscriptPage.Page = {
      entries: children.slice(-80).map((unit) => entry(unit, record)),
      hasOlder: true,
      hasNewer: false,
      oldestCursor: undefined,
      newestCursor: undefined,
      usage: { usage: ExecutionProjection.emptyUsageState() },
    }
    const completed = yield* completeLeadingTurn(page, {
      get: () => Effect.succeed({ ...projection(), units: [prompt, group, ...members, ...children] }),
    })
    for (const member of members) expect(completed.entries.map((item) => item.unit.key)).toContain(member.key)
    expect(completed.entries).toHaveLength(86)
  }),
)

it.effect("reads the bounded timeline beyond page and patch sizes from the repository", () =>
  Effect.gen(function* () {
    const timeline = Array.from({ length: 600 }, (_, index) => entryUnit(turnId, `answer:${index}`, index, "assistant"))
    const repository = yield* makeMemory({ initial: [{ ...projection(), units: timeline }] })
    const page = yield* loadTranscriptWindow(threadId, repository)
    expect(page.entries.map((item) => item.unit.key)).toEqual(timeline.map((unit) => unit.key))
    expect(page.hasOlder).toBe(false)
    expect((yield* Effect.result(repository.page(threadId, { limit: maximumTranscriptUnits + 1 })))._tag).toBe(
      "Failure",
    )
  }),
)

it.effect("bounds initial hosted-sized snapshots by bytes as well as unit count", () =>
  Effect.gen(function* () {
    const timeline: ReadonlyArray<TranscriptUnit.Unit> = Array.from({ length: 3 }, (_, index) => ({
      ...entryUnit(turnId, `large:${index}`, index, "assistant"),
      content: { _tag: "Entry", role: "assistant", text: "x".repeat(12 * 1024 * 1024) },
    }))
    const repository = yield* makeMemory({ initial: [{ ...projection(), units: timeline }] })
    const page = yield* loadTranscriptWindow(threadId, repository)
    expect(page.hasOlder).toBe(true)
    expect(page.entries.map((item) => item.unit.key)).toEqual(["large:1", "large:2"])
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(page.entries)
    expect(Buffer.byteLength(encoded)).toBeLessThan(maximumTranscriptPayloadBytes)
    expect(page.oldestCursor?.turnId).toBe(turnId)
  }),
)

it.effect("completeLeadingTurn adds only the structure a windowed turn is missing", () =>
  Effect.gen(function* () {
    const record = turn(turnId, 20)
    const window = (windowed: ReadonlyArray<TranscriptUnit.Unit>): TranscriptPage.Page => ({
      entries: windowed.map((unit) => entry(unit, record)),
      hasOlder: true,
      hasNewer: false,
      oldestCursor: undefined,
      newestCursor: undefined,
      usage: { usage: ExecutionProjection.emptyUsageState() },
    })
    const transcripts = { get: () => Effect.succeed(projection()) }
    // Only the children of the first card are windowed: every root unit is added, but no other card's children.
    const firstCardChildren = children.filter((unit) => unit.parentId === "card-1")
    const partial = yield* completeLeadingTurn(window(firstCardChildren), transcripts)
    const added = partial.entries
      .map((item) => item.unit.key)
      .filter((key) => !firstCardChildren.some((unit) => unit.key === key))
    expect(added).toEqual([prompt.key, intro.key, ...cards.map((unit) => unit.key)])
    // A window that already holds every unit of the turn but the prompt gains only the prompt.
    const withoutPrompt = yield* completeLeadingTurn(window(units.filter((unit) => unit !== prompt)), transcripts)
    expect(withoutPrompt.entries).toHaveLength(units.length)
    expect(withoutPrompt.entries[0]!.unit.key).toBe(prompt.key)
  }),
)

it.effect("completeLeadingTurn adds the prompt and parent cards when a page starts inside a turn", () =>
  Effect.gen(function* () {
    const record = turn(turnId, 20)
    const newest = children.slice(-120).map((unit) => entry(unit, record))
    let reads = 0
    const page: TranscriptPage.Page = {
      entries: newest,
      hasOlder: true,
      hasNewer: false,
      oldestCursor: { createdAt: 20, turnId, orderKey: TranscriptOrdering.encodeUnitOrder(newest[0]!.unit.order) },
      newestCursor: undefined,
      usage: { usage: ExecutionProjection.emptyUsageState() },
    }
    const completed = yield* completeLeadingTurn(page, {
      get: (requested) => {
        reads += 1
        expect(requested).toBe(turnId)
        return Effect.succeed(projection())
      },
    })
    expect(reads).toBe(1)
    const keys = completed.entries.map((item) => item.unit.key)
    expect(keys).toHaveLength(126)
    expect(keys.slice(0, 2)).toEqual([prompt.key, intro.key])
    for (const cardUnit of cards) expect(keys).toContain(cardUnit.key)
    expect(keys.at(-1)).toBe(children.at(-1)!.key)
    expect(completed.entries.every((item) => item.turn === record)).toBe(true)
    expect(completed.oldestCursor).toEqual(page.oldestCursor)
    expect(completed.hasOlder).toBe(true)
  }),
)

it.effect("completeLeadingTurn leaves pages alone when the leading turn already has its prompt", () =>
  Effect.gen(function* () {
    const olderRecord = turn(olderTurnId, 10)
    const record = turn(turnId, 20)
    const page: TranscriptPage.Page = {
      entries: [
        entry(entryUnit(olderTurnId, `turn:${olderTurnId}:user`, -1, "user"), olderRecord),
        entry(prompt, record),
        entry(intro, record),
      ],
      hasOlder: true,
      hasNewer: false,
      oldestCursor: undefined,
      newestCursor: undefined,
      usage: { usage: ExecutionProjection.emptyUsageState() },
    }
    const completed = yield* completeLeadingTurn(page, { get: () => Effect.die("must not read") })
    expect(completed).toBe(page)
    const full = { ...page, hasOlder: false, entries: [entry(intro, record)] }
    expect(yield* completeLeadingTurn(full, { get: () => Effect.die("must not read") })).toBe(full)
  }),
)
