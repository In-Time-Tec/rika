import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import { NestedOperation, Prompt, Session } from "tenetkit"
import * as ContextBinding from "@rika/kernel/context-binding"
import { journal, mountModules } from "../../support/binding"

const message = (id: string, text: string): Session.Entry => ({
  _tag: "Message",
  id,
  parentId: null,
  message: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }),
})

const compaction = (id: string, summary: string): Session.CompactionEntry => ({
  _tag: "Compaction",
  id,
  parentId: null,
  projectedHistory: Prompt.make([]),
  telemetry: [],
  summary,
})

const handoff = (id: string): Session.Entry => ({
  _tag: "Handoff",
  id,
  parentId: null,
  handoffId: "handoff-1",
  target: "specialist",
  projectedHistory: Prompt.fromMessages([
    Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "handoff question" })] }),
    Prompt.makeMessage("assistant", {
      content: [
        Prompt.makePart("reasoning", { text: "handoff reasoning" }),
        Prompt.makePart("tool-call", {
          id: "call-1",
          name: "typescript",
          params: { code: "inspect()" },
          providerExecuted: false,
        }),
      ],
    }),
    Prompt.makeMessage("tool", {
      content: [
        Prompt.makePart("tool-result", {
          id: "call-1",
          name: "typescript",
          isFailure: false,
          result: { answer: "handoff result" },
          providerExecuted: false,
        }),
      ],
    }),
  ]),
})

interface Recorder {
  readonly appended: Array<unknown>
  readonly service: Session.Interface
}

const sessionStore = (entries: ReadonlyArray<Session.Entry>): Recorder => {
  const appended: Array<unknown> = []
  return {
    appended,
    service: Session.SessionStore.of({
      reserveEntryId: Effect.succeed("reserved"),
      append: (entry) => {
        appended.push(entry)
        return Effect.succeed(message("appended", ""))
      },
      appendCheckpoint: (checkpoint) => {
        appended.push(checkpoint)
        return Effect.succeed({ _tag: "Appended", checkpoint: compaction("checkpoint", checkpoint.summary ?? ""), leafId: "leaf" })
      },
      path: () => Effect.succeed(entries),
      setLeaf: () => Effect.void,
      leaf: Effect.succeed(null),
    }),
  }
}

const registry = (recorder: Recorder, nested?: NestedOperation.Interface) =>
  mountModules({
    modules: [ContextBinding.make({ workspace: "/repo", trustMode: "trusted-local" })],
    services: Context.make(Session.SessionStore, recorder.service),
    nested,
  })

describe("context binding", () => {
  it.effect("mounts exactly the read surface", () =>
    Effect.gen(function* () {
      const mounted = yield* registry(sessionStore([]))
      expect(mounted.descriptors).toEqual([
        { module: "context", operations: ["current", "historyPage", "searchHistory", "compactions"] },
      ])
    }),
  )

  it.effect("reports the ambient thread, workspace, and trust posture", () =>
    Effect.gen(function* () {
      const mounted = yield* registry(sessionStore([]))
      const response = yield* mounted.invoke({ module: "context", operation: "current", input: {} })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success")
        expect(response.output).toMatchObject({
          threadId: "session",
          workspace: "/repo",
          trustMode: "trusted-local",
        })
    }),
  )

  it.effect("pages the newest entries and reports that older history remains", () =>
    Effect.gen(function* () {
      const mounted = yield* registry(sessionStore([message("1", "one"), message("2", "two"), message("3", "three")]))
      const response = yield* mounted.invoke({ module: "context", operation: "historyPage", input: { limit: 2 } })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success")
        expect(response.output).toMatchObject({
          entries: [
            { id: "2", kind: "Message", text: "two" },
            { id: "3", kind: "Message", text: "three" },
          ],
          hasBefore: true,
          hasAfter: false,
        })
    }),
  )

  it.effect("reaches entries recorded before a compaction checkpoint", () =>
    Effect.gen(function* () {
      const mounted = yield* registry(
        sessionStore([message("1", "before"), compaction("2", "summary"), message("3", "after")]),
      )
      const response = yield* mounted.invoke({ module: "context", operation: "historyPage", input: { limit: 10 } })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success") {
        const { entries } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ entries: Schema.Array(Schema.Struct({ id: Schema.String })) }),
        )(response.output)
        expect(entries.map((entry) => entry.id)).toEqual(["1", "2", "3"])
      }
    }),
  )

  it.effect("lists compaction checkpoints", () =>
    Effect.gen(function* () {
      const mounted = yield* registry(sessionStore([message("1", "a"), compaction("2", "summarised")]))
      const response = yield* mounted.invoke({ module: "context", operation: "compactions", input: {} })
      expect(response).toEqual({ _tag: "Success", output: [{ id: "2", summary: "summarised" }] })
    }),
  )

  it.effect("reads and searches the authoritative conversation projected by a handoff", () =>
    Effect.gen(function* () {
      const mounted = yield* registry(sessionStore([handoff("1")]))
      const page = yield* mounted.invoke({ module: "context", operation: "historyPage", input: { limit: 1 } })
      expect(page).toEqual({
        _tag: "Success",
        output: {
          entries: [
            {
              id: "1",
              parentId: null,
              kind: "Handoff",
              text: 'handoff question\nhandoff reasoning\ntypescript({"code":"inspect()"})\n{"answer":"handoff result"}',
            },
          ],
          hasBefore: false,
          hasAfter: false,
          firstEntryId: "1",
          lastEntryId: "1",
        },
      })

      const found = yield* mounted.invoke({
        module: "context",
        operation: "searchHistory",
        input: { query: "HANDOFF RESULT", limit: 1 },
      })
      expect(found).toEqual({
        _tag: "Success",
        output: {
          entries: [
            {
              id: "1",
              parentId: null,
              kind: "Handoff",
              text: 'handoff question\nhandoff reasoning\ntypescript({"code":"inspect()"})\n{"answer":"handoff result"}',
            },
          ],
          hasMore: false,
        },
      })
    }),
  )

  it.effect("bounds a search to the requested limit and reports that more matched", () =>
    Effect.gen(function* () {
      const mounted = yield* registry(
        sessionStore([message("1", "needle a"), message("2", "needle b"), message("3", "other")]),
      )
      const response = yield* mounted.invoke({
        module: "context",
        operation: "searchHistory",
        input: { query: "NEEDLE", limit: 1 },
      })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success") expect(response.output).toMatchObject({ hasMore: true })
    }),
  )

  it.effect("never appends to canonical history through any mounted operation", () =>
    Effect.gen(function* () {
      const recorder = sessionStore([message("1", "a"), compaction("2", "s")])
      const mounted = yield* registry(recorder)
      yield* mounted.invoke({ module: "context", operation: "current", input: {} })
      yield* mounted.invoke({ module: "context", operation: "historyPage", input: { limit: 10 } })
      yield* mounted.invoke({ module: "context", operation: "searchHistory", input: { query: "a", limit: 10 } })
      yield* mounted.invoke({ module: "context", operation: "compactions", input: {} })
      expect(recorder.appended).toEqual([])
    }),
  )

  it.effect("creates no nested operation, because every context operation is a pure read", () =>
    Effect.gen(function* () {
      const journalled = journal()
      const mounted = yield* registry(sessionStore([message("1", "a")]), journalled.nested)
      yield* mounted.invoke({ module: "context", operation: "current", input: {} })
      yield* mounted.invoke({ module: "context", operation: "historyPage", input: { limit: 1 } })
      yield* mounted.invoke({ module: "context", operation: "compactions", input: {} })
      expect(journalled.kinds).toEqual([])
    }),
  )

  it.effect("names a cursor the log does not hold rather than answering as though it did", () =>
    Effect.gen(function* () {
      // A page asked for entries before something returns the newest ones when the cursor names no
      // position, which a caller must not read as an answer to what it asked.
      const mounted = yield* registry(sessionStore([message("1", "one"), message("2", "two")]))
      const response = yield* mounted.invoke({
        module: "context",
        operation: "historyPage",
        input: { limit: 2, before: "no-such-entry" },
      })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success") expect(response.output).toMatchObject({ unknownCursors: ["no-such-entry"] })
    }),
  )

  it.effect("keeps what an assistant turn reasoned and called, not only what it said", () =>
    Effect.gen(function* () {
      // An assistant turn is mostly reasoning and tool calls. Reading back only `text` rendered a
      // model's own history as a column of empty messages.
      const mounted = yield* registry(
        sessionStore([
          {
            _tag: "Message",
            id: "e1",
            parentId: null,
            message: Prompt.makeMessage("assistant", {
              content: [
                Prompt.makePart("reasoning", { text: "weighing the options" }),
                Prompt.makePart("tool-call", {
                  id: "t1",
                  name: "typescript",
                  params: { code: "1" },
                  providerExecuted: false,
                }),
              ],
            }),
          },
        ]),
      )
      const response = yield* mounted.invoke({ module: "context", operation: "historyPage", input: { limit: 5 } })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success") {
        const { entries } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ entries: Schema.Array(Schema.Struct({ text: Schema.String })) }),
        )(response.output)
        expect(entries[0]?.text).toContain("weighing the options")
        expect(entries[0]?.text).toContain("typescript")
      }
    }),
  )
})
