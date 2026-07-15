import { expect, test, vi } from "vitest"
import { execute, type Action, type Adapter } from "../src/session"

test("dispatches every session action and reports absent optional callbacks", () => {
  const adapter: Adapter = {
    submit: vi.fn(),
    quit: vi.fn(),
    editQueued: vi.fn(),
    dequeue: vi.fn(),
    steer: vi.fn(),
    interruptAndSend: vi.fn(),
    cancel: vi.fn(),
    decidePermission: vi.fn(),
    selectThread: vi.fn(),
  }
  const actions: ReadonlyArray<Action> = [
    { _tag: "Submit", prompt: "a", parts: [{ type: "text", text: "a" }], mode: "medium" },
    { _tag: "Quit" },
    { _tag: "EditQueued", id: "one", prompt: "b" },
    { _tag: "Dequeue", id: "two" },
    { _tag: "Steer", prompt: "c" },
    { _tag: "InterruptAndSend", prompt: "d" },
    { _tag: "Cancel" },
    { _tag: "DecidePermission", id: "p", kind: "permission", decision: "deny" },
    { _tag: "SelectThread", id: "t" },
  ]
  for (const action of actions) expect(execute(adapter, action)).toBe(true)
  expect(adapter.submit).toHaveBeenCalledWith("a", [{ type: "text", text: "a" }], "medium", undefined)
  expect(adapter.quit).toHaveBeenCalledOnce()
  const minimal: Adapter = { submit: vi.fn(), quit: vi.fn() }
  for (const action of actions.slice(2)) expect(execute(minimal, action)).toBe(false)
})
