import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as TranscriptIdentity from "@rika/transcript/transcript-unit-identity"
import * as TranscriptNestedProjection from "@rika/transcript/nested-transcript-projection"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as ViewState from "@rika/terminal/terminal-state"
import * as TranscriptPresentation from "@rika/terminal/terminal-transcript-presentation"
import { renderTranscriptStyled } from "@rika/terminal/opentui-surface"
import { expect, it } from "vitest"
import { thread, entries, initialState } from "./interactive-controller-transcript-fixtures"
import { makeProjectionFeed } from "./interactive-controller-stream-fixtures"

it("projects child execution units beneath the matching subagent", () => {
  const pageEntries = entries("parent", 2)
  const turn = { ...pageEntries[0]!.turn, status: "running" as const }
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: pageEntries,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })
  const requestedEvent: TranscriptSourceEvent.SourceEvent = {
    cursor: "agent",
    sequence: 0,
    type: "tool.call.requested",
    createdAt: 3,
    data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review the code" } },
  }
  const spawnedEvent: TranscriptSourceEvent.SourceEvent = {
    cursor: "spawned",
    sequence: 1,
    type: "child_run.spawned",
    createdAt: 4,
    data: {
      tool_call_id: "agent",
      child_execution_id: "execution:parent:child:agent",
    },
  }
  const childToolEvent: TranscriptSourceEvent.SourceEvent = {
    cursor: "child-read",
    sequence: 0,
    type: "tool.call.requested",
    createdAt: 5,
    data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
  }
  const childResponseEvent: TranscriptSourceEvent.SourceEvent = {
    cursor: "child-response",
    sequence: 1,
    type: "model.output.completed",
    createdAt: 6,
    text: "## Review complete\n\n**No defects found.**",
  }
  let parent = TranscriptProjection.Projection.empty(turn.id, turn.prompt)
  const feed = makeProjectionFeed(page.state, turn, parent)
  parent = TranscriptProjection.Projection.applyEvent(parent, requestedEvent)
  feed.apply(requestedEvent, { projection: parent })
  parent = TranscriptProjection.Projection.applyEvent(parent, spawnedEvent)
  feed.apply(spawnedEvent, { projection: parent })
  const childId = "parent:child:agent"
  let childProjection = TranscriptProjection.Projection.applyEvent(
    TranscriptProjection.Projection.empty(childId, ""),
    childToolEvent,
  )
  const child = feed.apply(childToolEvent, {
    executionId: `execution:${childId}`,
    projection: TranscriptNestedProjection.withNestedProjections(parent, [
      { parentId: `${turn.id}:agent`, projection: childProjection },
    ]),
  })
  childProjection = TranscriptProjection.Projection.applyEvent(childProjection, childResponseEvent)
  const response = feed.apply(childResponseEvent, {
    executionId: `execution:${childId}`,
    projection: TranscriptNestedProjection.withNestedProjections(parent, [
      { parentId: `${turn.id}:agent`, projection: childProjection },
    ]),
  })

  expect(child.state.model.blocks).toEqual([
    expect.objectContaining({ _tag: "ToolCall", id: "parent:agent", childId: "execution:parent:child:agent" }),
    expect.objectContaining({ _tag: "ToolCall", id: TranscriptIdentity.scopedIdentity(childId, "read") }),
  ])
  expect(child.state.model.items[2]).toMatchObject({
    id: TranscriptIdentity.identityKey("tool", childId, "read"),
    parentId: "parent:agent",
  })
  expect(child.state.revisions.get("parent")).toBe(1)
  expect(response.state.model.entries).toContainEqual(
    expect.objectContaining({ role: "assistant", text: "## Review complete\n\n**No defects found.**" }),
  )
  expect(response.state.model.items).toContainEqual(
    expect.objectContaining({
      _tag: "Entry",
      id: TranscriptIdentity.identityKey("assistant", childId, 0),
      parentId: "parent:agent",
    }),
  )
  expect(response.state.revisions.get("parent")).toBe(1)
})

it("attaches parallel child streams when task rows lack explicit spawn links", () => {
  const turnId = "parallel"
  const childIds = ["one", "two", "three", "four"].map(
    (callId) => `child:execution%3A${turnId}:rika:execution%3A${turnId}:${callId}`,
  )
  const pageEntries = entries(turnId, 2)
  const turn = { ...pageEntries[0]!.turn, status: "running" as const }
  const selected = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: pageEntries,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })
  let parent = TranscriptProjection.Projection.empty(turnId, turn.prompt)
  const feed = makeProjectionFeed(selected.state, turn, parent)

  for (const [sequence, callId] of ["one", "two", "three", "four"].entries()) {
    const event: TranscriptSourceEvent.SourceEvent = {
      cursor: `task-${callId}`,
      sequence,
      type: "tool.call.requested",
      createdAt: 3,
      data: { tool_call_id: callId, tool_name: "task", input: { prompt: `Explore ${callId}` } },
    }
    parent = TranscriptProjection.Projection.applyEvent(parent, event)
    feed.apply(event, { projection: parent })
  }

  const children = new Map<string, TranscriptProjectionModel.Projection>()
  for (const [index, childId] of childIds.entries()) {
    const toolEvent: TranscriptSourceEvent.SourceEvent = {
      cursor: `child-tool-${index}`,
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 4,
      data: { tool_call_id: "read", tool_name: "read", input: { path: `src/${index}.ts` } },
    }
    const responseEvent: TranscriptSourceEvent.SourceEvent = {
      cursor: `child-response-${index}`,
      sequence: 1,
      type: "model.output.completed",
      createdAt: 5,
      text: `## Agent ${index + 1}\n\n**Complete.**`,
    }
    children.set(
      childId,
      TranscriptProjection.Projection.applyEvent(TranscriptProjection.Projection.empty(childId, ""), toolEvent),
    )
    const nested = () =>
      TranscriptNestedProjection.withNestedProjections(
        parent,
        [...children].map(([, projection], childIndex) => ({
          parentId: `${turnId}:${["one", "two", "three", "four"][childIndex]}`,
          projection,
        })),
      )
    feed.apply(toolEvent, { executionId: `execution:${childId}`, projection: nested() })
    children.set(childId, TranscriptProjection.Projection.applyEvent(children.get(childId)!, responseEvent))
    feed.apply(responseEvent, { executionId: `execution:${childId}`, projection: nested() })
  }

  const toolRows = (feed.state.model.items as ReadonlyArray<ViewState.TranscriptItem>).filter(
    (item) => item._tag === "Block" && item.id?.startsWith("tool:"),
  )
  expect(toolRows).toHaveLength(8)
  expect(toolRows.filter((item) => item.parentId !== undefined)).toHaveLength(4)
  expect(feed.state.model.entries.filter((entry) => entry.text.startsWith("## Agent"))).toHaveLength(4)
})

it("reloads one completed subagent tree with rendered markdown and no serialized result", () => {
  const target = entries("durable-parent", 2)[0]!.turn
  const childId = "durable-parent:child:agent"
  const serialized =
    '{"status":"completed","output":[{"type":"text","text":"## Review complete\\n\\n**No defects found.**"}]}'
  const parent = TranscriptProjection.Projection.project(target.id, target.prompt, [
    {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 2,
      data: {
        tool_call_id: "agent",
        tool_name: "transfer_to_oracle",
        input: { input: [{ type: "text", text: "Review the projection" }] },
      },
    },
    {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 3,
      data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
    },
    {
      cursor: "result",
      sequence: 2,
      type: "tool.result.received",
      createdAt: 4,
      data: { tool_call_id: "agent", output: serialized },
    },
    { cursor: "done", sequence: 3, type: "execution.completed", createdAt: 5 },
  ])
  const child = TranscriptProjection.Projection.project(childId, "", [
    {
      cursor: "read",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 3,
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/projection.ts" } },
    },
    {
      cursor: "answer",
      sequence: 1,
      type: "model.output.completed",
      createdAt: 4,
      text: "## Review complete\n\n**No defects found.**",
    },
    { cursor: "child-done", sequence: 2, type: "execution.completed", createdAt: 5 },
  ])
  const durable = TranscriptNestedProjection.withNestedProjections(parent, [
    { parentId: `${target.id}:agent`, projection: child },
  ])
  const persistedEntries = durable.units.map((unit) => ({
    turn: target,
    unit,
    projectionRevision: durable.revision,
    projectionModelPhase: durable.modelPhase,
  }))
  const base = initialState()
  const initial = { ...base, model: { ...base.model, expandedRowKeys: [`tool:${target.id}:agent`] } }

  const loaded = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persistedEntries,
    hasOlder: false,
    threadCostUsd: 0,
  })
  let liveModel = TranscriptPresentation.applyTurnUnits(ViewState.initial("/work", "medium"), parent.units)
  liveModel = TranscriptPresentation.applyChildUnits(liveModel, `${target.id}:agent`, child.units)
  liveModel = { ...liveModel, expandedRowKeys: [`tool:${target.id}:agent`] }
  const rendered = renderTranscriptStyled(loaded.state.model)
  const text = rendered.chunks.map((chunk) => chunk.text).join("")
  const liveText = renderTranscriptStyled(liveModel)
    .chunks.map((chunk) => chunk.text)
    .join("")
  const blocks = loaded.state.model.blocks as ReadonlyArray<ViewState.TranscriptBlock>
  const agents = blocks.filter((block) => block._tag === "ToolCall" && block.presentation.family === "agent")

  expect(agents).toHaveLength(1)
  expect(blocks.filter((block) => block._tag === "ChildAgent")).toHaveLength(0)
  expect(loaded.state.model.items).toContainEqual(
    expect.objectContaining({
      _tag: "Entry",
      id: TranscriptIdentity.identityKey("assistant", childId, 0),
      parentId: `${target.id}:agent`,
    }),
  )
  expect(text).toBe(liveText)
  expect(text).toContain("Review the projection")
  expect(text).toContain("Review complete")
  expect(text).toContain("No defects found.")
  expect(text).not.toContain("##")
  expect(text).not.toContain("**")
  expect(text).not.toContain("\\n")
  expect(text).not.toContain('"}]}')
  expect(text).not.toContain(serialized)
})

it("keeps cancelled child tools terminal in live and reloaded projections", () => {
  const target = { ...entries("cancel-parent", 2)[0]!.turn, status: "running" as const }
  const childId = "child:execution%3Acancel-parent:agent"
  const parent = TranscriptProjection.Projection.project(target.id, target.prompt, [
    {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 2,
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Run the checks" } },
    },
    {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 3,
      data: { child_execution_id: childId },
    },
    { cursor: "root-cancelled", sequence: 2, type: "execution.cancelled", createdAt: 6 },
  ])
  const child = TranscriptProjection.Projection.project(childId, "", [
    {
      cursor: "bash",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 4,
      data: { tool_call_id: "bash", tool_name: "bash", input: { command: "sleep 60" } },
    },
  ])
  const durable = TranscriptNestedProjection.withNestedProjections(parent, [
    { parentId: `${target.id}:agent`, projection: child },
  ])
  const persistedEntries = durable.units.map((unit) => ({
    turn: { ...target, status: "cancelled" as const },
    unit,
    projectionRevision: durable.revision,
    projectionModelPhase: durable.modelPhase,
  }))
  const base = initialState()
  const loaded = InteractiveController.update(base, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persistedEntries,
    hasOlder: false,
    threadCostUsd: 0,
  }).state.model
  let live = TranscriptPresentation.applyTurnUnits(ViewState.initial("/work", "medium"), parent.units)
  live = TranscriptPresentation.applyChildUnits(live, `${target.id}:agent`, child.units)

  for (const model of [live, loaded]) {
    expect(model.blocks).toEqual([
      expect.objectContaining({ id: `${target.id}:agent`, status: "cancelled" }),
      expect.objectContaining({ id: TranscriptIdentity.scopedIdentity(childId, "bash"), status: "cancelled" }),
    ])
    expect(model.entries.filter((entry) => entry.role === "notice")).toEqual([])
    expect(
      renderTranscriptStyled(model)
        .chunks.map((chunk) => chunk.text)
        .join(""),
    ).toContain("⊘ Subagent cancelled")
  }
})
