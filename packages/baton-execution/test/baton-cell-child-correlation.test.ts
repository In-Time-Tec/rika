import { describe, expect, it } from "@effect/vitest"
import type { Block, Unit } from "@rika/product/execution-transcript-contract"
import { TreeProjector } from "../src/baton-tree-projector"
import { resetEventPosition, treeEvent } from "./baton-projector-event-fixtures"

type Cell = Extract<Block, { readonly _tag: "Cell" }>
type Card = Extract<Block, { readonly _tag: "SubagentCard" }>

const cellCall = (id: string, code: string) => ({
  type: "tool-call" as const,
  id,
  name: "typescript",
  params: { code },
  providerExecuted: false,
  metadata: {},
})

const started = (id: string, code: string) =>
  treeEvent("raw-root-run", { _tag: "ToolExecutionStarted", turn: 0, call: cellCall(id, code) } as never)

const invocationId = (input: {
  readonly toolCallId: string
  readonly key: string
  readonly origin?: { readonly operationKey: string; readonly ordinal: number }
}) =>
  input.origin === undefined
    ? `child-admit:${encodeURIComponent(input.toolCallId)}:${encodeURIComponent(input.key)}`
    : `child-admit:${encodeURIComponent(input.toolCallId)}:${encodeURIComponent(input.origin.operationKey)}#${input.origin.ordinal}:${encodeURIComponent(input.key)}`

const linked = (input: {
  readonly childRunId: string
  readonly invocationId: string
  readonly selection: string
  readonly prompt: string
}) =>
  treeEvent("raw-root-run", {
    _tag: "ChildLinked",
    childRunId: input.childRunId,
    invocationId: input.invocationId,
    selection: input.selection,
    prompt: [{ role: "user", content: [{ type: "text", text: input.prompt }] }],
  } as never)

const cellsOf = (units: ReadonlyArray<Unit>): ReadonlyArray<Cell> =>
  units.flatMap((unit) =>
    unit.content._tag === "Block" && unit.content.block._tag === "Cell" ? [unit.content.block] : [],
  )

const cardUnitsOf = (units: ReadonlyArray<Unit>) =>
  units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard")

const cardOf = (unit: Unit): Card => (unit.content as { readonly block: Card }).block

describe("Baton cell child correlation", () => {
  it("attaches a cell-spawned child card to its originating cell, ordered by the host ordinal", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-children", "spawn from a cell")
    projector.apply(started("cell-a", "await rika.agents.spawn({ profile: 'Oracle' })"))
    projector.apply(started("cell-b", "await rika.agents.spawn({ profile: 'Review' })"))
    const cells = cellsOf(projector.snapshot().units)
    expect(cells).toHaveLength(2)
    const operationKeyOf = (rawId: string) => `session:tool:0:0:${rawId}:typescript`
    projector.apply(
      linked({
        childRunId: "raw-child-second",
        invocationId: invocationId({
          toolCallId: "cell-a",
          key: "second",
          origin: { operationKey: operationKeyOf("cell-a"), ordinal: 1 },
        }),
        selection: "Surgeon",
        prompt: "Second spawn",
      }),
    )
    projector.apply(
      linked({
        childRunId: "raw-child-first",
        invocationId: invocationId({
          toolCallId: "cell-a",
          key: "first",
          origin: { operationKey: operationKeyOf("cell-a"), ordinal: 0 },
        }),
        selection: "Oracle",
        prompt: "First spawn",
      }),
    )
    projector.apply(
      linked({
        childRunId: "raw-child-other",
        invocationId: invocationId({
          toolCallId: "cell-b",
          key: "only",
          origin: { operationKey: operationKeyOf("cell-b"), ordinal: 0 },
        }),
        selection: "Review",
        prompt: "Other cell spawn",
      }),
    )
    const cards = cardUnitsOf(projector.snapshot().units)
    expect(cards).toHaveLength(3)
    const byParent = new Map<string, ReadonlyArray<string>>()
    for (const unit of cards)
      byParent.set(unit.parentId!, [...(byParent.get(unit.parentId!) ?? []), cardOf(unit).prompt])
    expect(byParent.get(cells[0]!.id)).toEqual(["First spawn", "Second spawn"])
    expect(byParent.get(cells[1]!.id)).toEqual(["Other cell spawn"])
  })

  it("falls back to the run node when the invocation carries no origin", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-no-origin", "no origin")
    projector.apply(started("cell-c", "await rika.agents.spawn({ profile: 'Oracle' })"))
    projector.apply(
      linked({
        childRunId: "raw-child-plain",
        invocationId: "plain-invocation",
        selection: "Oracle",
        prompt: "Unattached",
      }),
    )
    const cards = cardUnitsOf(projector.snapshot().units)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.parentId).toBeUndefined()
  })

  it("never reads cell source: a cell that mentions a spawn but emits no ChildLinked has zero cards", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-source-only", "source only")
    projector.apply(
      started(
        "cell-d",
        'const handle = await rika.agents.spawn({ profile: "Oracle" })\nconst other = rika.agents.spawn({ profile: "Review" })',
      ),
    )
    const snapshot = projector.snapshot()
    expect(cellsOf(snapshot.units)).toHaveLength(1)
    expect(cardUnitsOf(snapshot.units)).toHaveLength(0)
    expect(cellsOf(snapshot.units)[0]?.source.text).toContain('rika.agents.spawn({ profile: "Oracle" })')
  })

  it("keeps cell-attached cards after a checkpoint round-trip", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-cell-children-resume", "resume children")
    projector.apply(started("cell-e", "await rika.agents.spawn({ profile: 'Oracle' })"))
    const patch = projector.apply(
      linked({
        childRunId: "raw-child-resume",
        invocationId: invocationId({
          toolCallId: "cell-e",
          key: "only",
          origin: { operationKey: "session:tool:0:0:cell-e:typescript", ordinal: 0 },
        }),
        selection: "Oracle",
        prompt: "Resumed spawn",
      }),
    )
    const before = projector.snapshot().units
    const resumed = TreeProjector.make("turn-cell-children-resume", "resume children", patch.checkpoint, before)
    expect(resumed.snapshot().units).toEqual(before)
    const cards = cardUnitsOf(resumed.snapshot().units)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.parentId).toBe(cellsOf(before)[0]!.id)
  })
})
