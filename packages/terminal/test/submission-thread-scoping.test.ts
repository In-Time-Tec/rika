import { describe, expect, it } from "vitest"
import { initial, type Model } from "../src/state/model/terminal-state"
import { update } from "../src/state/reducer/terminal-state-reducer"
import { overlayPendingSubmissions } from "../src/state/model/terminal-submission-state"

const modelWith = (overrides: Partial<Model>): Model => ({ ...initial("/workspace", "medium"), ...overrides })

describe("provisional submission scoping by thread", () => {
  it("overlays a draft only on the thread it was submitted on", () => {
    const submitted = update(modelWith({ currentThreadId: "thread-a", input: "hello", cursor: 5 }), {
      _tag: "Submitted",
      submissionId: "submission-a",
    })
    // The B-thread snapshot rebuild must not carry the A-thread submission.
    const onB = overlayPendingSubmissions(modelWith({ currentThreadId: "thread-b" }), submitted)
    expect(onB.entries.some((entry) => entry.role === "user" && entry.text === "hello")).toBe(false)
    expect(submitted.submittedDrafts.some((draft) => draft.submissionId === "submission-a")).toBe(true)
    // Back on thread A the provisional echo returns.
    const onA = overlayPendingSubmissions(modelWith({ currentThreadId: "thread-a" }), submitted)
    expect(onA.entries.some((entry) => entry.role === "user")).toBe(true)
  })

  it("keeps a threadless draft visible while the created thread arrives", () => {
    const submitted = update(modelWith({ currentThreadId: undefined, input: "hello", cursor: 5 }), {
      _tag: "Submitted",
      submissionId: "submission-new",
    })
    const onCreated = overlayPendingSubmissions(modelWith({ currentThreadId: "thread-new" }), submitted)
    expect(onCreated.entries.some((entry) => entry.role === "user")).toBe(true)
  })

  it("never re-adds a B-thread provisional queue item to the A-thread queue", () => {
    const submitted = modelWith({
      currentThreadId: "thread-b",
      queue: [{ id: "submission-b", prompt: "b", provisional: true, threadId: "thread-b" }],
      submittedDrafts: [],
    })
    const onA = overlayPendingSubmissions(modelWith({ currentThreadId: "thread-a", queue: [] }), submitted)
    expect(onA.queue.some((item) => item.id === "submission-b")).toBe(false)
    const onB = overlayPendingSubmissions(modelWith({ currentThreadId: "thread-b", queue: [] }), submitted)
    expect(onB.queue.some((item) => item.id === "submission-b")).toBe(true)
  })

  it("binds an admitted turn only to the matching thread's draft", () => {
    const submitted = update(modelWith({ currentThreadId: "thread-a", input: "hello", cursor: 5 }), {
      _tag: "Submitted",
      submissionId: "submission-a",
    })
    const onB = update(modelWith({ ...submitted, currentThreadId: "thread-b" }), {
      _tag: "SubmissionAdmitted",
      turnId: "turn-b",
      status: "active",
      threadId: "thread-b",
      submissionId: "submission-a",
    })
    // The draft belongs to thread A, so the B-thread admission must not bind it.
    expect(onB.submittedDrafts.find((draft) => draft.submissionId === "submission-a")?.turnId).toBeUndefined()
  })
})
