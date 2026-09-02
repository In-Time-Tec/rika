import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Thread from "@rika/product/thread-record"
import type * as TranscriptPage from "@rika/product/transcript-page"
import { TurnId, type Turn } from "@rika/product/turn-record"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { completeLeadingTurn } from "../../../src/thread/transcript/window"

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
