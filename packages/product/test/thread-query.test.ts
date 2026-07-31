import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as ThreadInteractionRepository from "@rika/product-store/sqlite-thread-interaction-repository"
import * as ThreadSearchRepository from "@rika/product-store/sqlite-thread-search-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as Transcript from "@rika/transcript/transcript-unit"
import { ThreadTools, ToolInvocation } from "@rika/coding-tools/coding-tool-catalog"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ThreadQuery, ThreadToolHandlers } from "@rika/product/product-operation"
import { provideLayer } from "./layer"
import { delegationUnit, storeProjection } from "./transcript-repository-fixture"

const workspace = "/work/acme"
const invocation = ToolInvocation.ToolInvocation.of({
  executionId: "execution-one",
  callId: "call-one",
  toolName: "find_thread",
  eventSequence: 1,
  createdAt: 1,
  idempotencyKeyDigest: "digest",
})
const storedThread: Thread.Thread = {
  id: Thread.ThreadId.make("one"),
  workspace,
  title: "Fix auth",
  labels: ["bug"],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 2,
}
const storedTurn: Turn.Turn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("turn-1"),
  threadId: storedThread.id,
  prompt: "fix auth",
  executionRoute: Turn.testExecutionRoute(),
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  status: "completed",
  stopIntent: "none",
  createdAt: 1,
  updatedAt: 2,
}
const projection = (units: ReadonlyArray<Transcript.Unit>): Transcript.Projection => ({
  units,
  revision: units.reduce((maximum, unit) => Math.max(maximum, unit.revision), -1),
  modelPhase: 0,
})
const relatedThread: Thread.Thread = {
  ...storedThread,
  id: Thread.ThreadId.make("two"),
  title: "Related work",
  createdAt: 3,
  updatedAt: 3,
}
const stateThreads = (["waiting", "running", "queued", "failed"] as const).map((status, index) => ({
  thread: {
    ...storedThread,
    id: Thread.ThreadId.make(`state-${status}`),
    title: status,
    createdAt: 10 + index,
    updatedAt: 10 + index,
  },
  turn: {
    ...storedTurn,
    id: Turn.TurnId.make(`turn-${status}`),
    threadId: Thread.ThreadId.make(`state-${status}`),
    status,
    createdAt: 10 + index,
    updatedAt: 10 + index,
  },
}))
const search = ThreadSearchRepository.Service.of({
  search: (input) =>
    Effect.sync(() => {
      let results: ThreadSearchRepository.SearchPage["results"] = []
      if (input.workspace === workspace && input.query === "states") {
        results = stateThreads.map(({ thread }) => ({
          schemaVersion: 2,
          threadId: thread.id,
          title: thread.title,
          workspace,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          archived: false,
          matchedBy: ["title"],
          snippets: [{ source: "title", text: thread.title }],
          omissionReasons: [],
        }))
      } else if (input.workspace === workspace && input.query.includes("auth")) {
        results = [
          {
            schemaVersion: 2,
            threadId: storedThread.id,
            title: storedThread.title,
            workspace,
            createdAt: 1,
            updatedAt: 2,
            archived: false,
            matchedBy: [input.query.includes("file:") ? "file" : "title"],
            snippets: [
              {
                source: input.query.includes("file:") ? "file" : "title",
                text: input.query.includes("file:") ? "src/auth.ts" : "Fix auth",
              },
            ],
            omissionReasons: [],
          },
        ]
      }
      return {
        schemaVersion: 2,
        results,
        nextCursor: undefined,
      }
    }),
  rebuildThread: () => Effect.void,
  removeThread: () => Effect.void,
})
const repositories = Layer.mergeAll(
  ThreadRepository.memoryLayer([storedThread, relatedThread, ...stateThreads.map(({ thread }) => thread)]),
  TurnRepository.memoryLayer([storedTurn, ...stateThreads.map(({ turn }) => turn)]),
  TranscriptRepository.memoryLayer,
  Layer.succeed(ThreadSearchRepository.Service, search),
  Layer.effect(
    ThreadInteractionRepository.Service,
    ThreadInteractionRepository.makeMemory({ threads: [storedThread, relatedThread], turns: [storedTurn] }),
  ),
)
const queryLayer = Layer.merge(ThreadQuery.layerForWorkspace(workspace).pipe(Layer.provide(repositories)), repositories)

describe("ThreadQuery", () => {
  it.effect("finds metadata and file content only in the current workspace", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const metadata = yield* query.find({ query: "auth" })
      const file = yield* query.find({ query: "file:src/auth.ts" })
      expect(metadata).toMatchObject({ schemaVersion: 2, threads: [{ threadId: "one", title: "Fix auth" }] })
      expect(file.threads[0]?.summary).toBe("src/auth.ts")
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("reports observable Thread execution state", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const found = yield* query.find({ query: "states" })
      expect(found.threads.map(({ state }) => state)).toEqual(["running", "running", "queued", "error"])
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("repairs search from current Thread metadata and messages without crossing workspaces", () =>
    Effect.gen(function* () {
      const local = { ...storedThread, id: Thread.ThreadId.make("fresh-local"), title: "Initial title" }
      const foreign = {
        ...storedThread,
        id: Thread.ThreadId.make("fresh-foreign"),
        workspace: "/other/workspace",
        title: "renamed needle",
      }
      const localTurn = { ...storedTurn, id: Turn.TurnId.make("fresh-turn"), threadId: local.id, prompt: "initial" }
      const threadRepository = yield* ThreadRepository.makeMemory([local, foreign])
      const turns = yield* TurnRepository.makeMemory([localTurn])
      const transcripts = Context.get(
        yield* Layer.build(TranscriptRepository.memoryLayer),
        TranscriptRepository.Service,
      )
      const searches = yield* ThreadSearchRepository.makeMemory
      const interactions = yield* ThreadInteractionRepository.makeMemory({
        threads: [local, foreign],
        turns: [localTurn],
      })
      const dependencies = Layer.mergeAll(
        Layer.succeed(ThreadRepository.Service, threadRepository),
        Layer.succeed(TurnRepository.Service, turns),
        Layer.succeed(TranscriptRepository.Service, transcripts),
        Layer.succeed(ThreadSearchRepository.Service, searches),
        Layer.succeed(ThreadInteractionRepository.Service, interactions),
      )
      const layer = Layer.merge(
        ThreadQuery.layerForWorkspace(workspace).pipe(Layer.provide(dependencies)),
        dependencies,
      )

      yield* Effect.gen(function* () {
        const query = yield* ThreadQuery.Service
        expect((yield* query.find({ query: "renamed needle" })).threads).toEqual([])
        yield* threadRepository.rename(local.id, "renamed needle", 3)
        expect((yield* query.find({ query: "renamed needle" })).threads.map((thread) => thread.threadId)).toEqual([
          "fresh-local",
        ])
        yield* turns.copy(
          {
            ...localTurn,
            id: Turn.TurnId.make("fresh-message"),
            prompt: "message needle",
            createdAt: 4,
            updatedAt: 4,
          },
          10,
        )
        expect((yield* query.find({ query: "message needle" })).threads.map((thread) => thread.threadId)).toEqual([
          "fresh-local",
        ])
        yield* threadRepository.setArchived(local.id, true, 5)
        expect((yield* query.find({ query: "renamed needle" })).threads).toEqual([])
        expect(
          (yield* query.find({ query: "renamed needle", includeArchived: true })).threads.map(
            (thread) => thread.threadId,
          ),
        ).toEqual(["fresh-local"])
      }).pipe(provideLayer(layer))
    }),
  )

  it.effect("returns structured recent output and legacy schema-versioned JSON", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const recent = yield* query.readStructured({ threadId: "one", selector: { _tag: "recent" } })
      const legacy = yield* query.read({ threadId: "one" })
      expect(recent).toMatchObject({ schemaVersion: 2, selector: { _tag: "recent" }, items: [{ author: "human" }] })
      expect(yield* Schema.decodeEffect(Schema.UnknownFromJsonString)(legacy.text)).toMatchObject({
        schemaVersion: 2,
        threadId: "one",
      })
      expect(legacy.text.length).toBeLessThanOrEqual(ThreadQuery.transcriptBudget)
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("represents unavailable subtrees and traverses related Threads", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const interactions = yield* ThreadInteractionRepository.Service
      yield* interactions.appendMessage({
        invocationDigest: "related",
        schemaInputDigest: "related",
        sourceThreadId: storedThread.id,
        sourceRootTurnId: storedTurn.id,
        now: 4,
        maximumDepth: 3,
        maximumAdmissions: 8,
        maximumWorkspaceActive: 8,
        queueCapacity: 4,
        turnId: Turn.TurnId.make("turn-2"),
        prompt: "continue",
        executionRoute: storedTurn.executionRoute,
        targetThreadId: relatedThread.id,
        resultDelivery: "manual",
        threadCreationDepth: 1,
      })
      const child = yield* query.readStructured({
        threadId: "one",
        selector: { _tag: "subtree", childExecutionId: "missing" },
      })
      const related = yield* query.readStructured({ threadId: "one", selector: { _tag: "related" } })
      expect(child.omissions[0]).toMatchObject({ reason: "unavailableChild", continuation: { _tag: "subtree" } })
      expect(related.relatedThreads).toEqual([
        expect.objectContaining({
          kind: "message",
          direction: "outgoing",
          threadId: "two",
          turnId: "turn-2",
          available: true,
        }),
      ])
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("reads a standalone ChildAgent subtree through the same child selector as delegated tools", () =>
    Effect.gen(function* () {
      const transcripts = yield* TranscriptRepository.Service
      const childAgent: Transcript.Unit = {
        key: "child-agent:reviewer",
        turnId: storedTurn.id,
        order: Transcript.unitOrder("child-agent:reviewer", 1),
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
        units: [Transcript.empty(storedTurn.id, storedTurn.prompt).units[0]!, childAgent],
        revision: 1,
        modelPhase: 0,
      })

      const query = yield* ThreadQuery.Service
      const result = yield* query.readStructured({
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
      const transcripts = yield* TranscriptRepository.Service
      const entry = (executionId: string, id: string, sequence: number): Transcript.Unit => ({
        key: `entry:${id}`,
        turnId: executionId,
        order: Transcript.unitOrder(`entry:${id}`, sequence),
        revision: sequence,
        content: { _tag: "Entry", role: "assistant", text: `${id}:${"y".repeat(12_000)}` },
      })
      const child = (executionId: string, id: string, sequence: number): Transcript.Unit => {
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
      const rootAgent = child(storedTurn.id, "root-agent", 1)
      const nestedOne = child("root-agent", "nested-one", 2)
      const nestedTwo = child("nested-one", "nested-two", 2)
      const nestedThree = child("nested-two", "nested-three", 2)
      const nestedFour = child("nested-three", "nested-four", 2)
      const siblingAgent = child(storedTurn.id, "sibling-agent", 8)
      const root = projection([
        Transcript.empty(storedTurn.id, storedTurn.prompt).units[0]!,
        rootAgent,
        siblingAgent,
        ...Array.from(
          { length: 201 },
          (_, index): Transcript.Unit => ({
            key: `newer:${index}`,
            turnId: storedTurn.id,
            order: Transcript.unitOrder(`newer:${index}`, index + 10),
            revision: index + 10,
            content: { _tag: "Entry", role: "assistant", text: `unrelated-${index}` },
          }),
        ),
      ])
      const nested = Transcript.withNestedProjections(root, [
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
      type StructuredRead = { readonly selection: NonNullable<(typeof ThreadTools.ReadThreadInput.Type)["selection"]> }
      const read = (selection: StructuredRead["selection"]) =>
        query
          .readStructured({
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
                            turnId: Turn.TurnId.make(selection.cursor.before.turnId),
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
      const first = yield* read({ mode: "subtree", childExecutionId: "root-agent" }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Page)),
      )
      const pages = [first]
      const offsets: Array<number> = []
      while (true) {
        const omission = pages.at(-1)?.omissions[0]
        if (omission === undefined) break
        const continuation = omission.continuation
        const nextInput = yield* Schema.decodeUnknownEffect(ThreadTools.ReadThreadInput)({
          threadId: storedThread.id,
          selection: continuation,
        })
        if (!("selection" in nextInput) || nextInput.selection.mode !== "subtree")
          return yield* Effect.die("missing structured continuation")
        const cursor = nextInput.selection.cursor
        if (cursor === undefined) return yield* Effect.die("missing subtree cursor")
        if ("offset" in cursor) {
          offsets.push(cursor.offset)
          expect(cursor.before).toBeDefined()
        } else expect(cursor.before).toBeDefined()
        const next = yield* read(nextInput.selection).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Page)))
        expect(next.items).not.toEqual(pages.at(-1)?.items)
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
      expect(firstText.length).toBeLessThanOrEqual(ThreadQuery.transcriptBudget)
      for (const page of pages)
        expect((yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(page)).length).toBeLessThanOrEqual(
          ThreadQuery.transcriptBudget,
        )
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("paginates tied incoming and outgoing Thread relationships without gaps", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const interactions = yield* ThreadInteractionRepository.Service
      for (let index = 0; index < 11; index += 1) {
        const suffix = String(index).padStart(2, "0")
        yield* interactions.appendMessage({
          invocationDigest: `outgoing-${suffix}`,
          schemaInputDigest: `outgoing-${suffix}`,
          sourceThreadId: storedThread.id,
          sourceRootTurnId: storedTurn.id,
          now: 50,
          maximumDepth: 3,
          maximumAdmissions: 30,
          maximumWorkspaceActive: 30,
          queueCapacity: 30,
          turnId: Turn.TurnId.make(`outgoing-${suffix}`),
          prompt: `outgoing ${suffix}`,
          executionRoute: storedTurn.executionRoute,
          targetThreadId: relatedThread.id,
          resultDelivery: "manual",
          threadCreationDepth: 1,
        })
        yield* interactions.appendMessage({
          invocationDigest: `incoming-${suffix}`,
          schemaInputDigest: `incoming-${suffix}`,
          sourceThreadId: relatedThread.id,
          sourceRootTurnId: Turn.TurnId.make("outgoing-00"),
          now: 50,
          maximumDepth: 3,
          maximumAdmissions: 30,
          maximumWorkspaceActive: 30,
          queueCapacity: 30,
          turnId: Turn.TurnId.make(`incoming-${suffix}`),
          prompt: `incoming ${suffix}`,
          executionRoute: storedTurn.executionRoute,
          targetThreadId: storedThread.id,
          resultDelivery: "manual",
          threadCreationDepth: 1,
        })
      }

      const first = yield* query.readStructured({ threadId: "one", selector: { _tag: "related" } })
      const continuation = first.omissions[0]?.continuation
      if (continuation?._tag !== "related") return yield* Effect.die("missing relationship continuation")
      const second = yield* query.readStructured({ threadId: "one", selector: continuation })
      const relationships = [...first.relatedThreads, ...second.relatedThreads]
      expect(first.relatedThreads).toHaveLength(20)
      expect(second.relatedThreads).toHaveLength(2)
      expect(relationships).toHaveLength(22)
      expect(relationships.filter((relationship) => relationship.direction === "incoming")).toHaveLength(11)
      expect(relationships.filter((relationship) => relationship.direction === "outgoing")).toHaveLength(11)
      expect(second.omissions).toEqual([])
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("exposes separate public find handler and maps failures", () =>
    Effect.gen(function* () {
      const toolkit = yield* ThreadTools.findToolkit
      const chunks = yield* toolkit
        .handle("find_thread", { query: "auth" })
        .pipe(Effect.flatMap(Stream.runCollect), Effect.provideService(ToolInvocation.ToolInvocation, invocation))
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)([...chunks])).toContain("Fix auth")
    }).pipe(provideLayer(ThreadToolHandlers.findHandlerLayer.pipe(Layer.provide(queryLayer)))),
  )

  it.effect("resolves the invocation workspace and hides threads in another workspace", () =>
    Effect.gen(function* () {
      const toolkit = yield* ThreadTools.findToolkit
      const handle = (executionId: string) =>
        toolkit.handle("find_thread", { query: "auth" }).pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.provideService(ToolInvocation.ToolInvocation, { ...invocation, executionId }),
          Effect.flatMap((chunks) => Schema.encodeEffect(Schema.UnknownFromJsonString)([...chunks])),
        )
      expect(yield* handle("acme-execution")).toContain("Fix auth")
      expect(yield* handle("other-execution")).not.toContain("Fix auth")
    }).pipe(
      provideLayer(
        ThreadToolHandlers.findHandlerLayerForWorkspace((executionId) =>
          Effect.succeed(executionId === "acme-execution" ? workspace : "/work/other"),
        ).pipe(Layer.provide(ThreadQuery.factoryLayer.pipe(Layer.provide(repositories)))),
      ),
    ),
  )
})
