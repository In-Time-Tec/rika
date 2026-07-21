import * as Transcript from "@rika/transcript"
import { describe, expect, it } from "vitest"
import { ExecutionEvents, TranscriptPresenter, ViewState } from "../src"
import { agentResponseState, unitId as transcriptUnitId, rows as transcriptUnits } from "../src/transcript-presenter"

const event = (
  cursor: string,
  sequence: number,
  type: string,
  fields: Partial<Transcript.SourceEvent> = {},
): Transcript.SourceEvent => ({ cursor, sequence, type, createdAt: sequence, ...fields })

const parentProjection = Transcript.project("turn", "prompt", [
  event("assistant-0", 0, "model.output.completed", { text: "Working on it." }),
  event("agent", 1, "tool.call.requested", {
    data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review the code" } },
  }),
  event("agent-spawned", 2, "child_run.spawned", {
    data: { tool_call_id: "agent", child_execution_id: "child:turn:oracle" },
  }),
])

const childProjection = Transcript.project("child:turn:oracle", "", [
  event("read", 0, "tool.call.requested", {
    data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
  }),
  event("read-result", 1, "tool.result.received", { data: { tool_call_id: "read", output: "contents" } }),
  event("nested-agent", 2, "tool.call.requested", {
    data: { tool_call_id: "nested", tool_name: "task", input: { prompt: "Dig deeper" } },
  }),
  event("nested-spawned", 3, "child_run.spawned", {
    data: { tool_call_id: "nested", child_execution_id: "child:child:turn:oracle:nested" },
  }),
])

const grandchildProjection = Transcript.project("child:child:turn:oracle:nested", "", [
  event("shell", 0, "tool.call.requested", {
    data: { tool_call_id: "shell", tool_name: "bash", input: { command: "bun test" } },
  }),
  event("shell-result", 1, "tool.result.received", { data: { tool_call_id: "shell", output: "passed" } }),
])

const nestedModel = () => {
  let model = TranscriptPresenter.applyTurnUnits(ViewState.initial("/work"), parentProjection.units)
  model = TranscriptPresenter.applyChildUnits(model, "turn:agent", childProjection.units)
  model = TranscriptPresenter.applyChildUnits(model, "child:turn:oracle:nested", grandchildProjection.units)
  return model
}

describe("TranscriptPresenter", () => {
  it("projects turn units identically to the legacy projection", () => {
    const legacy = ExecutionEvents.projectUnits(ViewState.initial("/work"), parentProjection.units)
    const presenter = TranscriptPresenter.applyTurnUnits(ViewState.initial("/work"), parentProjection.units)
    expect(presenter).toEqual(legacy)
  })

  it("flattens nested rows identically to the legacy unit tree", () => {
    const model = nestedModel()
    const legacyUnits = transcriptUnits(model)
    const rows = TranscriptPresenter.rows(model)
    expect(rows).toEqual(legacyUnits)
    expect(rows.map((unit) => TranscriptPresenter.unitId(model, unit))).toEqual(
      legacyUnits.map((unit) => transcriptUnitId(model, unit)),
    )
  })

  it("keeps nested subagent rows at depth two with stable ids", () => {
    const model = nestedModel()
    const units = TranscriptPresenter.rows(model)
    const parent = units.find((unit) => unit.kind === "tool" && unit.children !== undefined)
    expect(parent?.kind).toBe("tool")
    const children = parent?.kind === "tool" ? (parent.children ?? []) : []
    expect(children.some((child) => (child.children?.length ?? 0) > 0)).toBe(true)
  })

  it("projects the same units twice into deep-equal models", () => {
    const once = nestedModel()
    const twice = TranscriptPresenter.applyTurnUnits(once, parentProjection.units)
    expect(twice).toEqual(once)
  })

  it("attaches child projections to their parent rows and skips replay turns", () => {
    const base = TranscriptPresenter.applyTurnUnits(ViewState.initial("/work"), parentProjection.units)
    const projections = new Map([
      ["child:turn:oracle", childProjection],
      ["child:child:turn:oracle:nested", grandchildProjection],
      ["orphan-turn", grandchildProjection],
    ])
    const attached = TranscriptPresenter.attachChildProjections(base, new Set<string>(), projections)
    const expected = TranscriptPresenter.applyChildUnits(
      TranscriptPresenter.applyChildUnits(base, "turn:agent", childProjection.units),
      "child:turn:oracle:nested",
      grandchildProjection.units,
    )
    expect(attached.model).toEqual(expected)
    expect(attached.attachments.get("child:turn:oracle")).toBe(childProjection.revision)
    const replaySkipped = TranscriptPresenter.attachChildProjections(
      base,
      new Set(["child:turn:oracle", "child:child:turn:oracle:nested"]),
      projections,
    )
    expect(replaySkipped.model).toBe(base)
  })

  it("returns the same model object for a no-op projection", () => {
    const once = nestedModel()
    expect(TranscriptPresenter.applyTurnUnits(once, parentProjection.units)).toBe(once)
  })

  it("preserves untouched array elements when one unit changes", () => {
    const base = TranscriptPresenter.applyTurnUnits(ViewState.initial("/work"), parentProjection.units)
    const next = Transcript.applyEvent(
      parentProjection,
      event("agent-result", 3, "tool.result.received", { data: { tool_call_id: "agent", output: "done" } }),
    )
    const updated = TranscriptPresenter.applyTurnUnits(base, next.units)
    expect(updated).not.toBe(base)
    expect(updated.entries).toBe(base.entries)
    expect(updated.items).toBe(base.items)
    expect(updated.blocks).not.toBe(base.blocks)
    const changed = updated.blocks.filter((block, index) => block !== base.blocks[index])
    expect(changed).toHaveLength(1)
  })

  it("keeps an applied child outcome when the parent's stale units reproject", () => {
    const failedChild = Transcript.project("child:turn:oracle", "", [
      event("read", 0, "tool.call.requested", {
        data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
      }),
      event("fail", 1, "execution.failed", { data: { reason: "boom" } }),
    ])
    let model = TranscriptPresenter.applyTurnUnits(ViewState.initial("/work"), parentProjection.units)
    model = TranscriptPresenter.applyChildUnits(model, "turn:agent", failedChild.units)
    const parentTool = (candidate: ViewState.Model) =>
      (candidate.blocks as ReadonlyArray<Transcript.Block>).find(
        (block) => block._tag === "ToolCall" && block.id === "turn:agent",
      ) as Extract<Transcript.Block, { _tag: "ToolCall" }>
    expect(parentTool(model).status).toBe("failed")
    const reprojected = TranscriptPresenter.applyTurnUnits(model, parentProjection.units)
    expect(parentTool(reprojected).status).toBe("failed")
    expect(TranscriptPresenter.applyTurnUnits(reprojected, parentProjection.units)).toBe(reprojected)
  })

  it("rewrites running rows to cancelled when a cancellation notice projects", () => {
    const cancelled = Transcript.applyEvent(
      parentProjection,
      event("cancel", 3, "execution.cancelled", { data: { reason: "stop" } }),
    )
    const model = TranscriptPresenter.applyTurnUnits(nestedModel(), cancelled.units)
    const tool = (model.blocks as ReadonlyArray<Transcript.Block>).find(
      (block) => block._tag === "ToolCall" && block.id === "turn:agent",
    ) as Extract<Transcript.Block, { _tag: "ToolCall" }>
    expect(tool.status).toBe("cancelled")
  })

  it("skips attachments whose revision is unchanged and re-attaches on bump", () => {
    const base = TranscriptPresenter.applyTurnUnits(ViewState.initial("/work"), parentProjection.units)
    const projections = new Map([["child:turn:oracle", childProjection]])
    const first = TranscriptPresenter.attachChildProjections(base, new Set<string>(), projections)
    const second = TranscriptPresenter.attachChildProjections(
      first.model,
      new Set<string>(),
      projections,
      first.attachments,
    )
    expect(second.model).toBe(first.model)
    expect(second.attachments).toBe(first.attachments)
    const bumped = Transcript.applyEvent(childProjection, event("more", 4, "model.output.delta", { text: "hi" }))
    const third = TranscriptPresenter.attachChildProjections(
      second.model,
      new Set<string>(),
      new Map([["child:turn:oracle", bumped]]),
      second.attachments,
    )
    expect(third.model).not.toBe(second.model)
    expect(third.attachments.get("child:turn:oracle")).toBe(bumped.revision)
    const cleared = TranscriptPresenter.attachChildProjections(
      third.model,
      new Set<string>(),
      new Map([["child:turn:oracle", bumped]]),
      TranscriptPresenter.emptyAttachments,
    )
    expect(cleared.attachments.get("child:turn:oracle")).toBe(bumped.revision)
  })

  it("keeps expandable row ids stable across reprojection", () => {
    const model = nestedModel()
    const before = TranscriptPresenter.expandableRowIds(model)
    const after = TranscriptPresenter.expandableRowIds(
      TranscriptPresenter.applyTurnUnits(model, parentProjection.units),
    )
    expect(after).toEqual(before)
    expect(before.length).toBeGreaterThan(0)
  })
})

const childTurnId = (child: number) => `child:turn:agent-${child}`

describe("TranscriptPresenter at scale", () => {
  const childCount = 200
  const toolsPerChild = 20
  const largeParent = Transcript.project("turn", "prompt", [
    event("assistant-0", 0, "model.output.completed", { text: "Fanning out." }),
    ...Array.from({ length: childCount }, (_, child) => [
      event(`agent-${child}`, 1 + child * 2, "tool.call.requested", {
        data: { tool_call_id: `agent-${child}`, tool_name: "task", input: { prompt: `Task ${child}` } },
      }),
      event(`agent-${child}-spawned`, 2 + child * 2, "child_run.spawned", {
        data: { tool_call_id: `agent-${child}`, child_execution_id: childTurnId(child) },
      }),
    ]).flat(),
  ])
  const childProjections = new Map(
    Array.from({ length: childCount }, (_, child) => {
      const events = Array.from({ length: toolsPerChild }, (__, tool) => {
        const requested = event(`tool-${child}-${tool}`, tool * 2, "tool.call.requested", {
          data: {
            tool_call_id: `tool-${child}-${tool}`,
            tool_name: "read",
            input: { path: `src/${child}/${tool}.ts` },
          },
        })
        return tool === toolsPerChild - 1
          ? [requested]
          : [
              requested,
              event(`tool-${child}-${tool}-result`, tool * 2 + 1, "tool.result.received", {
                data: { tool_call_id: `tool-${child}-${tool}`, output: "contents" },
              }),
            ]
      }).flat()
      return [
        childTurnId(child),
        Transcript.project(childTurnId(child), "", [
          ...events,
          event(`answer-${child}`, toolsPerChild * 2, "model.output.completed", { text: `Child ${child} finished.` }),
        ]),
      ] as const
    }),
  )
  const attachedSession = () => {
    const base = TranscriptPresenter.applyTurnUnits(ViewState.initial("/work"), largeParent.units)
    return TranscriptPresenter.attachChildProjections(base, new Set<string>(), childProjections)
  }

  it("re-applies every unchanged projection as a full no-op", () => {
    const session = attachedSession()
    expect(session.model.items.length).toBeGreaterThan(4000)
    const reapplied = TranscriptPresenter.attachChildProjections(
      TranscriptPresenter.applyTurnUnits(session.model, largeParent.units),
      new Set<string>(),
      childProjections,
      session.attachments,
    )
    expect(reapplied.model).toBe(session.model)
    expect(reapplied.attachments).toBe(session.attachments)
  })

  it("changes only the dirty child's rows when one child streams a delta", () => {
    const session = attachedSession()
    const bumped = Transcript.applyEvent(
      childProjections.get(childTurnId(120))!,
      event(`tool-120-${toolsPerChild - 1}-result`, toolsPerChild * 2 + 1, "tool.result.received", {
        data: { tool_call_id: `tool-120-${toolsPerChild - 1}`, output: "late result" },
      }),
    )
    const next = TranscriptPresenter.attachChildProjections(
      session.model,
      new Set<string>(),
      new Map([...childProjections, [childTurnId(120), bumped]]),
      session.attachments,
    )
    expect(next.model).not.toBe(session.model)
    expect(next.model.entries).toBe(session.model.entries)
    expect(next.model.items).toBe(session.model.items)
    const changedBlocks = next.model.blocks.filter((block, index) => block !== session.model.blocks[index])
    expect(changedBlocks.length).toBeGreaterThan(0)
    expect(changedBlocks.length).toBeLessThanOrEqual(2)
    expect(next.attachments.get(childTurnId(120))).toBe(bumped.revision)
  })

  it("reuses the memoized row flattening for an identical model", () => {
    const session = attachedSession()
    expect(TranscriptPresenter.rows(session.model)).toBe(TranscriptPresenter.rows(session.model))
    const ids = TranscriptPresenter.expandableRowIds(session.model)
    expect(ids.length).toBeGreaterThanOrEqual(childCount)
    expect(TranscriptPresenter.expandableRowIds(session.model)).toEqual(ids)
  })
})

const agentTool = (
  status: "running" | "complete" | "failed" | "cancelled",
  output?: string,
): Extract<Transcript.Block, { _tag: "ToolCall" }> => ({
  _tag: "ToolCall",
  id: "agent",
  name: "task",
  input: "{}",
  status,
  presentation: {
    family: "agent",
    action: "task",
    activeLabel: "Subagent working",
    completeLabel: "Subagent finished",
  },
  detail: "Do the thing",
  files: [],
  ...(output === undefined ? {} : { output }),
})

const agentScenario = (opts: {
  readonly status: "running" | "complete" | "failed" | "cancelled"
  readonly answer?: string
  readonly errorDetail?: string
  readonly output?: string
  readonly outcomeReason?: string
}) => {
  const tool = agentTool(opts.status, opts.output)
  const entries: Array<ViewState.Entry> = []
  const blocks: Array<Transcript.Block> = [tool]
  const items: Array<ViewState.TranscriptItem> = [{ _tag: "Block", index: 0, id: "tool:agent" }]
  const children: Array<ViewState.TranscriptItem> = []
  if (opts.answer !== undefined) {
    entries.push({ role: "assistant", text: opts.answer })
    const item: ViewState.TranscriptItem = {
      _tag: "Entry",
      index: entries.length - 1,
      id: `answer:${entries.length - 1}`,
      parentId: "agent",
    }
    items.push(item)
    children.push(item)
  }
  if (opts.errorDetail !== undefined) {
    blocks.push({ _tag: "Error", title: "Subagent failed", detail: opts.errorDetail })
    const item: ViewState.TranscriptItem = {
      _tag: "Block",
      index: blocks.length - 1,
      id: `error:${blocks.length - 1}`,
      parentId: "agent",
    }
    items.push(item)
    children.push(item)
  }
  const model: ViewState.Model = {
    ...ViewState.initial("/work"),
    entries,
    blocks,
    items,
    ...(opts.outcomeReason === undefined
      ? {}
      : { childExecutionOutcomes: { agent: { status: "failed", reason: opts.outcomeReason } } }),
  }
  return { model, tool, children }
}

const responseStateOf = (opts: Parameters<typeof agentScenario>[0]) => {
  const { model, tool, children } = agentScenario(opts)
  return agentResponseState(model, tool, children)
}

const childContent = ["answer", "error", "both", "neither"] as const

const optsFor = (
  status: "running" | "complete" | "failed" | "cancelled",
  content: (typeof childContent)[number],
): Parameters<typeof agentScenario>[0] => ({
  status,
  ...(content === "answer" || content === "both" ? { answer: "Final answer." } : {}),
  ...(content === "error" || content === "both" ? { errorDetail: "explosion in the reactor" } : {}),
})

describe("agentResponseState", () => {
  const settled = ["complete", "failed", "cancelled"] as const

  it("exposes a growing answer while the agent remains running", () => {
    expect(responseStateOf({ status: "running", answer: "hel" })).toEqual({ _tag: "Streaming", answer: 0 })
    expect(responseStateOf({ status: "running", answer: "hello" })).toEqual({ _tag: "Streaming", answer: 0 })
  })

  for (const content of ["error", "neither"] as const)
    it(`gives a running row without an answer no response state (${content})`, () => {
      expect(responseStateOf(optsFor("running", content))).toBeUndefined()
    })

  for (const status of settled)
    for (const content of childContent)
      it(`gives a settled ${status} row exactly one non-empty outcome (${content})`, () => {
        const state = responseStateOf(optsFor(status, content))
        expect(state?._tag).toBe("Settled")
        if (state?._tag !== "Settled") return
        if (state.outcome.kind === "error") expect(state.outcome.text.trim().length).toBeGreaterThan(0)
        else expect(state.outcome.kind).toBe("answer")
      })

  it("keeps a completed answer and ignores a stray error child when an answer exists", () => {
    expect(responseStateOf({ status: "complete", answer: "All done.", errorDetail: "ignored" })).toEqual({
      _tag: "Settled",
      outcome: { kind: "answer", entry: 0 },
    })
    expect(responseStateOf({ status: "complete", answer: "All done." })).toEqual({
      _tag: "Settled",
      outcome: { kind: "answer", entry: 0 },
    })
  })

  it("always fails a failed row even when a non-empty answer exists", () => {
    const state = responseStateOf({ status: "failed", answer: "partial work", errorDetail: "boom" })
    expect(state).toEqual({ _tag: "Settled", outcome: { kind: "error", tone: "failed", text: "boom" } })
  })

  it("prefers an Error child's detail over the copied tool output on a failed row", () => {
    const state = responseStateOf({ status: "failed", errorDetail: "disk is full", output: "stale copied output" })
    expect(state).toEqual({
      _tag: "Settled",
      outcome: { kind: "error", tone: "failed", text: "disk is full" },
    })
  })

  it("falls back to the remembered execution reason when no Error child exists", () => {
    const state = responseStateOf({ status: "failed", outcomeReason: "network exploded", output: "raw" })
    expect(state).toEqual({
      _tag: "Settled",
      outcome: { kind: "error", tone: "failed", text: "network exploded" },
    })
  })

  it("extracts text from a JSON-object output instead of showing raw JSON or blank", () => {
    const output = JSON.stringify({ output: [{ text: "the child reported this failure" }] })
    const state = responseStateOf({ status: "failed", output })
    expect(state).toEqual({
      _tag: "Settled",
      outcome: { kind: "error", tone: "failed", text: "the child reported this failure" },
    })
  })

  it("uses a non-blank default when the only failure data is an opaque JSON object", () => {
    const state = responseStateOf({ status: "failed", output: JSON.stringify({ code: 42 }) })
    expect(state?._tag).toBe("Settled")
    if (state?._tag === "Settled" && state.outcome.kind === "error") {
      expect(state.outcome.text.trim().length).toBeGreaterThan(0)
      expect(state.outcome.text).not.toContain("{")
    }
  })

  it("marks a completed row with only empty assistant text as a non-blank info terminal", () => {
    const state = responseStateOf({ status: "complete", answer: "   " })
    expect(state?._tag).toBe("Settled")
    if (state?._tag === "Settled" && state.outcome.kind === "error") {
      expect(state.outcome.tone).toBe("info")
      expect(state.outcome.text.trim().length).toBeGreaterThan(0)
    }
  })

  it("cancels with the cancellation reason when no answer survives", () => {
    const withReason = responseStateOf({ status: "cancelled", outcomeReason: "user stopped the run" })
    expect(withReason).toEqual({
      _tag: "Settled",
      outcome: { kind: "error", tone: "cancelled", text: "user stopped the run" },
    })
    const bare = responseStateOf({ status: "cancelled" })
    expect(bare?._tag).toBe("Settled")
    if (bare?._tag === "Settled" && bare.outcome.kind === "error") {
      expect(bare.outcome.tone).toBe("cancelled")
      expect(bare.outcome.text.trim().length).toBeGreaterThan(0)
    }
  })

  it("keeps a cancelled row's answer when a non-empty one exists", () => {
    expect(responseStateOf({ status: "cancelled", answer: "got this far" })).toEqual({
      _tag: "Settled",
      outcome: { kind: "answer", entry: 0 },
    })
  })
})

describe("nested subagent rows", () => {
  it("emits only ToolCall children as rows while assistant and error children feed the terminal", () => {
    const parent = agentTool("complete")
    const nested: Extract<Transcript.Block, { _tag: "ToolCall" }> = {
      _tag: "ToolCall",
      id: "nested-read",
      name: "read",
      input: JSON.stringify({ path: "src/a.ts" }),
      status: "complete",
      presentation: { family: "explore", action: "read", activeLabel: "Reading", completeLabel: "Read" },
      detail: "src/a.ts",
      files: [],
    }
    const model: ViewState.Model = {
      ...ViewState.initial("/work"),
      entries: [{ role: "assistant", text: "child answer" }],
      blocks: [parent, nested, { _tag: "Error", title: "warn", detail: "a soft error" }],
      items: [
        { _tag: "Block", index: 0, id: "tool:agent" },
        { _tag: "Block", index: 1, id: "block:nested-read", parentId: "agent" },
        { _tag: "Entry", index: 0, id: "answer:0", parentId: "agent" },
        { _tag: "Block", index: 2, id: "block:error", parentId: "agent" },
      ],
    }
    const units = transcriptUnits(model)
    const parentUnit = units.find((unit) => unit.kind === "tool")
    expect(parentUnit?.kind).toBe("tool")
    if (parentUnit?.kind !== "tool") throw new Error("expected tool unit")
    expect(parentUnit.children).toHaveLength(1)
    expect(parentUnit.children?.[0]?.blocks).toEqual([1])
    expect(parentUnit.agentResponse).toEqual({ _tag: "Settled", outcome: { kind: "answer", entry: 0 } })
  })
})

describe("row window math", () => {
  const limit = 240
  it("resolves a pinned window to the full total and clamps explicit ends", () => {
    expect(TranscriptPresenter.resolveRowEnd(TranscriptPresenter.pinnedRowWindow, 500, limit)).toBe(500)
    expect(TranscriptPresenter.resolveRowEnd({ end: 900, pendingDelta: 0 }, 500, limit)).toBe(500)
    expect(TranscriptPresenter.resolveRowEnd({ end: 100, pendingDelta: 0 }, 500, limit)).toBe(240)
  })
  it("shifts within bounds and stops at the window minimum", () => {
    expect(TranscriptPresenter.shiftRowEnd(TranscriptPresenter.pinnedRowWindow, -100, 500, limit)).toBe(400)
    expect(TranscriptPresenter.shiftRowEnd({ end: 250, pendingDelta: 0 }, -100, 500, limit)).toBe(240)
    expect(TranscriptPresenter.shiftRowEnd({ end: 400, pendingDelta: 0 }, 200, 500, limit)).toBe(500)
    expect(TranscriptPresenter.shiftRowEnd(TranscriptPresenter.pinnedRowWindow, -100, 200, limit)).toBe(200)
  })
  it("relocates around the anchor row and applies the pending shift", () => {
    expect(TranscriptPresenter.relocateRowEnd({ end: 301, pendingDelta: -100, anchorKey: "k" }, 61, 301, limit)).toBe(
      240,
    )
    expect(TranscriptPresenter.relocateRowEnd({ end: 400, pendingDelta: 0, anchorKey: "k" }, 200, 500, limit)).toBe(440)
    expect(TranscriptPresenter.relocateRowEnd({ end: 400, pendingDelta: 0 }, -1, 500, limit)).toBe(400)
  })
  it("includes an out-of-window selection and keeps an in-window one", () => {
    expect(TranscriptPresenter.includeRowEnd(400, 380, 500, limit)).toBe(400)
    expect(TranscriptPresenter.includeRowEnd(400, 450, 500, limit)).toBe(451)
    expect(TranscriptPresenter.includeRowEnd(400, 10, 500, limit)).toBe(240)
    expect(TranscriptPresenter.includeRowEnd(400, -1, 500, limit)).toBe(400)
  })
})
