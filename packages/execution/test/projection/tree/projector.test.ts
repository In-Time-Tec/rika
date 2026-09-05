import "./projector-checkpoint.fixture"
import "./projector-recovery.fixture"
import { describe, expect, it } from "@effect/vitest"
import { RunEvent } from "generalist/runtime"
import { TreeProjector } from "../../../src/projection/tree/projector"
import { compareUnitOrder } from "@rika/transcript/transcript-unit-order"
import { Prompt, Response } from "effect/unstable/ai"
import { block, modelResponse, occurredAt, resetEventPosition, treeEvent } from "../../support/projector-event.fixture"

type RunEventInput = {
  [Tag in RunEvent.RunEvent["_tag"]]: Partial<Extract<RunEvent.RunEvent, { readonly _tag: Tag }>> & {
    readonly _tag: Tag
  }
}[RunEvent.RunEvent["_tag"]]
const runEvent = (event: RunEventInput): RunEventInput => event

describe("Generalist tree projector", () => {
  it("preserves a multi-chunk user prompt exactly across restart", () => {
    resetEventPosition()
    const prompt = "user-".repeat(5_000)
    const projector = TreeProjector.make("turn-large-user", prompt)
    const initial = projector
      .snapshot()
      .units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "user")
    expect(initial[0]?.key).toBe("turn:turn-large-user:user")
    expect(initial.map((unit) => (unit.content._tag === "Entry" ? unit.content.text : "")).join("")).toBe(prompt)
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    const resumed = TreeProjector.make("turn-large-user", prompt)
    expect(
      resumed
        .snapshot()
        .units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "user")
        .map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))
        .join(""),
    ).toBe(prompt)
  })

  it("preserves long assistant and reasoning output as complete logical responses", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-long-output", "chunk output")
    const assistantText = "assistant-".repeat(7_000)
    const reasoningText = "reasoning-".repeat(7_000)
    projector.apply(modelResponse("raw-root-run", { type: "text", text: assistantText, metadata: {} }))
    projector.apply(modelResponse("raw-root-run", { type: "reasoning", text: reasoningText, metadata: {} }))
    const ordered = projector.snapshot().units.toSorted((left, right) => compareUnitOrder(left.order, right.order))
    const assistant = ordered
      .filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")
      .map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))
      .join("")
    const reasoning = ordered
      .filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Reasoning")
      .map((unit) =>
        unit.content._tag === "Block" && unit.content.block._tag === "Reasoning" ? unit.content.block.text : "",
      )
      .join("")
    expect(assistant).toBe(assistantText)
    expect(reasoning).toBe(reasoningText)
    expect(ordered.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant").length).toBe(1)
    expect(
      ordered.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Reasoning").length,
    ).toBe(1)
  })

  it("marks bounded subagent prompts and authorization inputs as truncated", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-honest-bounds", "bounds")
    const large = "x".repeat(20_000)
    const linked = projector.apply(
      treeEvent(
        "raw-root-run",
        runEvent({
          _tag: "ChildLinked",
          childRunId: "raw-large-child",
          invocationId: "large-child",
          selection: "Review",
          prompt: Prompt.make(large),
        }),
      ),
    )
    const linkedCard = block(linked, "SubagentCard")
    const linkedPrompt =
      linkedCard?._tag === "Block" && linkedCard.block._tag === "SubagentCard" ? linkedCard.block.prompt : ""
    expect(linkedCard).toMatchObject({ _tag: "Block", block: { promptTruncated: true } })
    expect(linkedPrompt).toMatch(/^…/)
    const waiting = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunWaiting",
        wait: {
          waitId: "large-approval",
          status: "open",
          openedAt: occurredAt(1),
          reason: {
            _tag: "Approval",
            request: { approvalId: "large-approval", operation: "write", capability: "workspace", input: large },
          },
        },
      }),
    )
    const waitingCard = block(waiting, "AuthorizationCard")
    const waitingInput =
      waitingCard?._tag === "Block" && waitingCard.block._tag === "AuthorizationCard" ? waitingCard.block.input : ""
    expect(waitingCard).toMatchObject({ _tag: "Block", block: { inputTruncated: true } })
    expect(waitingInput).toMatch(/^…/)
  })

  it("preserves read, edit, and bash product semantics", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-tools", "use tools")
    const stdout = "ok".repeat(10_000)
    const read = projector.apply(
      modelResponse("raw-root-run", {
        type: "tool-call",
        id: "read-call",
        name: "read",
        params: { path: "src/a.ts", read_range: [2, 7] },
        providerExecuted: false,
        metadata: {},
      }),
    )
    expect(block(read, "ToolCall")).toMatchObject({
      _tag: "Block",
      block: { detail: "src/a.ts L2-7", readRange: [2, 7], status: "running" },
    })
    const readCompleted = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionCompleted",
        turn: 0,
        call: Response.toolCallPart({
          id: "read-call",
          name: "read",
          params: { path: "src/a.ts", read_range: [2, 7] },
          providerExecuted: false,
          metadata: {},
        }),
        result: Response.toolResultPart({
          id: "read-call",
          name: "read",
          isFailure: false,
          result: { text: "2: line", truncated: true },
          encodedResult: {},
          providerExecuted: false,
          preliminary: false,
          metadata: {},
        }),
      }),
    )
    expect(block(readCompleted, "ToolCall")).toMatchObject({
      _tag: "Block",
      block: { status: "complete", readRange: [2, 7], truncated: true },
    })
    const edit = projector.apply(
      modelResponse("raw-root-run", {
        type: "tool-call",
        id: "edit-call",
        name: "edit",
        params: { path: "src/a.ts", old_str: "old", new_str: "new\nline" },
        providerExecuted: false,
        metadata: {},
      }),
    )
    const editBlock = block(edit, "ToolCall")
    expect(
      editBlock?._tag === "Block" && editBlock.block._tag === "ToolCall" ? editBlock.block.files : [],
    ).toMatchObject([{ path: "src/a.ts", additions: 2, deletions: 1, preview: true }])
    const appliedDiff = "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n+line"
    const editCompleted = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionCompleted",
        turn: 0,
        call: Response.toolCallPart({
          id: "edit-call",
          name: "edit",
          params: { path: "src/a.ts", old_str: "old", new_str: "new\nline" },
          providerExecuted: false,
          metadata: {},
        }),
        result: Response.toolResultPart({
          id: "edit-call",
          name: "edit",
          isFailure: false,
          result: { text: "edited", truncated: false, diff: appliedDiff },
          encodedResult: {},
          providerExecuted: false,
          preliminary: false,
          metadata: {},
        }),
      }),
    )
    expect(block(editCompleted, "ToolCall")).toMatchObject({
      _tag: "Block",
      block: {
        status: "complete",
        files: [{ path: "src/a.ts", patch: appliedDiff, additions: 2, deletions: 1, preview: false }],
      },
    })
    projector.apply(
      modelResponse("raw-root-run", {
        type: "tool-call",
        id: "bash-call",
        name: "bash",
        params: { command: "bun test" },
        providerExecuted: false,
        metadata: {},
      }),
    )
    const bash = projector.apply(
      treeEvent(
        "raw-root-run",
        runEvent({
          _tag: "ToolExecutionCompleted",
          turn: 0,
          call: Response.toolCallPart({
            id: "bash-call",
            name: "bash",
            params: { command: "bun test" },
            providerExecuted: false,
            metadata: {},
          }),
          result: Response.makePart("tool-result", {
            id: "bash-call",
            name: "bash",
            result: { running: false, processId: "p1", exitCode: 0, stdout },
            encodedResult: {},
            isFailure: false,
            providerExecuted: false,
            preliminary: false,
            metadata: {},
          }),
        }),
      ),
    )
    expect(block(bash, "ToolCall")).toMatchObject({
      _tag: "Block",
      block: {
        detail: "bun test",
        status: "complete",
        result: { running: false, processId: "p1", exitCode: 0, stdout },
        process: { processId: "p1", exitCode: 0, stdout },
      },
    })
  })

  it("rebuilds a committed model response and topology before continuing", () => {
    resetEventPosition()
    const first = TreeProjector.make("turn-resume", "continue")
    const events = [
      treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }),
      modelResponse("raw-root-run", { type: "text", text: "hello", metadata: {} }),
    ]
    const committed = first.applyAll(events)
    const resumed = TreeProjector.make("turn-resume", "continue")
    resumed.applyAll(events)
    const completed = resumed.apply(
      treeEvent(
        "raw-root-run",
        runEvent({
          _tag: "RunCompleted",
          result: { text: "hello", turns: 1, session: { sessionId: "session", leafId: null } },
        }),
      ),
    )
    expect(completed.baseRevision).toBe(committed.revision)
    expect(
      resumed
        .snapshot()
        .units.find(
          (unit) => unit.content._tag === "Entry" && unit.content.role === "assistant" && unit.content.text === "hello",
        )?.content,
    ).toMatchObject({ _tag: "Entry", role: "assistant", text: "hello" })
  })

  it("projects typed authorization state and its resolution", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-auth", "approve")
    const waitingEvent = treeEvent("raw-root-run", {
      _tag: "RunWaiting",
      wait: {
        waitId: "raw-wait",
        reason: {
          _tag: "Approval",
          request: { approvalId: "approval-1", operation: "write", capability: "workspace", input: {} },
        },
        status: "open",
        openedAt: occurredAt(0),
      },
    })
    const waiting = projector.apply(waitingEvent)
    expect(waiting.state.status).toBe("waiting")
    const authorization = block(waiting, "AuthorizationCard")
    const authorizationId =
      authorization?._tag === "Block" && authorization.block._tag === "AuthorizationCard" ? authorization.block.id : ""
    expect(authorizationId).toMatch(/^authorization-/)
    expect(authorization).toEqual({
      _tag: "Block",
      block: {
        _tag: "AuthorizationCard",
        id: authorizationId,
        operation: "write",
        capability: "workspace",
        input: "{}",
        inputTruncated: false,
        status: "pending",
      },
    })
    const replayed = TreeProjector.make("turn-auth", "approve")
    replayed.apply(waitingEvent)
    const resumed = replayed.apply(
      treeEvent("raw-root-run", {
        _tag: "RunResumed",
        waitId: "raw-wait",
        resolution: { _tag: "Approved" },
      }),
    )
    expect(block(resumed, "AuthorizationCard")).toMatchObject({
      _tag: "Block",
      block: { status: "approved" },
    })
  })
})
