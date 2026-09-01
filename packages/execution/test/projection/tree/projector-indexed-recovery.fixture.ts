import { describe, expect, it } from "@effect/vitest"
import { RunEvent } from "generalist/runtime"
import { TreeProjector } from "../../../src/projection/tree/projector"
import type { CheckpointInstrumentation } from "../../../src/projection/tree/projector-recovery"
import { Response } from "effect/unstable/ai"
import { Schema } from "effect"
import { modelResponse, resetEventPosition, treeEvent } from "../../support/projector-event.fixture"

const CheckpointState = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      tools: Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown])),
    }),
  ),
  runningCompactions: Schema.optionalKey(Schema.Array(Schema.String)),
})

type RunEventInput = {
  [Tag in RunEvent.RunEvent["_tag"]]: Partial<Extract<RunEvent.RunEvent, { readonly _tag: Tag }>> & {
    readonly _tag: Tag
  }
}[RunEvent.RunEvent["_tag"]]
const runEvent = (event: RunEventInput): RunEventInput => event

describe("Generalist tree projector indexed recovery", () => {
  it("checkpoints indexed recovery without visiting settled history and restores the next patch exactly", () => {
    resetEventPosition()
    const visits = new Map<string, number>()
    const instrumentation: CheckpointInstrumentation = {
      visit: (kind) => visits.set(kind, (visits.get(kind) ?? 0) + 1),
    }
    const projector = TreeProjector.make(
      "turn-incremental-checkpoint",
      "incremental",
      undefined,
      [],
      false,
      "metered",
      instrumentation,
    )
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    for (let index = 0; index < 1_000; index += 1) {
      projector.apply(modelResponse("raw-root-run", { type: "text", text: `settled-${index}`, metadata: {} }))
      projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: index + 1 }))
    }
    const call = {
      type: "tool-call" as const,
      id: "active-tool",
      name: "bash",
      params: { command: "bun test" },
      providerExecuted: false,
      metadata: {},
    }
    projector.apply(
      treeEvent(
        "raw-root-run",
        runEvent({
          _tag: "ToolExecutionStarted",
          turn: 1_000,
          call: Response.toolCallPart(call),
        }),
      ),
    )
    projector.apply(treeEvent("raw-root-run", { _tag: "CompactionStarted", compactionId: "active-compaction" }))
    visits.clear()
    const active = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolProgress",
        turn: 1_000,
        toolCallId: "active-tool",
        message: "one",
        data: {},
      }),
    )
    expect(active.revision).toBeGreaterThan(2_000)
    expect(active.upsert).toMatchObject([{ content: { _tag: "Block", block: { _tag: "ToolCall" } } }])
    expect(Object.fromEntries(visits)).toMatchObject({ node: 1, tool: 1, compaction: 1 })
    const persisted = Schema.decodeSync(Schema.fromJsonString(CheckpointState))(active.checkpoint.state)
    expect(persisted.nodes.flatMap((node) => node.tools.map(([rawId]) => rawId))).toMatchObject(["active-tool"])
    expect(persisted.runningCompactions).toHaveLength(1)

    const resumed = TreeProjector.make(
      "turn-incremental-checkpoint",
      "incremental",
      active.checkpoint,
      projector.snapshot().units,
    )
    const next = treeEvent("raw-root-run", {
      _tag: "ToolProgress",
      turn: 1_000,
      toolCallId: "active-tool",
      message: "two",
      data: {},
    })
    const livePatch = projector.apply(next)
    const resumedPatch = resumed.apply(next)
    expect(resumedPatch).toEqual(livePatch)
    expect(resumed.snapshot()).toEqual(projector.snapshot())
  })
})
