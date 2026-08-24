import type { SemanticTreeEvent } from "../src/projection/semantic-event"
import { describe, expect, it } from "@effect/vitest"
import { TreeProjector } from "../src/projection/tree"
import type { CheckpointInstrumentation } from "../src/projection/projector-recovery"
import { compareUnitOrder } from "@rika/transcript/transcript-unit-order"
import { Schema } from "effect"
import {
  assistantOf,
  block,
  modelResponse,
  occurredAt,
  resetEventPosition,
  treeEvent,
} from "./projector-event-fixtures"

describe("TenetKit tree projector", () => {
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

  it("preserves long assistant and reasoning output as complete logical responses", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-long-output", "chunk output")
    const assistantText = "assistant-".repeat(7_000)
    const reasoningText = "reasoning-".repeat(7_000)
    projector.apply(modelResponse("raw-root-run", { type: "text", text: assistantText, metadata: {} }))
    projector.apply(modelResponse("raw-root-run", { type: "reasoning", text: reasoningText, metadata: {} } as never))
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
      modelResponse("raw-root-run", {
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
    expect(editBlock?._tag === "Block" && editBlock.block._tag === "ToolCall" ? editBlock.block.files : []).toEqual([
      expect.objectContaining({ path: "src/a.ts", additions: 2, deletions: 1, preview: true }),
    ])
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

  it("produces identical cell units live and after a checkpoint reload", () => {
    resetEventPosition()
    const source = "// warm up\nconst answer = 6 * 7\nanswer"
    const call = {
      type: "tool-call" as const,
      id: "cell-resume",
      name: "typescript",
      params: { code: source },
      providerExecuted: false,
      metadata: {},
    }
    const live = TreeProjector.make("turn-cell-resume", "run a cell")
    live.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    live.apply(treeEvent("raw-root-run", { _tag: "ToolExecutionStarted", turn: 0, call } as never))
    const patch = live.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolProgress",
        turn: 0,
        toolCallId: "cell-resume",
        message: "Stdout",
        data: { _tag: "Stdout", cellId: "cell-resume", sequence: 0, text: "partial output" },
      } as never),
    )
    const reloaded = TreeProjector.make("turn-cell-resume", "run a cell", patch.checkpoint, live.snapshot().units)
    expect(reloaded.snapshot().units).toEqual(live.snapshot().units)
    const completion = (projector: ReturnType<typeof TreeProjector.make>) =>
      projector.apply(
        treeEvent("raw-root-run", {
          _tag: "ToolExecutionCompleted",
          turn: 0,
          call,
          result: {
            type: "tool-result",
            id: "cell-resume",
            name: "typescript",
            result: {
              cellId: "cell-resume",
              epoch: 1,
              sequence: 2,
              value: "42",
              stdout: "partial output",
              stderr: "",
              durationMillis: 8,
              truncation: [],
            },
            encodedResult: {},
            isFailure: false,
            providerExecuted: false,
            preliminary: false,
            metadata: {},
          },
        } as never),
      )
    resetEventPosition()
    const livePosition = completion(live)
    resetEventPosition()
    const reloadedPosition = completion(reloaded)
    expect(reloadedPosition.upsert).toEqual(livePosition.upsert)
    expect(reloaded.snapshot().units).toEqual(live.snapshot().units)
    expect(
      reloaded.snapshot().units.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Cell")
        ?.content,
    ).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ status: "complete", result: "42", durationMillis: 8, epoch: 1 }),
    })
  })

  it("keeps a running cell across a Server restart and drops a settled one from the checkpoint", () => {
    resetEventPosition()
    const cellCall = (id: string, code: string) => ({
      type: "tool-call" as const,
      id,
      name: "typescript",
      params: { code },
      providerExecuted: false,
      metadata: {},
    })
    const projector = TreeProjector.make("turn-cell-retention", "retain")
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(
      treeEvent("raw-root-run", { _tag: "ToolExecutionStarted", turn: 0, call: cellCall("done", "1") } as never),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionCompleted",
        turn: 0,
        call: cellCall("done", "1"),
        result: {
          type: "tool-result",
          id: "done",
          name: "typescript",
          result: {
            cellId: "done",
            epoch: 0,
            sequence: 1,
            value: "1",
            stdout: "",
            stderr: "",
            durationMillis: 1,
            truncation: [],
          },
          encodedResult: {},
          isFailure: false,
          providerExecuted: false,
          preliminary: false,
          metadata: {},
        },
      } as never),
    )
    const patch = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionStarted",
        turn: 0,
        call: cellCall("live", "await forever()"),
      } as never),
    )
    const persisted = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(patch.checkpoint.state) as {
      readonly nodes: ReadonlyArray<{ readonly cells: ReadonlyArray<readonly [string, unknown]> }>
    }
    expect(persisted.nodes.flatMap((node) => node.cells.map(([rawId]) => rawId))).toEqual(["live"])
    const resumed = TreeProjector.make("turn-cell-retention", "retain", patch.checkpoint, projector.snapshot().units)
    const settled = resumed.apply(treeEvent("raw-root-run", { _tag: "RunCancelled", reason: "restarted" } as never))
    expect(
      settled.upsert.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Cell")?.content,
    ).toEqual({ _tag: "Block", block: expect.objectContaining({ status: "cancelled" }) })
  })

  it("restores a committed model response and topology from one opaque checkpoint", () => {
    resetEventPosition()
    const first = TreeProjector.make("turn-resume", "continue")
    first.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    const committed = first.apply(modelResponse("raw-root-run", { type: "text", text: "hello", metadata: {} }))
    const resumed = TreeProjector.make("turn-resume", "continue", committed.checkpoint, first.snapshot().units)
    const completed = resumed.apply(
      treeEvent("raw-root-run", { _tag: "RunCompleted", result: { text: "hello" } } as never),
    )
    expect(completed.baseRevision).toBe(committed.revision)
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
      projector.apply(modelResponse("raw-root-run", { type: "text", text: `response-${index}`, metadata: {} }))
      projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: index + 1 }))
    }
    const partial = projector.apply(modelResponse("raw-root-run", { type: "text", text: "partial-", metadata: {} }))
    expect(partial.checkpoint.state.length).toBeLessThanOrEqual(1_000_000)
    expect(projector.snapshot().hasOlder).toBe(true)
    const resumed = TreeProjector.make("turn-long", "long", partial.checkpoint, projector.snapshot().units)
    resumed.apply(modelResponse("raw-root-run", { type: "text", text: "continued", metadata: {} }))
    expect(
      resumed
        .snapshot()
        .units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")
        .slice(-2)
        .map((unit) => (unit.content._tag === "Entry" ? unit.content.text : "")),
    ).toEqual(["partial-", "continued"])
  })

  it("externalizes near-limit concurrent active unit content across restart", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-wide-resume", "wide")
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
        modelResponse(
          child,
          { type: "text", text: large, metadata: {} },
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
    first.apply(modelResponse("raw-run-one", { type: "text", text: "FIRST_ANSWER", metadata: {} }))
    const second = TreeProjector.make("turn-sequential-two", "prompt two")
    second.apply(treeEvent("raw-run-two", { _tag: "TurnStarted", turn: 0 }))
    second.apply(modelResponse("raw-run-two", { type: "text", text: "SECOND_ANSWER", metadata: {} }))

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

  it("restores committed response boundaries from a checkpoint within the same turn", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-chunked-restore", "chunk me")
    projector.apply(treeEvent("raw-chunk-run", { _tag: "TurnStarted", turn: 0 }))
    const opening = projector.apply(modelResponse("raw-chunk-run", { type: "text", text: "OPENING ", metadata: {} }))
    const resumed = TreeProjector.make(
      "turn-chunked-restore",
      "chunk me",
      opening.checkpoint,
      projector.snapshot().units,
    )
    resumed.apply(modelResponse("raw-chunk-run", { type: "text", text: "CONTINUED", metadata: {} }))
    const assistant = resumed
      .snapshot()
      .units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")
    expect(assistant.map((unit) => (unit.content._tag === "Entry" ? unit.content.text : ""))).toEqual([
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
    expect(cancellation.upsert).toEqual([])
    expect(cancellation.remove).toEqual([])
    expect(projector.snapshot().units).toEqual(before)
  })

  it("parks the root as waiting when an interrupted operation needs resolution", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-resolution", "cancel me")
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "RunCancellationRequested", reason: "Cancelled by user" }))
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
    projector.apply(treeEvent("raw-root-run", { _tag: "RunCancellationRequested", reason: "Cancelled by user" }))
    projector.apply(treeEvent("raw-root-run", { _tag: "OperationUnknown", operationId: "op-1" }))
    expect(projector.snapshot().state.status).toBe("waiting")

    // Resolving the parked operation lets the run reach its real terminal state.
    projector.apply(treeEvent("raw-root-run", { _tag: "RunCancelled", reason: "Cancelled by user" }))
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

  it("checkpoints indexed recovery without visiting settled history and restores the next patch exactly", () => {
    resetEventPosition()
    const visits = new Map<string, number>()
    const instrumentation: CheckpointInstrumentation = {
      visit: (kind) => visits.set(kind, (visits.get(kind) ?? 0) + 1),
    }
    const projector = TreeProjector.make(
      "turn-incremental-checkpoint",
      "incremental",
      undefined,
      [],
      false,
      "metered",
      instrumentation,
    )
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    for (let index = 0; index < 1_000; index += 1) {
      projector.apply(modelResponse("raw-root-run", { type: "text", text: `settled-${index}`, metadata: {} }))
      projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: index + 1 }))
    }
    const call = {
      type: "tool-call" as const,
      id: "active-cell",
      name: "typescript",
      params: { code: "await activeWork" },
      providerExecuted: false,
      metadata: {},
    }
    projector.apply(treeEvent("raw-root-run", { _tag: "ToolExecutionStarted", turn: 1_000, call } as never))
    projector.apply(
      treeEvent("raw-root-run", { _tag: "CompactionStarted", compactionId: "active-compaction" } as never),
    )
    visits.clear()
    const active = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolProgress",
        turn: 1_000,
        toolCallId: "active-cell",
        data: { _tag: "Stdout", cellId: "active-cell", sequence: 0, text: "one" },
      } as never),
    )
    expect(active.revision).toBeGreaterThan(2_000)
    expect(active.upsert).toEqual([
      expect.objectContaining({ content: { _tag: "Block", block: expect.objectContaining({ _tag: "Cell" }) } }),
    ])
    expect(Object.fromEntries(visits)).toEqual({ node: 1, cell: 1, compaction: 1 })
    const persisted = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(active.checkpoint.state) as {
      readonly nodes: ReadonlyArray<{ readonly cells: ReadonlyArray<readonly [string, unknown]> }>
      readonly runningCompactions: ReadonlyArray<string>
    }
    expect(persisted.nodes.flatMap((node) => node.cells.map(([rawId]) => rawId))).toEqual(["active-cell"])
    expect(persisted.runningCompactions).toHaveLength(1)

    const resumed = TreeProjector.make(
      "turn-incremental-checkpoint",
      "incremental",
      active.checkpoint,
      projector.snapshot().units,
    )
    const next = treeEvent("raw-root-run", {
      _tag: "ToolProgress",
      turn: 1_000,
      toolCallId: "active-cell",
      data: { _tag: "Stdout", cellId: "active-cell", sequence: 1, text: "two" },
    } as never)
    const livePatch = projector.apply(next)
    const resumedPatch = resumed.apply(next)
    expect(resumedPatch).toEqual(livePatch)
    expect(resumed.snapshot()).toEqual(projector.snapshot())
  })
})
