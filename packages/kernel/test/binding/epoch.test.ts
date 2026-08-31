import { describe, expect, it } from "@effect/vitest"
import { State, Store } from "tenetkit/agent-guidance"
import { Context, Effect, Schema } from "effect"
import * as HarnessBinding from "@rika/kernel/harness-binding"
import { mountModules } from "../support/binding"

const store = () => {
  const states = new Map<string, State.GuidanceState>()
  return {
    states,
    service: Store.Store.of({
      load: (scope) => Effect.succeed(states.get(scope) ?? State.empty(scope)),
      save: (state) => Effect.sync(() => void states.set(state.scope, state)),
    }),
  }
}

const registry = (backing: ReturnType<typeof store>) =>
  mountModules({
    modules: [HarnessBinding.make({ workspaceDigest: "digest" })],
    services: Context.make(Store.Store, backing.service),
  })

const baseline = (backing: ReturnType<typeof store>, scope: string) =>
  State.snapshotId(backing.states.get(scope) ?? State.empty(scope))

const MutationResponse = Schema.Struct({
  _tag: Schema.tag("Success"),
  output: Schema.Struct({ snapshotId: Schema.String, applied: Schema.Finite }),
})
const SnapshotResponse = Schema.Struct({ _tag: Schema.tag("Success"), output: State.GuidanceState })
const OverviewResponse = Schema.Struct({ _tag: Schema.tag("Success"), output: Schema.Struct({ text: Schema.String }) })

const memories = (backing: ReturnType<typeof store>, scope: string) =>
  (backing.states.get(scope)?.entries.memory ?? []).map((entry) => entry.id)

describe("per-session continual harness", () => {
  it.effect("accumulates a memory, updates it, and bumps the entry version", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      yield* mounted.invoke({
        module: "harness",
        operation: "createMemory",
        input: { id: "lesson", title: "first", content: "a", baseSnapshot: baseline(backing, "thread:session") },
      })
      yield* mounted.invoke({
        module: "harness",
        operation: "updateMemory",
        input: { id: "lesson", title: "second", content: "b", baseSnapshot: baseline(backing, "thread:session") },
      })
      const entry = backing.states.get("thread:session")?.entries.memory[0]
      expect(entry).toMatchObject({ id: "lesson", title: "second", content: "b", version: 2 })
    }),
  )

  it.effect("creates all four kinds in one Thread, which is what makes a session a harness", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      for (const operation of ["createMemory", "createSkill", "createSubagent", "createPromptNote"]) {
        const response = yield* mounted.invoke({
          module: "harness",
          operation,
          input: {
            id: operation,
            title: operation,
            content: "c",
            baseSnapshot: baseline(backing, "thread:session"),
          },
        })
        expect(response._tag).toBe("Success")
      }
      const entries = backing.states.get("thread:session")!.entries
      expect([entries.memory.length, entries.skill.length, entries.subagent.length, entries.prompt.length]).toEqual([
        1, 1, 1, 1,
      ])
    }),
  )

  it.effect("rolls a refinement back to the exact state before it", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      const before = baseline(backing, "thread:session")
      yield* mounted.invoke({
        module: "harness",
        operation: "createMemory",
        input: { id: "regret", title: "t", content: "c", baseSnapshot: before },
      })
      expect(memories(backing, "thread:session")).toEqual(["regret"])
      const refinementId = backing.states.get("thread:session")!.refinements[0]!.proposal
      const response = yield* mounted.invoke({
        module: "harness",
        operation: "rollback",
        input: { refinementId },
      })
      expect(response._tag).toBe("Success")
      expect(memories(backing, "thread:session")).toEqual([])
      expect((yield* Schema.decodeUnknownEffect(MutationResponse)(response)).output.snapshotId).toBe(before)
    }),
  )

  it.effect("fails an unknown refinement id as typed data rather than a silent no-op", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      const response = yield* mounted.invoke({
        module: "harness",
        operation: "rollback",
        input: { refinementId: "never-happened" },
      })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure")
        expect(response.failure).toMatchObject({ _tag: "HarnessRejected", reason: "unknown-refinement" })
    }),
  )

  it.effect("promotes a Thread entry to Workspace as one proposal: create there, delete here", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      yield* mounted.invoke({
        module: "harness",
        operation: "createSkill",
        input: { id: "worthkeeping", title: "t", content: "c", baseSnapshot: baseline(backing, "thread:session") },
      })
      yield* mounted.invoke({
        module: "harness",
        operation: "createSkill",
        input: {
          id: "worthkeeping",
          title: "t",
          content: "c",
          baseSnapshot: baseline(backing, "workspace:digest"),
          scope: "workspace",
        },
      })
      yield* mounted.invoke({
        module: "harness",
        operation: "deleteSkill",
        input: { id: "worthkeeping", baseSnapshot: baseline(backing, "thread:session") },
      })
      expect(backing.states.get("thread:session")!.entries.skill).toEqual([])
      expect(backing.states.get("workspace:digest")!.entries.skill.map((entry) => entry.id)).toEqual(["worthkeeping"])
    }),
  )

  it.effect("promotes to global and keeps the entry visible through the merged snapshot", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      yield* mounted.invoke({
        module: "harness",
        operation: "createPromptNote",
        input: {
          id: "always",
          title: "t",
          content: "c",
          baseSnapshot: baseline(backing, "global"),
          scope: "global",
        },
      })
      const response = yield* mounted.invoke({ module: "harness", operation: "snapshot", input: {} })
      const merged = (yield* Schema.decodeUnknownEffect(SnapshotResponse)(response)).output
      expect(merged.entries.prompt.map((entry) => entry.id)).toEqual(["always"])
      expect(merged.entries.prompt[0]?.scope).toBe("global")
    }),
  )

  it.effect("lets a Thread entry override a global entry of the same kind and id", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      yield* mounted.invoke({
        module: "harness",
        operation: "createMemory",
        input: {
          id: "shared",
          title: "global",
          content: "outer",
          baseSnapshot: baseline(backing, "global"),
          scope: "global",
        },
      })
      yield* mounted.invoke({
        module: "harness",
        operation: "createMemory",
        input: { id: "shared", title: "thread", content: "inner", baseSnapshot: baseline(backing, "thread:session") },
      })
      const response = yield* mounted.invoke({ module: "harness", operation: "snapshot", input: {} })
      const merged = (yield* Schema.decodeUnknownEffect(SnapshotResponse)(response)).output
      expect(merged.entries.memory).toHaveLength(1)
      expect(merged.entries.memory[0]).toMatchObject({ title: "thread", scope: "thread:session" })
    }),
  )

  it.effect("bounds the overview instead of pouring every entry into the prompt", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      for (let index = 0; index < 12; index += 1)
        yield* mounted.invoke({
          module: "harness",
          operation: "createMemory",
          input: {
            id: `note${index}`,
            title: `title ${index}`,
            content: "x".repeat(600),
            baseSnapshot: baseline(backing, "thread:session"),
          },
        })
      const response = yield* mounted.invoke({ module: "harness", operation: "overview", input: {} })
      const text = (yield* Schema.decodeUnknownEffect(OverviewResponse)(response)).output.text
      expect(text).toContain("memory: 12 (showing 8)")
      expect(text).not.toContain("x".repeat(600))
    }),
  )
})
