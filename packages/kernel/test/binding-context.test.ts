import { describe, expect, it } from "@effect/vitest"
import { Context, Effect } from "effect"
import { NestedOperation, Prompt, Session } from "@batonfx/core"
import * as ContextBinding from "@rika/kernel/context-binding"
import { journal, mountModules } from "./binding-support"

const message = (id: string, text: string): Session.Entry => ({
  _tag: "Message",
  id,
  parentId: null,
  message: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }),
})

const compaction = (id: string, summary: string): Session.Entry => ({
  _tag: "Compaction",
  id,
  parentId: null,
  projectedHistory: Prompt.make([]),
  telemetry: [],
  summary,
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
        return Effect.succeed(entry as Session.Entry)
      },
      appendCheckpoint: (checkpoint) => {
        appended.push(checkpoint)
        return Effect.succeed({ checkpoint, leafId: "leaf" } as never)
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
        const entries = (response.output as { readonly entries: ReadonlyArray<{ id: string }> }).entries
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
})
