import { describe, expect, it, vi } from "@effect/vitest"
import { RunEvent, type RunTree, type Runtime } from "generalist/runtime"
import { compareUnitOrder } from "@rika/product/execution-transcript-contract"
import { modelResponseId } from "@rika/product/execution-gateway"
import { Effect, Schema } from "effect"
import { resolveSemanticTreeEvent } from "../../../src/projection/semantic/event"
import { TreeProjector } from "../../../src/projection/tree/projector"
import { modelResponseContent, resetEventPosition, treeEvent } from "../../support/projector-event.fixture"

interface ProviderFragment {
  readonly text: string
  readonly params: string
}

const semanticResponse = (fragments: ReadonlyArray<ProviderFragment>) => [
  { type: "text" as const, text: fragments.map((fragment) => fragment.text).join(""), metadata: {} },
  {
    type: "tool-call" as const,
    id: "read-call",
    name: "read",
    params: Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
      fragments.map((fragment) => fragment.params).join(""),
    ),
    providerExecuted: false,
    metadata: {},
  },
]

const distributed = (text: string, count: number): ReadonlyArray<string> => {
  const values = Array.from({ length: count }, () => "")
  for (const [index, character] of [...text].entries()) values[index * 2 + 1] = character
  return values
}

const projectFragments = (fragments: ReadonlyArray<ProviderFragment>) => {
  resetEventPosition()
  const projector = TreeProjector.make("turn-chunk-invariant", "project this")
  projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
  const commits = [
    projector.apply(modelResponseContent("raw-root-run", "model-operation", semanticResponse(fragments))),
  ]
  return { commits, snapshot: projector.snapshot() }
}

describe("Generalist semantic response projection", () => {
  it.effect("hydrates compact committed and interrupted responses through the Runtime API", () =>
    Effect.gen(function* () {
      const tags: Array<string> = []
      const response = yield* Schema.decodeEffect(RunEvent.CompletedModelResponse)({
        content: [{ type: "text", text: "retained output", metadata: {} }],
      })
      const resolveModelResponse: Runtime.Service["resolveModelResponse"] = (event) =>
        Effect.sync(() => {
          tags.push(event._tag)
          return response
        })
      const compact = (tag: "ModelResponseCommitted" | "ModelResponseInterrupted"): RunTree.TreeEvent => {
        const projected =
          tag === "ModelResponseInterrupted"
            ? treeEvent("raw-root-run", {
                _tag: tag,
                operationKey: `operation:${tag}`,
                modelCallId: `call:${tag}`,
                modelAttemptId: `attempt:${tag}`,
                attempt: 0,
                digest: `digest:${tag}`,
                reason: "cancel",
              })
            : treeEvent("raw-root-run", {
                _tag: tag,
                operationKey: `operation:${tag}`,
                modelCallId: `call:${tag}`,
                modelAttemptId: `attempt:${tag}`,
                attempt: 0,
                digest: `digest:${tag}`,
              })
        return { ...projected, event: RunEvent.RunEvent.make(projected.event) }
      }

      const committed = yield* resolveSemanticTreeEvent(compact("ModelResponseCommitted"), resolveModelResponse)
      const interrupted = yield* resolveSemanticTreeEvent(compact("ModelResponseInterrupted"), resolveModelResponse)

      expect(committed.event).toMatchObject({ _tag: "ModelResponseCommitted", response })
      expect(interrupted.event).toMatchObject({ _tag: "ModelResponseInterrupted", response })
      const projector = TreeProjector.make("turn-interrupted", "interrupt")
      projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
      const patch = projector.apply(interrupted)
      expect(patch.upsert).toContainEqual(
        expect.objectContaining({
          modelResponseId: modelResponseId({
            runId: "raw-root-run",
            turn: 0,
            modelCallId: "call:ModelResponseInterrupted",
            modelAttemptId: "attempt:ModelResponseInterrupted",
            attempt: 0,
          }),
          content: { _tag: "Entry", role: "assistant", text: "retained output" },
        }),
      )
      expect(tags).toEqual(["ModelResponseCommitted", "ModelResponseInterrupted"])
    }),
  )

  it("correlates only assistant and reasoning units from the same exact model response", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-response-identity", "identity")
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    const patch = projector.apply(
      modelResponseContent("raw-root-run", "identified-response", [
        { type: "reasoning", text: "inspect", metadata: {} },
        { type: "text", text: "answer", metadata: {} },
        {
          type: "tool-call",
          id: "read-call",
          name: "read",
          params: { path: "src/a.ts" },
          providerExecuted: false,
          metadata: {},
        },
      ]),
    )
    const expected = modelResponseId({
      runId: "raw-root-run",
      turn: 0,
      modelCallId: "identified-response:call",
      modelAttemptId: "identified-response:attempt",
      attempt: 0,
    })
    const responseUnits = patch.upsert.filter(
      (unit) =>
        unit.content._tag === "Entry" || (unit.content._tag === "Block" && unit.content.block._tag === "Reasoning"),
    )
    const toolUnits = patch.upsert.filter(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall",
    )

    expect(responseUnits).toHaveLength(2)
    expect(responseUnits.every((unit) => unit.modelResponseId === expected)).toBe(true)
    expect(toolUnits).toHaveLength(1)
    expect(toolUnits[0]).not.toHaveProperty("modelResponseId")
  })

  it("is invariant to one versus 10,000 half-empty upstream fragments", () => {
    const text = "chunk-invariant output"
    const params = JSON.stringify({ path: "src/a.ts", read_range: [2, 7] })
    const one = projectFragments([{ text, params }])
    const textFragments = distributed(text, 10_000)
    const paramFragments = distributed(params, 10_000)
    const many = projectFragments(
      Array.from({ length: 10_000 }, (_, index) => ({
        text: textFragments[index]!,
        params: paramFragments[index]!,
      })),
    )

    expect(one.commits).toHaveLength(1)
    expect(many.commits).toHaveLength(1)
    expect(many.commits).toEqual(one.commits)
    expect(many.snapshot).toEqual(one.snapshot)
  })

  it("preserves normalized content ordering across text, tools, files, and sources", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-content", "content")
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    const patch = projector.apply(
      modelResponseContent("raw-root-run", "content-response", [
        { type: "reasoning", text: "reason", metadata: {} },
        { type: "text", text: "answer", metadata: {} },
        { type: "file", mediaType: "text/plain", data: new Uint8Array([1]), metadata: {} },
        {
          type: "source",
          sourceType: "document",
          id: "source-1",
          mediaType: "text/plain",
          title: "Source",
          metadata: {},
        },
        {
          type: "tool-call",
          id: "read-call",
          name: "read",
          params: { path: "src/a.ts" },
          providerExecuted: false,
          metadata: {},
        },
      ]),
    )
    const tags = patch.upsert
      .toSorted((left, right) => compareUnitOrder(left.order, right.order))
      .map((unit) => (unit.content._tag === "Entry" ? "Assistant" : unit.content.block._tag))

    expect(tags).toEqual(["Reasoning", "Assistant", "Notification", "Notification", "ToolCall"])
  })

  it("rebuilds the same units from a semantic response archive", () => {
    resetEventPosition()
    const events = [
      treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }),
      modelResponseContent("raw-root-run", "archived-response", [
        { type: "reasoning", text: "inspect first", metadata: {} },
        { type: "text", text: "answer", metadata: {} },
        {
          type: "tool-call",
          id: "read-call",
          name: "read",
          params: { path: "src/a.ts" },
          providerExecuted: false,
          metadata: {},
        },
      ]),
      treeEvent("raw-root-run", {
        _tag: "RunCompleted",
        result: { text: "answer", turns: 0, session: { sessionId: "raw-root-run:session", leafId: null } },
      }),
    ]
    const live = TreeProjector.make("turn-archive", "archive this")
    const livePatch = live.applyAll(events)

    const rebuilt = TreeProjector.make("turn-archive", "archive this")
    const rebuiltPatch = rebuilt.applyAll(events)

    const rebuiltSnapshot = rebuilt.snapshot()
    const liveSnapshot = live.snapshot()
    expect(rebuiltSnapshot.units).toEqual(liveSnapshot.units)
    expect(rebuiltSnapshot.state).toEqual(liveSnapshot.state)
    expect(rebuiltSnapshot.checkpoint).toEqual(liveSnapshot.checkpoint)
    expect(rebuiltPatch.revision).toBe(livePatch.revision)
  })

  it("serializes one checkpoint for a bounded semantic replay page", () => {
    resetEventPosition()
    const events = [
      treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }),
      modelResponseContent("raw-root-run", "response", [{ type: "text", text: "done", metadata: {} }]),
      treeEvent("raw-root-run", {
        _tag: "RunCompleted",
        result: { text: "done", turns: 0, session: { sessionId: "raw-root-run:session", leafId: null } },
      }),
    ]
    const projector = TreeProjector.make("turn-replay-page", "replay")
    const stringify = vi.spyOn(JSON, "stringify")
    const patch = projector.applyAll(events)
    const serializations = stringify.mock.calls.length
    stringify.mockRestore()

    expect(serializations).toBe(1)
    expect(patch).toMatchObject({ baseRevision: 0, revision: events.length })
  })
})
