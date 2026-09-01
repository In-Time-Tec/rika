import * as ThreadQuery from "@rika/product/thread-query-service"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import { ThreadToolHandlers } from "@rika/product/product-operation-service"
import { provideLayer } from "../turn/postgres/repository-layer.harness"
import { storeProjection } from "../turn/postgres/repository-transcript.fixture"
import { Fixtures } from "./process-local-index.support"
import { storedThread, storedTurn } from "./process-local-index.fixture"
import { repositories, queryLayer } from "./process-local-index.harness"

describe("ThreadQuery", () => {
  it.effect("reads a standalone SubagentCard subtree through the same child selector as delegated tools", () =>
    Effect.gen(function* () {
      const transcripts = yield* Fixtures.TranscriptRepository.Service
      const childAgent: Fixtures.TranscriptUnit.Unit = {
        key: "child-agent:reviewer",
        turnId: storedTurn.id,
        order: Fixtures.TranscriptOrdering.unitOrder("child-agent:reviewer", 1),
        revision: 1,
        content: {
          _tag: "Block",
          block: {
            _tag: "SubagentCard",
            id: "reviewer-execution",
            name: "Reviewer",
            prompt: "",
            promptTruncated: false,
            summary: "Reviewed the implementation",
            status: "complete",
            activity: [],
          },
        },
      }
      yield* storeProjection(transcripts, storedTurn, {
        units: [
          {
            key: "user:turn-1",
            turnId: storedTurn.id,
            order: Fixtures.TranscriptOrdering.unitOrder("user:turn-1", 0),
            revision: 0,
            content: { _tag: "Entry", role: "user", text: storedTurn.prompt },
          },
          childAgent,
        ],
        revision: 1,
      })

      const query = yield* ThreadQuery.Service
      const result = yield* query.read({
        threadId: storedThread.id,
        selector: { _tag: "subtree", subagentId: "reviewer-execution" },
      })

      expect(result.omissions).toEqual([])
      expect(result.items).toMatchObject([
        {
          messages: [
            {
              role: "child",
              subagentId: "reviewer-execution",
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
      const card = (id: string, sequence: number, parentId?: string): Fixtures.TranscriptUnit.Unit => {
        const unit = {
          key: `subagent:${id}`,
          turnId: storedTurn.id,
          order: Fixtures.TranscriptOrdering.unitOrder(`subagent:${id}`, sequence),
          revision: sequence,
          content: {
            _tag: "Block",
            block: {
              _tag: "SubagentCard",
              id,
              name: id,
              prompt: `inspect ${id}`,
              promptTruncated: false,
              summary: `completed ${id}`,
              status: "complete",
              activity: [],
            },
          },
        } satisfies Fixtures.TranscriptUnit.Unit
        return parentId === undefined ? unit : { ...unit, parentId }
      }
      const answer = (id: string, sequence: number): Fixtures.TranscriptUnit.Unit => ({
        key: `assistant:${id}`,
        turnId: storedTurn.id,
        parentId: id,
        order: Fixtures.TranscriptOrdering.unitOrder(`assistant:${id}`, sequence),
        revision: sequence,
        content: { _tag: "Entry", role: "assistant", text: `${id}:${"y".repeat(12_000)}` },
      })
      const ids = ["root-agent", "nested-one", "nested-two", "nested-three", "nested-four"]
      const units = ids.flatMap((id, index) => [
        card(id, index * 2 + 1, index === 0 ? undefined : ids[index - 1]),
        answer(id, index * 2 + 2),
      ])
      units.push(card("sibling-agent", 20), answer("sibling-agent", 21))
      yield* storeProjection(transcripts, storedTurn, { units, revision: 21 })

      const query = yield* ThreadQuery.Service
      type Selector = Parameters<typeof query.read>[0]["selector"]
      const read = (selector: Selector) => query.read({ threadId: storedThread.id, selector })
      const pages = [yield* read({ _tag: "subtree", subagentId: "root-agent" })]
      const continuations = new Set<string>()
      while (pages.at(-1)?.omissions[0] !== undefined) {
        const continuation = pages.at(-1)!.omissions[0]!.continuation
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(continuation)
        expect(continuations.has(encoded)).toBe(false)
        continuations.add(encoded)
        if (continuation._tag !== "subtree") return yield* Effect.die("missing structured continuation")
        pages.push(yield* read(continuation))
        if (pages.length > units.length + 2) return yield* Effect.die("subtree continuation did not terminate")
      }
      const rendered = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(pages)
      expect(rendered).toContain("nested-four")
      expect(rendered).toContain("root-agent")
      expect(rendered).not.toContain("sibling-agent")
      expect(pages.at(-1)?.omissions).toEqual([])
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("exposes separate public find handler and maps failures", () =>
    Effect.gen(function* () {
      const toolkit = yield* Fixtures.ThreadToolkits.ThreadContract.findToolkit
      const chunks = yield* toolkit.handle("find_thread", { query: "auth" }).pipe(Effect.flatMap(Stream.runCollect))
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([...chunks])).toContain("Fix auth")
    }).pipe(provideLayer(ThreadToolHandlers.findHandlerLayer.pipe(Layer.provide(queryLayer)))),
  )

  it.effect("hides threads outside the configured workspace", () =>
    Effect.gen(function* () {
      const toolkit = yield* Fixtures.ThreadToolkits.ThreadContract.findToolkit
      const result = yield* toolkit.handle("find_thread", { query: "auth" }).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.flatMap((chunks) => Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([...chunks])),
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
