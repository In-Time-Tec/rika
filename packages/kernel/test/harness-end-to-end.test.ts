import { describe, expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { HarnessMerge, HarnessState, HarnessStore } from "@batonfx/harness"
import { Context, Effect, FileSystem, Layer } from "effect"
import * as ExecutionPins from "@rika/kernel/execution-pins"
import * as HarnessBinding from "@rika/kernel/harness-binding"
import * as PromptSections from "@rika/kernel/harness-prompt-sections"
import * as ScopePolicy from "@rika/kernel/harness-scope-policy"
import * as StoreLocations from "@rika/kernel/harness-store-locations"
import { mountModules } from "./binding-support"

const identity = { thread: "session", workspaceDigest: "digest" }

const temporaryRoots = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-harness-session-" })
  return { home, workspace: `${home}/repo`, dataRoot: `${home}/.rika` }
})

const storeLayer = Layer.unwrap(Effect.map(temporaryRoots, StoreLocations.layer))

const effective = Effect.gen(function* () {
  const store = yield* HarnessStore.HarnessStore
  const states = yield* Effect.forEach(ScopePolicy.mergeOrder, (level) =>
    store.load(ScopePolicy.scopeString(level, identity)),
  )
  return states.reduce((outer, inner) => HarnessMerge.mergeStates(outer, inner))
})

const mounted = Effect.flatMap(HarnessStore.HarnessStore, (store) =>
  mountModules({
    modules: [HarnessBinding.make({ workspaceDigest: identity.workspaceDigest })],
    services: Context.make(HarnessStore.HarnessStore, store),
  }),
)

describe("continual harness end to end over the real store", () => {
  it.layer(Layer.provideMerge(storeLayer, BunServices.layer))((test) => {
    test.effect("a cell refines its Thread and the next Execution pins the refined snapshot", () =>
      Effect.gen(function* () {
        const surface = yield* mounted
        const before = yield* effective
        const beforePin = ExecutionPins.harness(before)
        yield* surface.invoke({
          module: "harness",
          operation: "createMemory",
          input: {
            id: "learned",
            title: "prefer the owning interface",
            content: "walk the interface before editing",
            baseSnapshot: HarnessState.snapshotId(yield* effective),
          },
        })
        const after = yield* effective
        const afterPin = ExecutionPins.harness(after)
        expect(afterPin.capabilities[0]!.pin).not.toBe(beforePin.capabilities[0]!.pin)
        const block = PromptSections.block({ harness: after, skillListings: "", mcpServers: [] })
        expect(block).toContain("prefer the owning interface")
        expect(PromptSections.block({ harness: before, skillListings: "", mcpServers: [] })).not.toContain(
          "prefer the owning interface",
        )
      }),
    )

    test.effect("a refinement survives a fresh load, so the Thread accumulates capability durably", () =>
      Effect.gen(function* () {
        const surface = yield* mounted
        yield* surface.invoke({
          module: "harness",
          operation: "createSkill",
          input: {
            id: "durable",
            title: "durable",
            content: "c",
            baseSnapshot: HarnessState.snapshotId(yield* effective),
          },
        })
        const store = yield* HarnessStore.HarnessStore
        const reloaded = yield* store.load(ScopePolicy.scopeString("thread", identity))
        expect(reloaded.entries.skill.map((entry) => entry.id)).toEqual(["durable"])
      }),
    )

    test.effect("promotion to Workspace outlives the Thread scope it came from", () =>
      Effect.gen(function* () {
        const surface = yield* mounted
        yield* surface.invoke({
          module: "harness",
          operation: "createSubagent",
          input: {
            id: "reviewer",
            title: "reviewer",
            content: "review the diff",
            reference: "rika.agents.spawn",
            baseSnapshot: HarnessState.snapshotId(yield* effective),
          },
        })
        const store = yield* HarnessStore.HarnessStore
        const workspaceScope = ScopePolicy.scopeString("workspace", identity)
        yield* surface.invoke({
          module: "harness",
          operation: "createSubagent",
          input: {
            id: "reviewer",
            title: "reviewer",
            content: "review the diff",
            reference: "rika.agents.spawn",
            baseSnapshot: HarnessState.snapshotId(yield* store.load(workspaceScope)),
            scope: "workspace",
          },
        })
        yield* surface.invoke({
          module: "harness",
          operation: "deleteSubagent",
          input: {
            id: "reviewer",
            baseSnapshot: HarnessState.snapshotId(yield* store.load(ScopePolicy.scopeString("thread", identity))),
          },
        })
        const merged = yield* effective
        expect(merged.entries.subagent.map((entry) => entry.scope)).toEqual([workspaceScope])
        expect(PromptSections.block({ harness: merged, skillListings: "", mcpServers: [] })).toContain(
          "rika.agents.spawn",
        )
      }),
    )
  })
})
