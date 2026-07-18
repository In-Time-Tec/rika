import { expect, test } from "vitest"
import * as Transcript from "@rika/transcript"
import { ExecutionEvents, Session, ViewState } from "../src"

test("routes session actions only through available adapter callbacks", () => {
  const calls: Array<string> = []
  const adapter: Session.Adapter = {
    submit: (prompt) => calls.push(`submit:${prompt}`),
    quit: () => calls.push("quit"),
    editQueued: (index, prompt) => calls.push(`edit:${index}:${prompt}`),
    dequeue: (index) => calls.push(`dequeue:${index}`),
    steer: (prompt) => calls.push(`steer:${prompt}`),
    interruptAndSend: (prompt) => calls.push(`interrupt:${prompt}`),
    cancel: () => calls.push("cancel"),
    decidePermission: (id, _kind, decision) => calls.push(`${id}:${decision}`),
  }
  expect(
    Session.execute(adapter, {
      _tag: "Submit",
      prompt: "one",
      parts: [{ type: "text", text: "one" }],
      mode: "high",
    }),
  ).toBe(true)
  expect(Session.execute(adapter, { _tag: "EditQueued", id: "one", prompt: "changed" })).toBe(true)
  expect(Session.execute(adapter, { _tag: "Dequeue", id: "one" })).toBe(true)
  expect(Session.execute(adapter, { _tag: "Steer", prompt: "two" })).toBe(true)
  expect(Session.execute(adapter, { _tag: "InterruptAndSend", prompt: "urgent" })).toBe(true)
  expect(Session.execute(adapter, { _tag: "Cancel" })).toBe(true)
  expect(Session.execute(adapter, { _tag: "Quit" })).toBe(true)
  expect(
    Session.execute(adapter, { _tag: "DecidePermission", id: "p", kind: "tool-approval", decision: "always" }),
  ).toBe(true)
  expect(calls).toEqual([
    "submit:one",
    "edit:one:changed",
    "dequeue:one",
    "steer:two",
    "interrupt:urgent",
    "cancel",
    "quit",
    "p:always",
  ])
})

test("projects incremental replay by cursor without duplicates", () => {
  let model = ViewState.initial("/work")
  const events = [
    {
      id: "1",
      cursor: "10",
      block: { _tag: "ChildAgent", id: "child", name: "child", summary: "work", status: "running", activity: [] },
    },
    { id: "2", cursor: "11", block: { _tag: "Workflow", name: "flow", step: "wait", status: "waiting" } },
  ] as const
  for (const event of [...events, events[1]]) model = ViewState.update(model, { _tag: "EventReplayed", event })
  expect(model.blocks).toHaveLength(2)
  expect(model.eventCursor).toBe("11")
})

test("restarts through the shared event mapper and preserves transcript across queue updates", () => {
  const events = [
    { cursor: "1", sequence: 1, type: "model.output.delta", text: "hel" },
    { cursor: "2", sequence: 2, type: "reasoning.delta", text: "checking" },
    { cursor: "3", sequence: 3, type: "child.started", content: [{ profile: "Oracle", summary: "reviewing" }] },
    { cursor: "4", sequence: 4, type: "workflow.waiting", content: [{ workflow: "delivery", step: "approval" }] },
    { cursor: "5", sequence: 5, type: "model.output.completed", text: "hello" },
  ] as const
  const source = events.map((event) => Object.assign({}, event, { createdAt: event.sequence }))
  let projection = Transcript.empty("turn", "prompt")
  let live = ViewState.initial("/work")
  for (const event of source) {
    projection = Transcript.applyEvent(projection, event)
    live = ExecutionEvents.projectUnits(live, projection.units)
  }
  live = ViewState.replaceQueue(live, [{ id: "later", prompt: "later" }])
  projection = Transcript.applyEvent(projection, {
    cursor: "6",
    sequence: 6,
    type: "tool.started",
    createdAt: 6,
    content: [{ id: "t", name: "Read", input: "a.ts" }],
  })
  live = ExecutionEvents.projectUnits(live, projection.units)
  live = ViewState.replaceQueue(live, [])
  const reopened = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
  expect(live.entries).toEqual(reopened.entries)
  expect(live.blocks).toEqual(reopened.blocks)
  expect(live.blocks.at(-1)).toMatchObject({ _tag: "ToolCall", id: "turn:t" })
  expect(live.queue).toEqual([])
})
