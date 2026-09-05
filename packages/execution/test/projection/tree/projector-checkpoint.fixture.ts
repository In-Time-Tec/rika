import type { SemanticTreeEvent } from "../../../src/projection/semantic/event"
import { describe, expect, it } from "@effect/vitest"
import { RunEvent } from "generalist/runtime"
import { TreeProjector } from "../../../src/projection/tree/projector"
import { Prompt, Response } from "effect/unstable/ai"
import { Schema } from "effect"
import {
  assistantOf,
  block,
  modelResponse,
  occurredAt,
  resetEventPosition,
  treeEvent,
} from "../../support/projector-event.fixture"

type RunEventInput = {
  [Tag in RunEvent.RunEvent["_tag"]]: Partial<Extract<RunEvent.RunEvent, { readonly _tag: Tag }>> & {
    readonly _tag: Tag
  }
}[RunEvent.RunEvent["_tag"]]
const runEvent = (event: RunEventInput): RunEventInput => event

describe("Generalist tree projector checkpoints and lifecycle", () => {
  it("keeps the presentation checkpoint bounded after a long replay", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-long", "long")
    const events: Array<SemanticTreeEvent> = [treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 })]
    projector.apply(events[0]!)
    for (let index = 0; index < 500; index += 1) {
      const response = modelResponse("raw-root-run", { type: "text", text: `response-${index}`, metadata: {} })
      const turn = treeEvent("raw-root-run", { _tag: "TurnStarted", turn: index + 1 })
      events.push(response, turn)
      projector.applyAll([response, turn])
    }
    const partialEvent = modelResponse("raw-root-run", { type: "text", text: "partial-", metadata: {} })
    events.push(partialEvent)
    const partial = projector.apply(partialEvent)
    expect(partial.checkpoint.state.length).toBeLessThanOrEqual(1_000_000)
    expect(projector.snapshot().hasOlder).toBe(true)
    const resumed = TreeProjector.make("turn-long", "long")
    resumed.applyAll(events)
    resumed.apply(modelResponse("raw-root-run", { type: "text", text: "continued", metadata: {} }))
    expect(
      resumed
        .snapshot()
        .units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")
        .slice(-2)
        .map((unit) => (unit.content._tag === "Entry" ? unit.content.text : "")),
    ).toEqual(["partial-", "continued"])
  })

  it("rebuilds near-limit concurrent active unit content from durable events", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-wide-resume", "wide")
    const events: Array<SemanticTreeEvent> = []
    const stored = new Map<string, ReturnType<typeof projector.snapshot>["units"][number]>()
    const apply = (event: SemanticTreeEvent) => {
      const change = projector.apply(event)
      for (const key of change.remove) stored.delete(key)
      for (const unit of change.upsert) stored.set(unit.key, unit)
      return change
    }
    const large = "x".repeat(16_000)
    let latest!: ReturnType<typeof apply>
    for (let index = 0; index < 64; index += 1) {
      const child = `raw-active-${index}`
      const linked = treeEvent(
        "raw-root-run",
        runEvent({
          _tag: "ChildLinked",
          childRunId: child,
          invocationId: `active-${index}`,
          selection: "Review",
          prompt: Prompt.make(large),
        }),
      )
      const response = modelResponse(
        child,
        { type: "text", text: large, metadata: {} },
        {
          parentRunId: "raw-root-run",
          invocationId: `active-${index}`,
        },
      )
      events.push(linked, response)
      latest = apply(linked)
      latest = apply(response)
    }
    expect([...stored.values()].reduce((size, unit) => size + JSON.stringify(unit).length, 0)).toBeGreaterThan(
      1_000_000,
    )
    expect(latest.checkpoint.state.length).toBeLessThan(1_000_000)
    const resumed = TreeProjector.make("turn-wide-resume", "wide")
    resumed.applyAll(events)
    const continued = resumed.apply(
      modelResponse(
        "raw-active-0",
        { type: "text", text: "done", metadata: {} },
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
        .toSorted((left, right) => left.order[0].part - right.order[0].part)
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
        treeEvent(
          "raw-root-run",
          runEvent({
            _tag: "ChildLinked",
            childRunId,
            invocationId,
            selection: "Review",
            prompt: Prompt.make("authorize"),
          }),
        ),
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
          },
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
    expect(() =>
      TreeProjector.authorizationTarget({ ...changes[1]!.checkpoint, state: "not-json" }, cards[0]!.id),
    ).toThrow("Rika presentation checkpoint could not be decoded")
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
    const settledCards = projector
      .snapshot()
      .units.flatMap((unit) =>
        unit.content._tag === "Block" && unit.content.block._tag === "AuthorizationCard"
          ? [{ id: unit.content.block.id, status: unit.content.block.status }]
          : [],
      )
    expect(settledCards).toEqual([
      { id: cards[0]!.id, status: "approved" },
      { id: cards[1]!.id, status: "pending" },
    ])
  })

  it.each([
    ["RunCancelled", "cancelled"],
    ["RunFailed", "expired"],
  ] as const)("settles pending authorization on %s", (eventTag, status) => {
    resetEventPosition()
    const projector = TreeProjector.make(`turn-${status}`, "authorize")
    projector.apply(
      treeEvent(
        "raw-root-run",
        runEvent({
          _tag: "RunWaiting",
          wait: {
            waitId: "ask-token",
            status: "open",
            openedAt: occurredAt(1),
            reason: {
              _tag: "Approval",
              request: { approvalId: "ask-token", operation: "write", capability: "workspace", input: {} },
            },
          },
        }),
      ),
    )
    const settled = projector.apply(
      eventTag === "RunCancelled"
        ? treeEvent("raw-root-run", { _tag: "RunCancelled", reason: "stopped" })
        : treeEvent(
            "raw-root-run",
            runEvent({
              _tag: "RunFailed",
              error: Schema.decodeSync(RunEvent.RunFailure)({
                _tag: "generalist/runtime/AgentExecutionFailure",
                message: "failed",
              }),
            }),
          ),
    )
    expect(block(settled, "AuthorizationCard")).toMatchObject({
      _tag: "Block",
      block: { status },
    })
  })

  it("correlates typed approval control by approval id rather than tool call id", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-ask", "ask")
    const requested = projector.apply(
      treeEvent(
        "raw-root-run",
        runEvent({
          _tag: "ApprovalRequested",
          turn: 0,
          call: Response.toolCallPart({
            id: "different-tool-call",
            name: "write",
            params: {},
            providerExecuted: false,
            metadata: {},
          }),
          request: { approvalId: "ask-token", operation: "write", capability: "workspace", input: { path: "a.ts" } },
        }),
      ),
    )
    const requestedCard = requested.upsert.find(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "AuthorizationCard",
    )
    expect(requestedCard?.content).toMatchObject({
      _tag: "Block",
      block: { id: /^authorization-/, status: "pending" },
    })
    const resumed = projector.apply(
      treeEvent("raw-root-run", { _tag: "RunResumed", waitId: "ask-token", resolution: { _tag: "Approved" } }),
    )
    expect(resumed.upsert).toMatchObject([
      {
        key: requestedCard?.key,
        content: { _tag: "Block", block: { status: "approved" } },
      },
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
    first.apply(modelResponse("raw-run-one", { type: "text", text: "FIRST_ANSWER", metadata: {} }))
    const second = TreeProjector.make("turn-sequential-two", "prompt two")
    second.apply(treeEvent("raw-run-two", { _tag: "TurnStarted", turn: 0 }))
    second.apply(modelResponse("raw-run-two", { type: "text", text: "SECOND_ANSWER", metadata: {} }))

    const firstAssistant = assistantOf(first)
    const secondAssistant = assistantOf(second)

    expect(firstAssistant.map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))).toMatchObject([
      "FIRST_ANSWER",
    ])
    expect(secondAssistant.map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))).toMatchObject([
      "SECOND_ANSWER",
    ])
    const firstKeys = new Set(first.snapshot().units.map((unit) => unit.key))
    const secondKeys = new Set(second.snapshot().units.map((unit) => unit.key))
    expect([...firstKeys].some((key) => secondKeys.has(key))).toBe(false)
  })

  it("rebuilds committed response boundaries within the same turn", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-chunked-restore", "chunk me")
    const events = [
      treeEvent("raw-chunk-run", { _tag: "TurnStarted", turn: 0 }),
      modelResponse("raw-chunk-run", { type: "text", text: "OPENING ", metadata: {} }),
    ]
    projector.applyAll(events)
    const resumed = TreeProjector.make("turn-chunked-restore", "chunk me")
    resumed.applyAll(events)
    resumed.apply(modelResponse("raw-chunk-run", { type: "text", text: "CONTINUED", metadata: {} }))
    const assistant = resumed
      .snapshot()
      .units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")
    expect(assistant.map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))).toMatchObject([
      "OPENING ",
      "CONTINUED",
    ])
  })

  it("projects cancellation state without adding user-visible transcript content", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-silent-cancellation", "cancel me")
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    const before = projector.snapshot().units

    const cancellation = projector.apply(
      treeEvent("raw-root-run", { _tag: "RunCancellationRequested", reason: "Cancelled by user" }),
    )

    expect(cancellation.state.status).toBe("cancelling")
    expect(cancellation.upsert).toMatchObject([])
    expect(cancellation.remove).toMatchObject([])
    expect(projector.snapshot().units).toMatchObject(before)
    expect(projector.snapshot().state.status).toBe("cancelling")
  })

  it("parks the root as waiting when an interrupted operation needs resolution", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-resolution", "cancel me")
    const events = [
      treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }),
      treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }),
      treeEvent("raw-root-run", { _tag: "OperationUnknown", operationId: "op-1" }),
    ]
    const parked = projector.applyAll(events)
    expect(projector.snapshot().state.status).toBe("waiting")
    expect(parked.upsert.some((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error")).toBe(
      false,
    )
    const notice = parked.upsert.find(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "Notification",
    )
    expect(notice?.executionOutcome).toBeUndefined()
    expect(notice?.content).toMatchObject({
      _tag: "Block",
      block: {
        _tag: "Notification",
        title: "Waiting for operation recovery",
      },
    })
    if (notice?.content._tag !== "Block" || notice.content.block._tag !== "Notification")
      throw new Error("Missing recovery notification")
    expect(notice.content.block.detail).toContain("Run: raw-root-run; operation: op-1.")
    expect(notice.content.block.detail).toContain("shell_command_status consumes buffered output")
    expect(notice.content.block.detail).toContain("Retry can repeat side effects")
    const restored = TreeProjector.make("turn-resolution", "cancel me")
    restored.applyAll(events)
    expect(restored.snapshot().units).toEqual(projector.snapshot().units)
    expect(restored.snapshot().state.status).toBe("waiting")
  })

  it("keeps cancellation authoritative when a never-replay nested operation becomes unknown", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-resolution-terminal", "cancel me")
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "RunCancellationRequested", reason: "Cancelled by user" }))
    const unknown = projector.apply(treeEvent("raw-root-run", { _tag: "OperationUnknown", operationId: "op-1" }))
    expect(projector.snapshot().state.status).toBe("cancelling")
    expect(unknown.upsert.some((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error")).toBe(
      false,
    )

    projector.apply(treeEvent("raw-root-run", { _tag: "RunCancelled", reason: "Cancelled by user" }))
    expect(projector.snapshot().state.status).toBe("cancelled")
  })

  it("accepts tool suspension metadata while RunWaiting owns the waiting state", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-tool-wait", "wait for the tool")
    const call = Response.toolCallPart({
      id: "tool-call-1",
      name: "read",
      params: { path: "fixture.ts" },
      providerExecuted: false,
      metadata: {},
    })
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "ToolExecutionStarted", turn: 0, call }))

    const suspended = projector.apply(
      treeEvent(
        "raw-root-run",
        runEvent({ _tag: "ToolExecutionWaiting", turn: 0, call, waitId: "wait-1", token: "nested-token" }),
      ),
    )
    expect(suspended.state.status).toBe("running")
    expect(suspended.upsert).toEqual([])
    expect(suspended.remove).toEqual([])

    const waiting = projector.apply(
      treeEvent(
        "raw-root-run",
        runEvent({
          _tag: "RunWaiting",
          wait: { waitId: "wait-1", status: "open", openedAt: occurredAt(1), reason: { _tag: "ToolWait" } },
        }),
      ),
    )
    expect(waiting.state.status).toBe("waiting")
  })

  it("does not double-settle active time when an operation parks a run that already waited", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-resolution-waited", "cancel me")
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(
      treeEvent(
        "raw-root-run",
        runEvent({
          _tag: "RunWaiting",
          wait: { waitId: "wait-1", status: "open", openedAt: occurredAt(1), reason: { _tag: "ToolWait" } },
        }),
      ),
    )
    expect(projector.snapshot().state.status).toBe("waiting")

    expect(() =>
      projector.apply(treeEvent("raw-root-run", { _tag: "OperationUnknown", operationId: "op-1" })),
    ).not.toThrow()
    expect(projector.snapshot().state.status).toBe("waiting")
  })

  it("carries the root failure reason as an execution outcome so the product can report it", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-failed", "say hi")
    const settled = projector.apply(
      treeEvent(
        "raw-root-run",
        runEvent({
          _tag: "RunFailed",
          error: Schema.decodeSync(RunEvent.RunFailure)({
            _tag: "generalist/runtime/AgentExecutionFailure",
            message: "OpenAiClient.createResponseStream: InvalidKey: Verify your API key is correct",
          }),
        }),
      ),
    )
    const failure = settled.upsert.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error")
    expect(failure?.executionOutcome).toMatchObject({
      status: "failed",
      reason: "OpenAiClient.createResponseStream: InvalidKey: Verify your API key is correct",
    })
  })
})
