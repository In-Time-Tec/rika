import { describe, expect, it } from "@effect/vitest"
import { Catalog } from "@rika/tools"
import {
  applyChildOutcome,
  applyFoldEvent,
  foldUnit,
  foldUnits,
  makeProjectionFold,
  parentToolForChild,
  restoreProjectionFold,
  settleFoldChild,
  settleFoldRunning,
  snapshotFoldProjection,
  snapshotFoldState,
} from "../src/fold"
import { identityKey, withNestedProjections } from "../src/index"
import { unitOrder } from "../src/unit-order"
import type { Projection, SourceEvent, Unit } from "../src/schema"

const event = (sequence: number, type: string, data?: Record<string, unknown>, text?: string): SourceEvent => ({
  cursor: `cursor-${sequence}`,
  sequence,
  type,
  createdAt: sequence,
  ...(data === undefined ? {} : { data }),
  ...(text === undefined ? {} : { text }),
})

const fixtureProjection = (units: ReadonlyArray<Unit>): Projection => ({ units, revision: 1, modelPhase: 0 })

describe("ProjectionFold", () => {
  it("keeps delimiter-bearing execution and entity identities distinct", () => {
    const root = makeProjectionFold("a", "root")
    applyFoldEvent(root, event(1, "tool.call.requested", { tool_call_id: "b:c", tool_name: "task", input: {} }))
    const rootProjection = snapshotFoldProjection(root)
    const parent = rootProjection.units.find(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall",
    )
    if (parent?.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
      throw new Error("root projection has no tool")

    const child = makeProjectionFold("a:b", "child")
    applyFoldEvent(child, event(1, "tool.call.requested", { tool_call_id: "c", tool_name: "read", input: {} }))
    const combined = withNestedProjections(rootProjection, [
      { parentId: parent.content.block.id, projection: snapshotFoldProjection(child) },
    ])
    const tools = combined.units.filter(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall",
    )

    expect(tools).toHaveLength(2)
    expect(new Set(tools.map((unit) => unit.key))).toHaveLength(2)
    expect(() => restoreProjectionFold(combined)).not.toThrow()
  })

  it("uses source cursors for independent id-less generic events", () => {
    const fold = makeProjectionFold("turn", "prompt")
    const events: ReadonlyArray<SourceEvent> = [
      { ...event(1, "notification.created", { title: "Retry", detail: "one" }), cursor: "notification-1" },
      { ...event(2, "notification.created", { title: "Retry", detail: "two" }), cursor: "notification-2" },
      { ...event(3, "operation.error", { title: "Error", message: "one" }), cursor: "error-1" },
      { ...event(4, "operation.error", { title: "Error", message: "two" }), cursor: "error-2" },
      {
        ...event(5, "image.attachment.created", { name: "screen.png", media_type: "image/png" }),
        cursor: "image-1",
      },
      {
        ...event(6, "image.attachment.created", { name: "screen.png", media_type: "image/png" }),
        cursor: "image-2",
      },
      { ...event(7, "workflow.started", { workflow: "review" }), cursor: "workflow-1" },
      { ...event(8, "workflow.started", { workflow: "review" }), cursor: "workflow-2" },
    ]
    for (const source of events) applyFoldEvent(fold, source)
    const blocks = snapshotFoldProjection(fold).units.flatMap((unit) =>
      unit.content._tag === "Block" ? [unit.content.block] : [],
    )

    expect(blocks.filter((block) => block._tag === "Notification")).toHaveLength(2)
    expect(blocks.filter((block) => block._tag === "Error")).toHaveLength(2)
    expect(blocks.filter((block) => block._tag === "ImageAttachment")).toHaveLength(2)
    expect(blocks.filter((block) => block._tag === "Workflow")).toHaveLength(2)
  })

  it("emits deltas that reproduce every projection snapshot", () => {
    const fold = makeProjectionFold("turn", "prompt")
    const units = new Map(snapshotFoldProjection(fold).units.map((unit) => [unit.key, unit]))
    const events = [
      event(0, "model.input.prepared"),
      event(1, "model.output.delta", undefined, "hel"),
      event(2, "model.output.delta", undefined, "lo"),
      event(3, "tool.call.requested", { tool_call_id: "read", tool_name: "read", input: { path: "a" } }),
      event(4, "tool.result.received", { tool_call_id: "read", output: "ok" }),
      event(5, "model.usage.reported", { provider: "openai", model: "gpt-5", input_tokens: 1 }),
      event(6, "execution.completed"),
    ]
    for (const source of events) {
      const mutation = applyFoldEvent(fold, source)
      for (const key of mutation.units.remove) units.delete(key)
      for (const unit of mutation.units.upsert) units.set(unit.key, unit)
      expect([...units.values()].toSorted((a, b) => a.key.localeCompare(b.key))).toEqual(
        snapshotFoldProjection(fold).units.toSorted((a, b) => a.key.localeCompare(b.key)),
      )
      expect(new Set(mutation.units.remove)).toHaveLength(mutation.units.remove.length)
      expect(new Set(mutation.units.upsert.map((unit) => unit.key))).toHaveLength(mutation.units.upsert.length)
    }
  })

  it("distinguishes no-op and state-only mutations", () => {
    const fold = makeProjectionFold("turn", "prompt")
    const accepted = applyFoldEvent(fold, event(1, "unknown.accepted"))
    const duplicate = applyFoldEvent(fold, event(1, "unknown.accepted"))
    expect(accepted).toEqual({ stateChanged: true, units: { upsert: [], remove: [] } })
    expect(duplicate).toEqual({ stateChanged: false, units: { upsert: [], remove: [] } })
  })

  it("returns state and projection snapshots detached from later mutations", () => {
    const fold = makeProjectionFold("turn", "prompt")
    applyFoldEvent(fold, {
      ...event(
        1,
        "model.output.delta",
        { model_call_id: "call", model_attempt_id: "attempt", transient_index: 1, delta: "one" },
        "one",
      ),
    })
    const state = snapshotFoldState(fold)
    const projection = snapshotFoldProjection(fold)
    applyFoldEvent(
      fold,
      event(
        2,
        "model.output.delta",
        { model_call_id: "call", model_attempt_id: "attempt", transient_index: 2, delta: "two" },
        "two",
      ),
    )
    expect(state).toEqual({ revision: -1, modelPhase: -1 })
    expect(
      projection.units.find((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")?.content,
    ).toEqual({ _tag: "Entry", role: "assistant", text: "one" })
    expect(foldUnit(fold, "assistant:turn:%n0")?.content).toEqual({
      _tag: "Entry",
      role: "assistant",
      text: "onetwo",
    })
  })

  it("keeps tool lookup coherent after replacement", () => {
    const fold = makeProjectionFold("turn", "prompt")
    applyFoldEvent(fold, event(1, "tool.call.requested", { tool_call_id: "read", tool_name: "read", input: {} }))
    const before = foldUnit(fold, "tool:turn:read") as Unit
    applyFoldEvent(fold, event(2, "tool.result.received", { tool_call_id: "read", output: "done" }))
    const after = foldUnit(fold, "tool:turn:read") as Unit
    expect(after).not.toBe(before)
    expect(after.order).toEqual(before.order)
    expect(after).toMatchObject({ revision: 2, content: { block: { status: "complete" } } })
  })

  it("reports only units enumerated by indexed reducer operations", () => {
    let enumerated = 0
    const unrelated = Array.from(
      { length: 500 },
      (_, index): Unit => ({
        key: `notice:${index}`,
        turnId: "turn",
        order: unitOrder(`notice:${index}`, index),
        revision: index,
        content: { _tag: "Entry", role: "notice", text: `${index}` },
      }),
    )
    const running: Unit = {
      key: "tool:turn:running",
      turnId: "turn",
      order: unitOrder("tool:turn:running", 501),
      revision: 501,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          id: "turn:running",
          name: "read",
          input: "{}",
          status: "running",
          presentation: {
            family: "direct",
            action: "Read",
            activeLabel: "Reading",
            completeLabel: "Read",
          },
          detail: "",
          files: [],
        },
      },
    }
    const projection: Projection = {
      units: [...unrelated, running],
      revision: 501,
      modelPhase: 0,
    }
    const fold = restoreProjectionFold(projection, { observer: { unitEnumerated: () => enumerated++ } })

    const mutation = settleFoldRunning(fold, "cancelled", 502)

    expect(enumerated).toBe(1)
    expect(mutation.units.upsert.map((unit) => unit.key)).toEqual(["tool:turn:running"])
  })

  it("uses indexed tool and child correlations without enumerating unrelated units", () => {
    let enumerated = 0
    const fold = makeProjectionFold("turn", "prompt", { observer: { unitEnumerated: () => enumerated++ } })
    for (let sequence = 0; sequence < 500; sequence += 1)
      applyFoldEvent(fold, event(sequence, "notification.created", { id: `${sequence}` }))
    applyFoldEvent(
      fold,
      event(501, "tool.call.requested", {
        tool_call_id: "agent",
        tool_name: "task",
        input: {},
      }),
    )
    applyFoldEvent(
      fold,
      event(502, "child_run.started", {
        child_execution_id: "child:turn:agent",
      }),
    )
    enumerated = 0

    expect(parentToolForChild(fold, "turn", "child:turn:agent")?.key).toBe("tool:turn:agent")
    expect(enumerated).toBeLessThanOrEqual(1)
    const lookupEnumerated = enumerated
    expect(foldUnits(fold)).toHaveLength(502)
    expect(enumerated).toBe(lookupEnumerated + 502)
  })

  it("does not project permission or approval events", () => {
    const fold = makeProjectionFold("turn", "prompt")

    const approval = applyFoldEvent(fold, event(1, "tool.approval.requested", { wait_id: "approval" }))
    const permission = applyFoldEvent(fold, event(2, "permission.ask.requested", { wait_id: "permission" }))

    expect(approval.units).toEqual({ upsert: [], remove: [] })
    expect(permission.units).toEqual({ upsert: [], remove: [] })
    expect(foldUnits(fold).map((unit) => unit.content._tag)).toEqual(["Entry"])
  })

  it("emits removal deltas when a correlated tool supersedes a child placeholder", () => {
    const fold = makeProjectionFold("turn", "prompt")
    applyFoldEvent(
      fold,
      event(1, "child_run.started", {
        child_execution_id: "child:turn:agent",
        activity: "starting",
      }),
    )
    applyFoldEvent(
      fold,
      event(2, "tool.call.requested", {
        tool_call_id: "agent",
        tool_name: "task",
        input: {},
      }),
    )

    const mutation = applyFoldEvent(
      fold,
      event(3, "child_run.started", {
        child_execution_id: "child:turn:agent",
        activity: "working",
      }),
    )

    const childKey = identityKey("child", "turn", "child:turn:agent")
    expect(mutation.units.remove).toEqual([childKey])
    expect(mutation.units.upsert.map((unit) => unit.key)).toEqual(["tool:turn:agent"])
    expect(foldUnit(fold, childKey)).toBeUndefined()
  })

  it("keeps ordinary child settlement monotonic and lets authoritative outcomes reconcile", () => {
    const fold = makeProjectionFold("turn", "prompt")
    applyFoldEvent(
      fold,
      event(1, "tool.call.requested", {
        tool_call_id: "agent",
        tool_name: "task",
        input: {},
      }),
    )
    applyFoldEvent(
      fold,
      event(2, "child_run.started", {
        child_execution_id: "child:turn:agent",
      }),
    )

    expect(settleFoldChild(fold, "child:turn:agent", "complete", 3).units.upsert).toHaveLength(1)
    expect(settleFoldChild(fold, "child:turn:agent", "failed", 4)).toEqual({
      stateChanged: false,
      units: { upsert: [], remove: [] },
    })
    expect(
      applyChildOutcome(fold, "child:turn:agent", { status: "failed", reason: "boom" }).units.upsert,
    ).toMatchObject([{ content: { block: { status: "failed" } } }])
  })

  it("preserves indexed child outcomes without revisiting every completed child", () => {
    let enumerated = 0
    const fold = makeProjectionFold("turn", "prompt", { observer: { unitEnumerated: () => enumerated++ } })
    for (let index = 0; index < 200; index += 1) {
      const childId = `child:turn:agent-${index}`
      applyFoldEvent(
        fold,
        event(index * 2 + 1, "tool.call.requested", {
          tool_call_id: `agent-${index}`,
          tool_name: "task",
          input: {},
        }),
      )
      applyFoldEvent(
        fold,
        event(index * 2 + 2, "child_run.started", {
          child_execution_id: childId,
        }),
      )
      applyChildOutcome(fold, childId, { status: "complete" })
    }
    enumerated = 0

    applyFoldEvent(fold, event(401, "notification.created", { id: "unrelated" }))

    expect(enumerated).toBe(0)
    applyFoldEvent(
      fold,
      event(402, "child_run.started", {
        child_execution_id: "child:turn:agent-100",
      }),
    )
    expect(foldUnit(fold, "tool:turn:agent-100")).toMatchObject({
      content: { block: { childId: "child:turn:agent-100", status: "complete" } },
    })
  })

  it("restores terminal child authority before applying a late parent lifecycle event", () => {
    const source = makeProjectionFold("turn", "prompt")
    applyFoldEvent(
      source,
      event(1, "tool.call.requested", {
        tool_call_id: "agent",
        tool_name: "task",
        input: {},
      }),
    )
    applyFoldEvent(
      source,
      event(2, "child_run.started", {
        child_execution_id: "child:turn:agent",
      }),
    )
    applyChildOutcome(source, "child:turn:agent", { status: "failed", reason: "child failed" })
    const restored = restoreProjectionFold(snapshotFoldProjection(source))

    const mutation = applyFoldEvent(
      restored,
      event(3, "child_run.started", {
        child_execution_id: "child:turn:agent",
      }),
    )

    expect(mutation.units.upsert).toMatchObject([
      { content: { block: { childId: "child:turn:agent", status: "failed" } } },
    ])
    expect(foldUnit(restored, "tool:turn:agent")).toMatchObject({
      content: { block: { childId: "child:turn:agent", status: "failed" } },
    })
  })

  it("settles an indexed child placeholder once", () => {
    const fold = makeProjectionFold("turn", "prompt")
    applyFoldEvent(
      fold,
      event(1, "child_run.started", {
        child_execution_id: "unlinked-child",
      }),
    )

    const mutation = settleFoldChild(fold, "unlinked-child", "cancelled", 2)

    expect(mutation.units.upsert).toMatchObject([
      { key: "child:turn:unlinked-child", content: { block: { status: "cancelled" } } },
    ])
  })

  it("rebuilds indexes from a restored projection", () => {
    const source = makeProjectionFold("turn", "prompt")
    applyFoldEvent(
      source,
      event(1, "tool.call.requested", {
        tool_call_id: "read",
        tool_name: "read",
        input: { path: "a.ts" },
      }),
    )
    const fold = restoreProjectionFold(snapshotFoldProjection(source))

    const mutation = applyFoldEvent(
      fold,
      event(2, "tool.result.received", {
        tool_call_id: "read",
        output: "done",
      }),
    )

    expect(mutation.units.upsert).toMatchObject([
      { key: "tool:turn:read", content: { block: { status: "complete", output: "done" } } },
    ])
    expect(mutation.units.remove).toEqual([])
  })

  it("rejects ambiguous restored unit identity and outcome state", () => {
    const prompt = snapshotFoldProjection(makeProjectionFold("turn", "prompt")).units[0]!
    const notice = (key: string, sequence: number): Unit => ({
      key,
      turnId: "turn",
      order: unitOrder(key, sequence),
      revision: sequence,
      content: { _tag: "Entry", role: "notice", text: key },
    })
    expect(() => restoreProjectionFold(fixtureProjection([prompt, { ...prompt }]))).toThrow(/key.*duplicated/i)
    expect(() =>
      restoreProjectionFold(fixtureProjection([prompt, { ...notice("notice", 1), order: prompt.order }])),
    ).toThrow(/order|non-intrinsic/i)
    expect(() =>
      restoreProjectionFold(
        fixtureProjection([
          prompt,
          { ...notice("first-outcome", 1), executionOutcome: { status: "complete" } },
          { ...notice("second-outcome", 2), executionOutcome: { status: "failed", reason: "boom" } },
        ]),
      ),
    ).toThrow(/outcome.*duplicated/i)
    const toolFold = makeProjectionFold("turn", "prompt")
    applyFoldEvent(toolFold, event(1, "tool.call.requested", { tool_call_id: "read", tool_name: "read", input: {} }))
    const tool = foldUnit(toolFold, "tool:turn:read")!
    expect(() =>
      restoreProjectionFold(
        fixtureProjection([prompt, tool, { ...tool, key: "duplicate-tool", order: unitOrder("duplicate-tool", 2) }]),
      ),
    ).toThrow(/tool.*duplicated/i)
  })

  it("does not enumerate unrelated units for an exact indexed update", () => {
    let enumerated = 0
    const fold = makeProjectionFold("turn", "prompt", { observer: { unitEnumerated: () => enumerated++ } })
    for (let sequence = 0; sequence < 500; sequence += 1)
      applyFoldEvent(fold, event(sequence, "notification.created", { id: `${sequence}` }))
    applyFoldEvent(
      fold,
      event(501, "tool.call.requested", {
        tool_call_id: "read",
        tool_name: "read",
        input: { path: "a.ts" },
      }),
    )
    expect(enumerated).toBe(0)
    enumerated = 0

    const mutation = applyFoldEvent(
      fold,
      event(502, "tool.result.received", {
        tool_call_id: "read",
        output: "done",
      }),
    )

    expect(enumerated).toBe(0)
    expect(mutation.units.upsert.map((unit) => unit.key)).toEqual(["tool:turn:read"])
  })

  it("keeps assistant and tool event work bounded after restoring a large history", () => {
    const historical = Array.from(
      { length: 550 },
      (_, index): Unit => ({
        key: `notice:${index}`,
        turnId: "turn",
        order: unitOrder(`notice:${index}`, index),
        revision: index,
        content: { _tag: "Entry", role: "notice", text: `${index}` },
      }),
    )
    const tool: Unit = {
      key: "tool:turn:read",
      turnId: "turn",
      order: unitOrder("tool:turn:read", 550),
      revision: 550,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          id: "turn:read",
          name: "read",
          input: "{}",
          status: "running",
          presentation: Catalog.resolvePresentation("read"),
          detail: "",
          files: [],
        },
      },
    }
    const counters = { indexed: 0, lookups: 0, running: 0, full: 0 }
    const fold = restoreProjectionFold(
      { units: [...historical, tool], revision: 550, modelPhase: 0 },
      {
        observer: {
          unitIndexed: () => counters.indexed++,
          unitLookup: () => counters.lookups++,
          runningUnitVisited: () => counters.running++,
          fullUnitEnumeration: () => counters.full++,
        },
      },
    )
    counters.indexed = 0
    counters.lookups = 0
    counters.running = 0
    counters.full = 0

    applyFoldEvent(fold, event(551, "model.output.delta", undefined, "hello"))
    applyFoldEvent(fold, event(552, "tool.result.received", { tool_call_id: "read", output: "done" }))

    expect(counters.full).toBe(0)
    expect(counters.running).toBe(0)
    expect(counters.lookups).toBeLessThanOrEqual(4)
    expect(counters.indexed).toBeLessThanOrEqual(4)
  })

  it("accumulates usage cursors incrementally with replay deduplication", () => {
    const fold = makeProjectionFold("turn", "prompt")
    const usageEvent = (sequence: number) =>
      event(sequence, "model.usage.reported", {
        provider: "openai",
        model: "gpt-5.6-sol",
        input_tokens: 250_000,
        input_tokens_uncached: 250_000,
        input_tokens_cache_read: 0,
        input_tokens_cache_write: 0,
        output_tokens: 0,
      })
    applyFoldEvent(fold, usageEvent(1))
    applyFoldEvent(fold, usageEvent(2))
    expect(snapshotFoldState(fold).usageCursors).toEqual(["cursor-1", "cursor-2"])
    applyFoldEvent(fold, usageEvent(1))
    expect(snapshotFoldState(fold).usageCursors).toEqual(["cursor-1", "cursor-2"])
  })
})
