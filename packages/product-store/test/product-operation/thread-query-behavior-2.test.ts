import * as ThreadQuery from "@rika/product/thread-query-service"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import { ThreadToolHandlers } from "@rika/product/product-operation-service"
import { provideLayer } from "../support/product-test-layer"
import { delegationUnit, storeProjection } from "../support/product-test-transcript-fixture"
import { Fixtures } from "./thread-query-support"
import { storedThread, storedTurn, storedRunId, projection } from "./thread-query-fixtures"
import { repositories, queryLayer } from "./thread-query-behavior-support"

describe("ThreadQuery", () => {
  it.effect("reads a standalone ChildAgent subtree through the same child selector as delegated tools", () =>
    Effect.gen(function* () {
      const transcripts = yield* Fixtures.TranscriptRepository.Service
      const childAgent: Fixtures.TranscriptUnit.Unit = {
        key: "child-agent:reviewer",
        turnId: storedRunId,
        order: Fixtures.TranscriptOrdering.unitOrder("child-agent:reviewer", 1),
        revision: 1,
        content: {
          _tag: "Block",
          block: {
            _tag: "ChildAgent",
            id: "reviewer-execution",
            name: "Reviewer",
            summary: "Reviewed the implementation",
            status: "complete",
            activity: [],
          },
        },
      }
      yield* storeProjection(transcripts, storedTurn, {
        units: [Fixtures.TranscriptProjection.Projection.empty(storedRunId, storedTurn.prompt).units[0]!, childAgent],
        revision: 1,
        modelPhase: 0,
      })

      const query = yield* ThreadQuery.Service
      const result = yield* query.read({
        threadId: storedThread.id,
        selector: { _tag: "subtree", childExecutionId: "reviewer-execution" },
      })

      expect(result.omissions).toEqual([])
      expect(result.items).toMatchObject([
        {
          messages: [
            {
              role: "child",
              childExecutionId: "reviewer-execution",
              text: "Reviewed the implementation",
            },
          ],
        },
      ])
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("returns schema-valid subtree continuations that advance through oversized nested output", () =>
    Effect.gen(function* () {
      const transcripts = yield* Fixtures.TranscriptRepository.Service
      const entry = (executionId: string, id: string, sequence: number): Fixtures.TranscriptUnit.Unit => ({
        key: `entry:${id}`,
        turnId: executionId,
        order: Fixtures.TranscriptOrdering.unitOrder(`entry:${id}`, sequence),
        revision: sequence,
        content: { _tag: "Entry", role: "assistant", text: `${id}:${"y".repeat(12_000)}` },
      })
      const child = (executionId: string, id: string, sequence: number): Fixtures.TranscriptUnit.Unit => {
        const unit = delegationUnit(executionId, `${id}-call`, id, sequence)
        if (unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall")
          throw new TypeError(`Delegation ${id} did not project a tool block`)
        return {
          ...unit,
          content: {
            _tag: "Block",
            block: { ...unit.content.block, status: "complete", output: `${id}:${"x".repeat(12_000)}` },
          },
        }
      }
      const rootAgent = child(storedRunId, "root-agent", 1)
      const rootChildExecutionId =
        rootAgent.content._tag === "Block" && rootAgent.content.block._tag === "ToolCall"
          ? rootAgent.content.block.childId
          : undefined
      if (rootChildExecutionId === undefined) return yield* Effect.die("root child has no execution identity")
      const nestedOne = child("root-agent", "nested-one", 2)
      const nestedTwo = child("nested-one", "nested-two", 2)
      const nestedThree = child("nested-two", "nested-three", 2)
      const nestedFour = child("nested-three", "nested-four", 2)
      const siblingAgent = child(storedRunId, "sibling-agent", 8)
      const root = projection([
        Fixtures.TranscriptProjection.Projection.empty(storedRunId, storedTurn.prompt).units[0]!,
        rootAgent,
        siblingAgent,
        ...Array.from(
          { length: 0 },
          (_, index): Fixtures.TranscriptUnit.Unit => ({
            key: `newer:${index}`,
            turnId: storedRunId,
            order: Fixtures.TranscriptOrdering.unitOrder(`newer:${index}`, index + 10),
            revision: index + 10,
            content: { _tag: "Entry", role: "assistant", text: `unrelated-${index}` },
          }),
        ),
      ])
      const nested = Fixtures.TranscriptNestedProjection.withNestedProjections(root, [
        {
          parentId:
            rootAgent.content._tag === "Block" && rootAgent.content.block._tag === "ToolCall"
              ? rootAgent.content.block.id
              : "",
          projection: projection([entry("root-agent", "second-answer", 1), nestedOne]),
        },
        {
          parentId:
            nestedOne.content._tag === "Block" && nestedOne.content.block._tag === "ToolCall"
              ? nestedOne.content.block.id
              : "",
          projection: projection([nestedTwo]),
        },
        {
          parentId:
            nestedTwo.content._tag === "Block" && nestedTwo.content.block._tag === "ToolCall"
              ? nestedTwo.content.block.id
              : "",
          projection: projection([nestedThree]),
        },
        {
          parentId:
            nestedThree.content._tag === "Block" && nestedThree.content.block._tag === "ToolCall"
              ? nestedThree.content.block.id
              : "",
          projection: projection([nestedFour]),
        },
        {
          parentId:
            nestedFour.content._tag === "Block" && nestedFour.content.block._tag === "ToolCall"
              ? nestedFour.content.block.id
              : "",
          projection: projection([entry("nested-four", "deep-answer", 1)]),
        },
        {
          parentId:
            siblingAgent.content._tag === "Block" && siblingAgent.content.block._tag === "ToolCall"
              ? siblingAgent.content.block.id
              : "",
          projection: projection([entry("sibling-agent", "sibling-answer", 1)]),
        },
      ])
      yield* storeProjection(transcripts, storedTurn, {
        ...nested,
        revision: 210,
      })

      const query = yield* ThreadQuery.Service
      type StructuredRead = {
        readonly selection: NonNullable<(typeof Fixtures.ThreadRead.ThreadContract.ReadThreadInput.Type)["selection"]>
      }
      const read = (selection: StructuredRead["selection"]) =>
        query
          .read({
            threadId: storedThread.id,
            selector:
              selection.mode === "subtree"
                ? {
                    _tag: "subtree",
                    childExecutionId: selection.childExecutionId,
                    ...(selection.cursor === undefined || !("before" in selection.cursor)
                      ? {}
                      : {
                          before: {
                            ...selection.cursor.before,
                            turnId: Fixtures.Turn.TurnId.make(selection.cursor.before.turnId),
                          },
                        }),
                    ...(selection.cursor !== undefined && "offset" in selection.cursor
                      ? { offset: selection.cursor.offset }
                      : {}),
                  }
                : { _tag: "overview" },
          })
          .pipe(Effect.map(ThreadToolHandlers.publicReadResult))
      const Page = Schema.Struct({
        items: Schema.Array(Schema.Unknown),
        omissions: Schema.Array(Schema.Struct({ continuation: Schema.Unknown })),
      })
      const first = yield* read({ mode: "subtree", childExecutionId: rootChildExecutionId }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Page)),
      )
      const pages = [first]
      const offsets: Array<number> = []
      const continuations = new Set<string>()
      while (true) {
        const omission = pages.at(-1)?.omissions[0]
        if (omission === undefined) break
        const continuation = omission.continuation
        const encodedContinuation = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(continuation)
        expect(continuations.has(encodedContinuation)).toBe(false)
        continuations.add(encodedContinuation)
        const nextInput = yield* Schema.decodeUnknownEffect(Fixtures.ThreadRead.ThreadContract.ReadThreadInput)({
          threadId: storedThread.id,
          selection: continuation,
        })
        if (!("selection" in nextInput) || nextInput.selection.mode !== "subtree")
          return yield* Effect.die("missing structured continuation")
        const cursor = nextInput.selection.cursor
        if (cursor === undefined) return yield* Effect.die("missing subtree cursor")
        if ("offset" in cursor) {
          offsets.push(cursor.offset)
        } else expect(cursor.before).toBeDefined()
        const next = yield* read(nextInput.selection).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Page)))
        pages.push(next)
        if (pages.length > nested.units.length + 1) return yield* Effect.die("subtree continuation did not terminate")
      }

      const rendered = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(pages)
      const firstText = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(first)
      expect(first.omissions[0]).toBeDefined()
      expect(offsets).toEqual([...new Set(offsets)].toSorted((left, right) => left - right))
      expect(rendered).toContain("nested-four")
      expect(rendered).toContain("deep-answer")
      expect(rendered).toContain("second-answer")
      expect(rendered).not.toContain("sibling-answer")
      expect(pages.at(-1)?.omissions).toEqual([])
      expect(firstText.length).toBeLessThanOrEqual(ThreadQuery.QueryPolicy.transcriptBudget)
      for (const page of pages)
        expect((yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(page)).length).toBeLessThanOrEqual(
          ThreadQuery.QueryPolicy.transcriptBudget,
        )
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("exposes separate public find handler and maps failures", () =>
    Effect.gen(function* () {
      const toolkit = yield* Fixtures.ThreadToolkits.ThreadContract.findToolkit
      const chunks = yield* toolkit.handle("find_thread", { query: "auth" }).pipe(Effect.flatMap(Stream.runCollect))
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)([...chunks])).toContain("Fix auth")
    }).pipe(provideLayer(ThreadToolHandlers.findHandlerLayer.pipe(Layer.provide(queryLayer)))),
  )

  it.effect("hides threads outside the configured workspace", () =>
    Effect.gen(function* () {
      const toolkit = yield* Fixtures.ThreadToolkits.ThreadContract.findToolkit
      const result = yield* toolkit.handle("find_thread", { query: "auth" }).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.flatMap((chunks) => Schema.encodeEffect(Schema.UnknownFromJsonString)([...chunks])),
      )
      expect(result).not.toContain("Fix auth")
    }).pipe(
      provideLayer(
        ThreadToolHandlers.findHandlerLayerForWorkspace("/work/other").pipe(
          Layer.provide(ThreadQuery.Runtime.factoryLayer.pipe(Layer.provide(repositories))),
        ),
      ),
    ),
  )
})
