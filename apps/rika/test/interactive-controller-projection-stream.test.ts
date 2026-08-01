import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as Turn from "@rika/product/turn-record"
import * as ThreadResult from "@rika/product/thread-result"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptRecordedShell from "@rika/transcript/recorded-shell-presentation"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as ViewState from "@rika/terminal/terminal-state"
import { HashMap } from "effect"
import { expect, it } from "vitest"
import { thread, visibleState, unitDelta } from "./interactive-controller-transcript-fixtures"
import { startProjection, openProjectionStream } from "./interactive-controller-stream-fixtures"
import { runningTurn, populatedSelection, projectionEvent } from "./interactive-controller-active-fixtures"

it("installs an authoritative projection snapshot for the active turn", () => {
  const active = runningTurn("projection-snapshot")
  const selected = populatedSelection(active)
  const projection = TranscriptProjection.Projection.project(active.id, active.prompt, [
    projectionEvent(active, "live answer"),
  ])
  const started = startProjection(selected.state, active, projection)

  expect(started.state.model.entries.map((entry) => entry.text)).toContain("live answer")
  expect(started.state.projectionStreams?.get(active.id)).toMatchObject({
    streamId: `stream:${active.id}`,
    patchRevision: 0,
    state: visibleState(projection),
  })
  expect(HashMap.size(openProjectionStream(started.state, active.id).units)).toBe(projection.units.length)
})

it("keeps every open projection visible when snapshots arrive in sequence", () => {
  const active = runningTurn("projection-active")
  const concurrent = { ...runningTurn("projection-concurrent"), createdAt: 3, updatedAt: 3 }
  const activeProjection = TranscriptProjection.Projection.project(active.id, active.prompt, [
    projectionEvent(active, "active answer"),
  ])
  const concurrentProjection = TranscriptProjection.Projection.project(concurrent.id, concurrent.prompt, [
    projectionEvent(concurrent, "concurrent answer"),
  ])
  const activeStarted = startProjection(populatedSelection(active).state, active, activeProjection)
  const concurrentStarted = startProjection(activeStarted.state, concurrent, concurrentProjection)

  expect(concurrentStarted.state.model.entries.map((entry) => entry.text)).toEqual(
    expect.arrayContaining([active.prompt, "active answer", concurrent.prompt, "concurrent answer"]),
  )
  expect(concurrentStarted.state.projectionStreams?.size).toBe(2)
})

it("applies exact projection upserts and removals without replaying source events", () => {
  const active = runningTurn("projection-delta")
  const initialProjection = TranscriptProjection.Projection.project(active.id, active.prompt, [
    projectionEvent(active, "hel"),
  ])
  const selected = populatedSelection(active)
  const started = startProjection(selected.state, active, initialProjection)
  const updatedProjection = TranscriptProjection.Projection.project(active.id, active.prompt, [
    projectionEvent(active, "hello"),
  ])
  const updatedUnit = updatedProjection.units.find(
    (unit) => unit.content._tag === "Entry" && unit.content.role === "assistant",
  )!
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: {
      _tag: "Event",
      executionId: `execution:${active.id}`,
      cursor: "output:hello",
      sequence: 1,
      type: "model.output.delta",
      createdAt: 3,
      transient: false,
    },
    state: visibleState(updatedProjection),
    delta: { upsert: [updatedUnit], remove: [] },
  })
  const removed = InteractiveController.update(patched.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 1,
    patchRevision: 2,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(updatedProjection),
    delta: { upsert: [], remove: [updatedUnit.key] },
  })

  expect(patched.resync).toBeUndefined()
  expect(patched.state.model.entries.map((entry) => entry.text)).toContain("hello")
  expect(patched.state.model.entries.map((entry) => entry.text)).not.toContain("hel")
  expect(removed.state.model.entries.map((entry) => entry.text)).not.toContain("hello")
  expect(HashMap.has(openProjectionStream(removed.state, active.id).units, updatedUnit.key)).toBe(false)
})

it("inserts a newly discovered projection unit at its stable order", () => {
  const active = runningTurn("projection-order")
  const later: TranscriptUnit.Unit = {
    key: `${active.id}:later`,
    turnId: active.id,
    order: TranscriptOrdering.unitOrder(`${active.id}:later`, 2),
    revision: 2,
    content: { _tag: "Entry", role: "assistant", text: "later" },
  }
  const earlier: TranscriptUnit.Unit = {
    key: `${active.id}:earlier`,
    turnId: active.id,
    order: TranscriptOrdering.unitOrder(`${active.id}:earlier`, 1),
    revision: 1,
    content: { _tag: "Entry", role: "assistant", text: "earlier" },
  }
  const projection = { ...TranscriptProjection.Projection.empty(active.id, active.prompt), units: [later] }
  const started = startProjection(populatedSelection(active).state, active, projection)
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [earlier], remove: [] },
  })
  const orderedText = (patched.state.model.items as ReadonlyArray<ViewState.TranscriptItem>)
    .filter((item) => item.id === earlier.key || item.id === later.key)
    .map((item) => (item._tag === "Entry" ? patched.state.model.entries[item.index]?.text : undefined))

  expect(patched.resync).toBeUndefined()
  expect(orderedText).toEqual(["earlier", "later"])
})

it("requests an authoritative resync for a projection stream or revision mismatch", () => {
  const active = runningTurn("projection-gap")
  const projection = TranscriptProjection.Projection.project(active.id, active.prompt, [])
  const started = startProjection(populatedSelection(active).state, active, projection)
  const patch = {
    _tag: "TranscriptProjectionPatched" as const,
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "Discovery" as const, executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [], remove: [] },
  }

  expect(InteractiveController.update(started.state, { ...patch, streamId: "wrong-stream" }).resync).toBe(true)
  expect(InteractiveController.update(started.state, { ...patch, patchRevision: 2 }).resync).toBe(true)
  expect(started.state.projectionStreams?.get(active.id)?.patchRevision).toBe(0)
})

it("keeps the visible projection at a terminal boundary and rejects later patches", () => {
  const active = runningTurn("projection-terminal")
  const projection = TranscriptProjection.Projection.project(active.id, active.prompt, [
    projectionEvent(active, "final answer"),
  ])
  const started = startProjection(populatedSelection(active).state, active, projection)
  const terminal = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [], remove: [] },
    rootStatus: "completed",
  })
  const stopped = InteractiveController.update(terminal.state, {
    _tag: "TranscriptProjectionStopped",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    patchRevision: 1,
    status: "completed",
  })
  const late = InteractiveController.update(stopped.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 1,
    patchRevision: 2,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [], remove: [] },
  })

  expect(stopped.state.model.entries.map((entry) => entry.text)).toContain("final answer")
  expect(stopped.state.model).toMatchObject({ busy: false, activeTurnId: undefined })
  expect(stopped.state.projectionStreams?.get(active.id)).toEqual({
    _tag: "Stopped",
    streamId: `stream:${active.id}`,
    patchRevision: 1,
    boundary: { _tag: "Stopped", status: "completed" },
  })
  expect(stopped.state.projectionStreams?.get(active.id)).not.toHaveProperty("units")
  expect(late.resync).toBe(true)
})

it("rejects a terminal boundary that contradicts the last projection patch", () => {
  const active = runningTurn("projection-terminal-mismatch")
  const projection = TranscriptProjection.Projection.project(active.id, active.prompt, [
    projectionEvent(active, "final answer"),
  ])
  const started = startProjection(populatedSelection(active).state, active, projection)
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [], remove: [] },
    rootStatus: "failed",
  })
  const stopped = InteractiveController.update(patched.state, {
    _tag: "TranscriptProjectionStopped",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    patchRevision: 1,
    status: "completed",
  })

  expect(stopped.resync).toBe(true)
  expect(stopped.state).toBe(patched.state)
})

it("settles a recorded shell projection without treating it as an agent execution", () => {
  const running: ThreadResult.RunningRecordedShellTurn = {
    _tag: "RecordedShell",
    id: Turn.TurnId.make("recorded-shell"),
    threadId: thread.id,
    prompt: "$ printf done",
    command: "printf done",
    status: "running",
    stopIntent: "none",
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    createdAt: 2,
    updatedAt: 2,
  }
  const initial = TranscriptRecordedShell.recordedShellProjection({
    id: running.id,
    command: running.command,
    status: "running",
  })
  const started = startProjection(populatedSelection(running).state, running, initial)
  const terminal: ThreadResult.TerminalRecordedShellTurn = {
    ...running,
    status: "completed",
    result: { text: "done", truncated: false, exitCode: 0 },
    updatedAt: 3,
  }
  const settled = TranscriptRecordedShell.settleRecordedShellProjection(initial, terminal)
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: terminal.id,
    turn: terminal,
    streamId: `stream:${terminal.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "RecordedShell", phase: "settled" },
    state: visibleState(settled),
    delta: unitDelta(initial, settled),
    rootStatus: "completed",
  })
  const stopped = InteractiveController.update(patched.state, {
    _tag: "TranscriptProjectionStopped",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: terminal.id,
    streamId: `stream:${terminal.id}`,
    patchRevision: 1,
    status: "completed",
  })

  expect(patched.resync).toBeUndefined()
  expect(patched.state.replayTurns.get(terminal.id)).toEqual(terminal)
  expect(stopped.resync).toBeUndefined()
  expect(stopped.state.projectionStreams?.get(terminal.id)).toMatchObject({
    _tag: "Stopped",
    boundary: { _tag: "Stopped", status: "completed" },
  })
  expect(stopped.state.model.blocks).toContainEqual(
    expect.objectContaining({
      _tag: "ToolCall",
      id: `${terminal.id}:recorded-shell`,
      status: "complete",
      output: "done",
    }),
  )
})

it("retains the typed projection failure boundary and requests resync", () => {
  const active = runningTurn("projection-failure")
  const projection = TranscriptProjection.Projection.project(active.id, active.prompt, [])
  const started = startProjection(populatedSelection(active).state, active, projection)
  const failed = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionFailed",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    patchRevision: 0,
    executionId: `execution:${active.id}`,
    reason: "BackendReadFailed",
    message: "backend unavailable",
  })

  expect(failed.resync).toBe(true)
  expect(failed.state.projectionStreams?.get(active.id)).toMatchObject({
    _tag: "Failed",
    boundary: {
      _tag: "Failed",
      executionId: `execution:${active.id}`,
      reason: "BackendReadFailed",
      message: "backend unavailable",
    },
  })
})

it("renders transient projection deltas without advancing the durable fold revision", () => {
  const active = runningTurn("projection-transient")
  const projection = TranscriptProjection.Projection.project(active.id, active.prompt, [])
  const started = startProjection(populatedSelection(active).state, active, projection)
  const transientProjection = TranscriptProjection.Projection.project(active.id, active.prompt, [
    projectionEvent(active, "stream", true),
  ])
  const transientUnit = transientProjection.units.find(
    (unit) => unit.content._tag === "Entry" && unit.content.role === "assistant",
  )!
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: {
      _tag: "Event",
      executionId: `execution:${active.id}`,
      cursor: "transient",
      sequence: 1,
      type: "model.output.delta",
      createdAt: 3,
      transient: true,
      text: "stream",
    },
    state: visibleState(projection),
    delta: { upsert: [transientUnit], remove: [] },
  })

  expect(patched.state.model.entries.map((entry) => entry.text)).toContain("stream")
  expect(patched.state.projectionStreams?.get(active.id)).toMatchObject({
    patchRevision: 1,
    state: visibleState(projection),
  })
})

it("does not traverse unchanged projection units for a one-unit delta", () => {
  const active = runningTurn("projection-complexity")
  const template = TranscriptProjection.Projection.project(active.id, active.prompt, []).units[0]!
  let unchangedReads = 0
  const units = Array.from(
    { length: 2_000 },
    (_, index) =>
      new Proxy(
        {
          ...template,
          key: `${active.id}:unit:${index}`,
          order: TranscriptOrdering.unitOrder(active.id, index),
          content: { _tag: "Entry" as const, role: "assistant" as const, text: `line ${index}` },
        },
        {
          get(target, property, receiver) {
            if (index !== 1_000 && (property === "key" || property === "content" || property === "order"))
              unchangedReads += 1
            return Reflect.get(target, property, receiver)
          },
        },
      ),
  )
  const projection = { ...TranscriptProjection.Projection.project(active.id, active.prompt, []), units }
  const started = startProjection(populatedSelection(active).state, active, projection)
  const replacement = {
    ...units[1_000]!,
    content: { _tag: "Entry" as const, role: "assistant" as const, text: "changed" },
  }
  unchangedReads = 0
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [replacement], remove: [] },
  })

  expect(patched.resync).toBeUndefined()
  expect(unchangedReads).toBe(0)
  expect(HashMap.size(openProjectionStream(patched.state, active.id).units)).toBe(2_000)
  unchangedReads = 0
  const removed = InteractiveController.update(patched.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 1,
    patchRevision: 2,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [], remove: [replacement.key] },
  })
  expect(removed.resync).toBeUndefined()
  expect(unchangedReads).toBe(0)
  expect(HashMap.size(openProjectionStream(removed.state, active.id).units)).toBe(1_999)
})
