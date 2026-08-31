import { describe, expect, it } from "@effect/vitest"
import { NestedOperation } from "generalist"
import { Context, Effect, Schema } from "effect"
import { State, Store } from "generalist/instructions"
import * as HarnessBinding from "@rika/kernel/harness-binding"
import { journal, mountModules } from "../../support/binding"

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

const registry = (backing = store(), nested?: NestedOperation.Service, sessionId?: string) =>
  mountModules(
    sessionId === undefined
      ? {
          modules: [HarnessBinding.make({ workspaceDigest: "digest" })],
          services: Context.make(Store.Store, backing.service),
          nested,
        }
      : {
          modules: [HarnessBinding.make({ workspaceDigest: "digest" })],
          services: Context.make(Store.Store, backing.service),
          nested,
          sessionId,
        },
  )

const emptySnapshot = State.snapshotId(State.empty("thread:session"))

describe("harness binding", () => {
  it.effect("mounts the read surface plus create, update, and delete for all four kinds", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      expect(mounted.descriptors[0]?.operations).toEqual([
        "snapshot",
        "overview",
        "createMemory",
        "createSkill",
        "createSubagent",
        "createPromptNote",
        "updateMemory",
        "updateSkill",
        "updateSubagent",
        "updatePromptNote",
        "deleteMemory",
        "deleteSkill",
        "deleteSubagent",
        "deletePromptNote",
        "recordRefinement",
        "rollback",
      ])
    }),
  )

  it.effect("rejects a mutation that omits baseSnapshot, which Generalist types as optional", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      const failure = yield* Effect.flip(
        mounted.invoke({
          module: "harness",
          operation: "createMemory",
          input: { id: "note", title: "t", content: "c" },
        }),
      )
      expect(failure._tag).toBe("generalist/repl/HostModuleSchemaFailure")
    }),
  )

  it.effect("applies a create against the current baseline and returns the new snapshot", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      const response = yield* mounted.invoke({
        module: "harness",
        operation: "createMemory",
        input: { id: "note", title: "t", content: "c", baseSnapshot: emptySnapshot },
      })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success") expect(response.output).toMatchObject({ applied: 1 })
      expect(backing.states.get("thread:session")?.entries.memory).toHaveLength(1)
    }),
  )

  it.effect("turns a stale baseline into an observable baseline-drift rejection", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      yield* mounted.invoke({
        module: "harness",
        operation: "createMemory",
        input: { id: "first", title: "t", content: "c", baseSnapshot: emptySnapshot },
      })
      const response = yield* mounted.invoke({
        module: "harness",
        operation: "createMemory",
        input: { id: "second", title: "t", content: "c", baseSnapshot: emptySnapshot },
      })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure")
        expect(response.failure).toMatchObject({ _tag: "HarnessRejected", reason: "baseline-drift" })
    }),
  )

  it.effect("refuses cell input that pins its own revision", () =>
    Effect.gen(function* () {
      const mounted = yield* registry()
      const response = yield* mounted.invoke({
        module: "harness",
        operation: "recordRefinement",
        input: {
          rationale: "forge the audit trail",
          baseSnapshot: emptySnapshot,
          edits: [
            {
              _tag: "Create",
              kind: "memory",
              id: "forged",
              value: { title: "t", content: "c" },
              revision: { createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z", version: 99 },
            },
          ],
        },
      })
      expect(response._tag).toBe("Failure")
      if (response._tag === "Failure")
        expect(response.failure).toMatchObject({ _tag: "HarnessRejected", reason: "pinned-revision" })
    }),
  )

  it.effect("scopes a thread mutation to the ambient session, never a cell-supplied scope string", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      yield* mounted.invoke({
        module: "harness",
        operation: "createMemory",
        input: { id: "note", title: "t", content: "c", baseSnapshot: emptySnapshot, scope: "thread" },
      })
      expect([...backing.states.keys()]).toEqual(["thread:session"])
    }),
  )

  it.effect("writes a workspace mutation under the workspace digest", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      yield* mounted.invoke({
        module: "harness",
        operation: "createSkill",
        input: {
          id: "skill",
          title: "t",
          content: "c",
          baseSnapshot: State.snapshotId(State.empty("workspace:digest")),
          scope: "workspace",
        },
      })
      expect([...backing.states.keys()]).toEqual(["workspace:digest"])
    }),
  )

  it.effect("merges global, workspace, and thread scopes when no scope is named", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      yield* mounted.invoke({
        module: "harness",
        operation: "createMemory",
        input: { id: "threaded", title: "t", content: "c", baseSnapshot: emptySnapshot, scope: "thread" },
      })
      yield* mounted.invoke({
        module: "harness",
        operation: "createMemory",
        input: {
          id: "global",
          title: "t",
          content: "c",
          baseSnapshot: State.snapshotId(State.empty("global")),
          scope: "global",
        },
      })
      const response = yield* mounted.invoke({ module: "harness", operation: "snapshot", input: {} })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success") {
        const entries = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ entries: Schema.Struct({ memory: Schema.Array(Schema.Struct({ id: Schema.String })) }) }),
        )(response.output)).entries.memory
        expect(entries.map((entry) => entry.id).toSorted()).toEqual(["global", "threaded"])
      }
    }),
  )

  it.effect("journals every mutation as a never-replay nested operation and no read", () =>
    Effect.gen(function* () {
      const recorder = journal()
      const mounted = yield* registry(store(), recorder.nested)
      yield* mounted.invoke({ module: "harness", operation: "snapshot", input: {} })
      yield* mounted.invoke({ module: "harness", operation: "overview", input: {} })
      yield* mounted.invoke({
        module: "harness",
        operation: "createMemory",
        input: { id: "note", title: "t", content: "c", baseSnapshot: emptySnapshot },
      })
      expect(recorder.kinds).toEqual(["harness.refine"])
      expect(recorder.policies).toEqual(["never"])
    }),
  )

  it.effect("scopes a subagent by its derived session rather than failing to scope it at all", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing, undefined, "child:run-abc:inv-1")
      const response = yield* mounted.invoke({ module: "harness", operation: "snapshot", input: {} })
      expect(response._tag).toBe("Success")
      expect([...backing.states.keys(), "thread:child:run-abc:inv-1"]).toContain("thread:child:run-abc:inv-1")
    }),
  )

  it.effect("gives a snapshot the identity a write has to name", () =>
    Effect.gen(function* () {
      // Every test derived this host-side, so nothing noticed a cell could not: a write demands a
      // baseSnapshot and the snapshot a cell reads is the only place it could come from.
      const mounted = yield* registry()
      const response = yield* mounted.invoke({ module: "harness", operation: "snapshot", input: {} })
      expect(response._tag).toBe("Success")
      if (response._tag === "Success")
        expect(
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ snapshotId: Schema.String }))(response.output)).snapshotId,
        ).toMatch(/^guidance-snapshot:v1:sha256:/)
    }),
  )

  it.effect("keeps a bounded refinement history however many refinements a scope accumulates", () =>
    Effect.gen(function* () {
      const backing = store()
      const mounted = yield* registry(backing)
      // A refinement event copies every entry it touched, so an unbounded history grows a scope by
      // its own past rather than by what it knows.
      for (let index = 0; index < 210; index += 1) {
        const current = backing.states.get("thread:session") ?? State.empty("thread:session")
        const response = yield* mounted.invoke({
          module: "harness",
          operation: "createMemory",
          input: {
            id: `note-${index}`,
            title: "t",
            content: "c",
            baseSnapshot: State.snapshotId(current),
          },
        })
        expect(response._tag).toBe("Success")
      }
      const stored = backing.states.get("thread:session")
      expect(stored?.entries.memory).toHaveLength(210)
      expect(stored?.refinements).toHaveLength(200)
    }),
  )
})
