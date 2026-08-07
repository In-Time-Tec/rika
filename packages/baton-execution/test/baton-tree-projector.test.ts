import type { RunTree } from "@batonfx/runtime"
import { describe, expect, it } from "@effect/vitest"
import { TreeProjector } from "../src/baton-tree-projector"
import { compareUnitOrder } from "@rika/transcript/transcript-unit-order"
import {
  assistantOf,
  block,
  modelPart,
  occurredAt,
  resetEventPosition,
  treeEvent,
} from "./baton-projector-event-fixtures"

describe("Baton tree projector", () => {
  it("preserves a multi-chunk user prompt exactly across restart", () => {
    resetEventPosition()
    const prompt = "user-".repeat(5_000)
    const projector = TreeProjector.make("turn-large-user", prompt)
    const initial = projector
      .snapshot()
      .units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "user")
    expect(initial[0]?.key).toBe("turn:turn-large-user:user")
    expect(initial.map((unit) => (unit.content._tag === "Entry" ? unit.content.text : "")).join("")).toBe(prompt)
    const changed = projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    const resumed = TreeProjector.make("turn-large-user", prompt, changed.checkpoint, projector.snapshot().units)
    expect(
      resumed
        .snapshot()
        .units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "user")
        .map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))
        .join(""),
    ).toBe(prompt)
  })

  it("chunks long assistant and reasoning output losslessly without truncation", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-long-output", "chunk output")
    const assistantText = "assistant-".repeat(7_000)
    const reasoningText = "reasoning-".repeat(7_000)
    projector.apply(modelPart("raw-root-run", { type: "text-delta", id: "long-text", delta: assistantText }))
    projector.apply(
      modelPart("raw-root-run", { type: "reasoning-delta", id: "long-reasoning", delta: reasoningText } as never),
    )
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
    expect(
      ordered.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant").length,
    ).toBeGreaterThan(1)
    expect(
      ordered.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Reasoning").length,
    ).toBeGreaterThan(1)
  })

  it("marks bounded subagent prompts and authorization inputs as truncated", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-honest-bounds", "bounds")
    const large = "x".repeat(20_000)
    const linked = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ChildLinked",
        childRunId: "raw-large-child",
        invocationId: "large-child",
        selection: "Review",
        prompt: large,
      } as never),
    )
    expect(block(linked, "SubagentCard")).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ promptTruncated: true, prompt: expect.stringMatching(/^…/) }),
    })
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
      } as never),
    )
    expect(block(waiting, "AuthorizationCard")).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ inputTruncated: true, input: expect.stringMatching(/^…/) }),
    })
  })

  it("preserves read, edit, and bash product semantics", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-tools", "use tools")
    const read = projector.apply(
      modelPart("raw-root-run", {
        type: "tool-call",
        id: "read-call",
        name: "read",
        params: { path: "src/a.ts", read_range: [2, 7] },
        providerExecuted: false,
        metadata: {},
      }),
    )
    expect(block(read, "ToolCall")).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ detail: "src/a.ts L2-7", status: "running" }),
    })
    const edit = projector.apply(
      modelPart("raw-root-run", {
        type: "tool-call",
        id: "edit-call",
        name: "edit",
        params: { path: "src/a.ts", old_str: "old", new_str: "new\nline" },
        providerExecuted: false,
        metadata: {},
      }),
    )
    const editBlock = block(edit, "ToolCall")
    expect(editBlock?._tag === "Block" && editBlock.block._tag === "ToolCall" ? editBlock.block.files : []).toEqual([
      expect.objectContaining({ path: "src/a.ts", additions: 2, deletions: 1, preview: true }),
    ])
    projector.apply(
      modelPart("raw-root-run", {
        type: "tool-call",
        id: "bash-call",
        name: "bash",
        params: { command: "bun test" },
        providerExecuted: false,
        metadata: {},
      }),
    )
    const bash = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionCompleted",
        turn: 0,
        call: {
          type: "tool-call",
          id: "bash-call",
          name: "bash",
          params: { command: "bun test" },
          providerExecuted: false,
          metadata: {},
        },
        result: {
          type: "tool-result",
          id: "bash-call",
          name: "bash",
          result: { running: false, processId: "p1", exitCode: 0, stdout: "ok" },
          encodedResult: {},
          isFailure: false,
          providerExecuted: false,
          preliminary: false,
          metadata: {},
        },
      } as never),
    )
    expect(block(bash, "ToolCall")).toEqual({
      _tag: "Block",
      block: expect.objectContaining({
        detail: "bun test",
        status: "complete",
        process: expect.objectContaining({ processId: "p1", exitCode: 0, stdout: "ok" }),
      }),
    })
  })

  it("restores partial model output and topology from one opaque checkpoint", () => {
    resetEventPosition()
    const first = TreeProjector.make("turn-resume", "continue")
    first.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    const partial = first.apply(modelPart("raw-root-run", { type: "text-delta", id: "text", delta: "hel" }))
    const resumed = TreeProjector.make("turn-resume", "continue", partial.checkpoint, first.snapshot().units)
    const completed = resumed.apply(modelPart("raw-root-run", { type: "text-delta", id: "text", delta: "lo" }))
    expect(completed.baseRevision).toBe(partial.revision)
    expect(
      resumed
        .snapshot()
        .units.find(
          (unit) => unit.content._tag === "Entry" && unit.content.role === "assistant" && unit.content.text === "hello",
        )?.content,
    ).toEqual({ _tag: "Entry", role: "assistant", text: "hello" })
  })

  it("projects typed authorization state and its resolution", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-auth", "approve")
    const waiting = projector.apply(
      treeEvent("raw-root-run", {
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
      }),
    )
    expect(waiting.state.status).toBe("waiting")
    expect(block(waiting, "AuthorizationCard")).toEqual({
      _tag: "Block",
      block: {
        _tag: "AuthorizationCard",
        id: expect.stringMatching(/^authorization-/),
        operation: "write",
        capability: "workspace",
        input: "{}",
        inputTruncated: false,
        status: "pending",
      },
    })
    const resumed = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunResumed",
        waitId: "raw-wait",
        resolution: { _tag: "Approved" },
      }),
    )
    expect(block(resumed, "AuthorizationCard")).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ status: "approved" }),
    })
  })

  it("keeps the opaque checkpoint bounded after a long materialized history", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-long", "long")
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    for (let index = 0; index < 500; index += 1) {
      projector.apply(
        modelPart("raw-root-run", { type: "text-delta", id: `text-${index}`, delta: `response-${index}` }),
      )
      projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: index + 1 }))
    }
    const partial = projector.apply(modelPart("raw-root-run", { type: "text-delta", id: "active", delta: "partial-" }))
    expect(partial.checkpoint.state.length).toBeLessThanOrEqual(1_000_000)
    expect(projector.snapshot().hasOlder).toBe(true)
    const resumed = TreeProjector.make("turn-long", "long", partial.checkpoint, projector.snapshot().units)
    resumed.apply(modelPart("raw-root-run", { type: "text-delta", id: "active", delta: "continued" }))
    expect(
      resumed
        .snapshot()
        .units.find(
          (unit) =>
            unit.content._tag === "Entry" &&
            unit.content.role === "assistant" &&
            unit.content.text === "partial-continued",
        )?.content,
    ).toEqual({ _tag: "Entry", role: "assistant", text: "partial-continued" })
  })

  it("externalizes near-limit concurrent active unit content across restart", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-wide-resume", "wide")
    const stored = new Map<string, ReturnType<typeof projector.snapshot>["units"][number]>()
    const apply = (event: RunTree.TreeEvent) => {
      const change = projector.apply(event)
      for (const key of change.remove) stored.delete(key)
      for (const unit of change.upsert) stored.set(unit.key, unit)
      return change
    }
    const large = "x".repeat(16_000)
    let latest!: ReturnType<typeof apply>
    for (let index = 0; index < 64; index += 1) {
      const child = `raw-active-${index}`
      latest = apply(
        treeEvent("raw-root-run", {
          _tag: "ChildLinked",
          childRunId: child,
          invocationId: `active-${index}`,
          selection: "Review",
          prompt: large,
        } as never),
      )
      latest = apply(
        modelPart(
          child,
          { type: "text-delta", id: "partial", delta: large },
          {
            parentRunId: "raw-root-run",
            invocationId: `active-${index}`,
          },
        ),
      )
    }
    expect([...stored.values()].reduce((size, unit) => size + JSON.stringify(unit).length, 0)).toBeGreaterThan(
      1_000_000,
    )
    expect(latest.checkpoint.state.length).toBeLessThan(1_000_000)
    const resumed = TreeProjector.make("turn-wide-resume", "wide", latest.checkpoint, [...stored.values()])
    const continued = resumed.apply(
      modelPart(
        "raw-active-0",
        { type: "text-delta", id: "partial", delta: "done" },
        {
          parentRunId: "raw-root-run",
          invocationId: "active-0",
        },
      ),
    )
    for (const unit of continued.upsert) stored.set(unit.key, unit)
    const continuedUnit = continued.upsert.find(
      (unit) => unit.parentId !== undefined && unit.content._tag === "Entry" && unit.content.text.endsWith("done"),
    )
    expect(continuedUnit).toBeDefined()
    expect(
      [...stored.values()]
        .filter((unit) => unit.parentId === continuedUnit!.parentId && unit.content._tag === "Entry")
        .toSorted((left, right) => left.order[0]!.part - right.order[0]!.part)
        .map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))
        .join(""),
    ).toBe(`${large}done`)
  })

  it("isolates identical approval ids in sibling runs and resolves private targets", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-auth-siblings", "authorize")
    for (const [invocationId, childRunId] of [
      ["left", "raw-left"],
      ["right", "raw-right"],
    ] as const)
      projector.apply(
        treeEvent("raw-root-run", {
          _tag: "ChildLinked",
          childRunId,
          invocationId,
          selection: "Review",
          prompt: "authorize",
        } as never),
      )
    const changes = ["raw-left", "raw-right"].map((runId) =>
      projector.apply(
        treeEvent(
          runId,
          {
            _tag: "RunWaiting",
            wait: {
              waitId: "same-approval",
              status: "open",
              openedAt: occurredAt(1),
              reason: {
                _tag: "Approval",
                request: { approvalId: "same-approval", operation: "write", capability: "workspace", input: {} },
              },
            },
          } as never,
          { parentRunId: "raw-root-run" },
        ),
      ),
    )
    const cards = changes.flatMap((change) =>
      change.upsert.flatMap((unit) =>
        unit.content._tag === "Block" && unit.content.block._tag === "AuthorizationCard" ? [unit.content.block] : [],
      ),
    )
    expect(new Set(cards.map((card) => card.id)).size).toBe(2)
    expect(TreeProjector.authorizationTarget(changes[1]!.checkpoint, cards[0]!.id)).toEqual({
      runId: "raw-left",
      approvalId: "same-approval",
    })
    projector.apply(
      treeEvent(
        "raw-left",
        {
          _tag: "RunResumed",
          waitId: "same-approval",
          resolution: { _tag: "Approved" },
        },
        { parentRunId: "raw-root-run" },
      ),
    )
    expect(projector.snapshot().units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: {
            _tag: "Block",
            block: expect.objectContaining({ id: cards[0]!.id, status: "approved" }),
          },
        }),
        expect.objectContaining({
          content: {
            _tag: "Block",
            block: expect.objectContaining({ id: cards[1]!.id, status: "pending" }),
          },
        }),
      ]),
    )
  })

  it.each([
    ["RunCancelled", "cancelled"],
    ["RunFailed", "expired"],
  ] as const)("settles pending authorization on %s", (eventTag, status) => {
    resetEventPosition()
    const projector = TreeProjector.make(`turn-${status}`, "authorize")
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunWaiting",
        wait: {
          waitId: "ask-token",
          reason: {
            _tag: "Approval",
            request: { approvalId: "ask-token", operation: "write", capability: "workspace", input: {} },
          },
        },
      } as never),
    )
    const settled = projector.apply(
      eventTag === "RunCancelled"
        ? treeEvent("raw-root-run", { _tag: "RunCancelled", reason: "stopped" })
        : treeEvent("raw-root-run", { _tag: "RunFailed", error: new Error("failed") } as never),
    )
    expect(block(settled, "AuthorizationCard")).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ status }),
    })
  })

  it("correlates typed approval control by approval id rather than tool call id", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-ask", "ask")
    const requested = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ApprovalRequested",
        turn: 0,
        call: {
          type: "tool-call",
          id: "different-tool-call",
          name: "write",
          params: {},
          providerExecuted: false,
          metadata: {},
        },
        request: { approvalId: "ask-token", operation: "write", capability: "workspace", input: { path: "a.ts" } },
      } as never),
    )
    const requestedCard = requested.upsert.find(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "AuthorizationCard",
    )
    expect(requestedCard?.content).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ id: expect.stringMatching(/^authorization-/), status: "pending" }),
    })
    const resumed = projector.apply(
      treeEvent("raw-root-run", { _tag: "RunResumed", waitId: "ask-token", resolution: { _tag: "Approved" } }),
    )
    expect(resumed.upsert).toEqual([
      expect.objectContaining({
        key: requestedCard?.key,
        content: { _tag: "Block", block: expect.objectContaining({ status: "approved" }) },
      }),
    ])
  })

  it("uses the terminal provisional prompt identity exactly once", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-echo", "one prompt")
    const snapshot = projector.snapshot()
    expect(snapshot.units).toHaveLength(1)
    expect(snapshot.units[0]?.key).toBe("turn:turn-echo:user")
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    expect(projector.snapshot().units.filter((unit) => unit.key === "turn:turn-echo:user")).toHaveLength(1)
  })

  it("keeps sequential turns on disjoint unit keys so every turn keeps its own answer", () => {
    resetEventPosition()
    const first = TreeProjector.make("turn-sequential-one", "prompt one")
    first.apply(treeEvent("raw-run-one", { _tag: "TurnStarted", turn: 0 }))
    first.apply(modelPart("raw-run-one", { type: "text-delta", id: "text", delta: "FIRST_ANSWER" }))
    const second = TreeProjector.make("turn-sequential-two", "prompt two")
    second.apply(treeEvent("raw-run-two", { _tag: "TurnStarted", turn: 0 }))
    second.apply(modelPart("raw-run-two", { type: "text-delta", id: "text", delta: "SECOND_ANSWER" }))

    const firstAssistant = assistantOf(first)
    const secondAssistant = assistantOf(second)

    expect(firstAssistant.map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))).toEqual([
      "FIRST_ANSWER",
    ])
    expect(secondAssistant.map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))).toEqual([
      "SECOND_ANSWER",
    ])
    const firstKeys = new Set(first.snapshot().units.map((unit) => unit.key))
    const secondKeys = new Set(second.snapshot().units.map((unit) => unit.key))
    expect([...firstKeys].some((key) => secondKeys.has(key))).toBe(false)
  })

  it("restores chunk continuation from a checkpoint captured within the same turn", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-chunked-restore", "chunk me")
    projector.apply(treeEvent("raw-chunk-run", { _tag: "TurnStarted", turn: 0 }))
    const opening = projector.apply(modelPart("raw-chunk-run", { type: "text-delta", id: "text", delta: "OPENING " }))
    const resumed = TreeProjector.make(
      "turn-chunked-restore",
      "chunk me",
      opening.checkpoint,
      projector.snapshot().units,
    )
    resumed.apply(modelPart("raw-chunk-run", { type: "text-delta", id: "text", delta: "CONTINUED" }))
    const assistant = resumed
      .snapshot()
      .units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")
    expect(assistant).toHaveLength(1)
    expect(assistant[0]?.content._tag === "Entry" ? assistant[0].content.text : "").toBe("OPENING CONTINUED")
  })

  it("parks the root as waiting when an interrupted operation needs resolution", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-resolution", "cancel me")
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "RunCancellationRequested", reason: "Cancelled by Rika" }))
    expect(projector.snapshot().state.status).toBe("cancelling")

    // A replayPolicy:"never" tool interrupted mid-flight parks the Run in needs-resolution.
    const parked = projector.apply(treeEvent("raw-root-run", { _tag: "OperationUnknown", operationId: "op-1" }))
    expect(projector.snapshot().state.status).toBe("waiting")
    expect(parked.upsert.some((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error")).toBe(
      true,
    )
  })

  it("keeps a parked root overridable by the terminal event that follows resolution", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-resolution-terminal", "cancel me")
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "RunCancellationRequested", reason: "Cancelled by Rika" }))
    projector.apply(treeEvent("raw-root-run", { _tag: "OperationUnknown", operationId: "op-1" }))
    expect(projector.snapshot().state.status).toBe("waiting")

    // Resolving the parked operation lets the run reach its real terminal state.
    projector.apply(treeEvent("raw-root-run", { _tag: "RunCancelled", reason: "Cancelled by Rika" }))
    expect(projector.snapshot().state.status).toBe("cancelled")
  })

  it("does not double-settle active time when an operation parks a run that already waited", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-resolution-waited", "cancel me")
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunWaiting",
        wait: { waitId: "wait-1", reason: { _tag: "Operation" } },
      } as never),
    )
    expect(projector.snapshot().state.status).toBe("waiting")

    // OperationUnknown arriving after the node already parked must not decrement active depth twice.
    expect(() =>
      projector.apply(treeEvent("raw-root-run", { _tag: "OperationUnknown", operationId: "op-1" })),
    ).not.toThrow()
    expect(projector.snapshot().state.status).toBe("waiting")
  })

  it("carries the root failure reason as an execution outcome so the product can report it", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-failed", "say hi")
    const settled = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunFailed",
        error: new Error("OpenAiClient.createResponseStream: InvalidKey: Verify your API key is correct"),
      } as never),
    )
    const failure = settled.upsert.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error")
    expect(failure?.executionOutcome).toEqual({
      status: "failed",
      reason: "OpenAiClient.createResponseStream: InvalidKey: Verify your API key is correct",
    })
  })
})

describe("friendly failure presentation in the projector", () => {
  it("renders a model rate-limit failure with a friendly title, detail, and recovery", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-rate-limit", "say hello")
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAccepted" }))
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted" }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ModelCallFailed",
        deliveryId: "d1",
        turn: 0,
        modelCallId: "model-call:0:conversation",
        purpose: "conversation",
        attempts: 1,
        failedAt: 1,
        category: "rate-limit",
        classification: "terminal",
      }),
    )
    const unit = projector
      .snapshot()
      .units.find((candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "Error")
    expect(unit).toBeDefined()
    if (unit?.content._tag !== "Block" || unit.content.block._tag !== "Error") return
    expect(unit.content.block.title).toBe("Model rate limit reached")
    expect(unit.content.block.detail).toContain("provider limited")
    expect(unit.content.block.recovery).toContain("cannot succeed")
  })

  it("renders a raw provider failure with a cleaned detail", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-provider-error", "say hello")
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAccepted" }))
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted" }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunFailed",
        error: {
          _tag: "@batonfx/runtime/AgentExecutionFailure",
          message: "effect/ai/AiError/AiError: OpenAiClient.createResponseStream: Rate Limit exceeded",
        },
      } as never),
    )
    const unit = projector
      .snapshot()
      .units.find((candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "Error")
    expect(unit).toBeDefined()
    if (unit?.content._tag !== "Block" || unit.content.block._tag !== "Error") return
    expect(unit.content.block.detail).toBe(
      "The model provider rate-limited the request. Wait a moment, then try again.",
    )
  })
})
