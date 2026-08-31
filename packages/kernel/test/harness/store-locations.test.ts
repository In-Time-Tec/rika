import { describe, expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { State, Store } from "generalist/instructions"
import { Effect, FileSystem, Layer } from "effect"
import * as StoreLocations from "@rika/kernel/harness-store-locations"

const roots = (home: string): StoreLocations.Roots => ({
  home,
  workspace: `${home}/repo`,
  dataRoot: `${home}/.rika`,
})

const entry = (id: string) => ({
  id,
  kind: "memory" as const,
  scope: "thread:session",
  title: "t",
  content: "c",
  version: 1,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
})

const temporaryRoots = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  return roots(yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-harness-" }))
})

const storeLayer = Layer.unwrap(Effect.map(temporaryRoots, StoreLocations.layer))

describe("filesystem harness store", () => {
  it.layer(Layer.merge(storeLayer, BunServices.layer).pipe(Layer.provideMerge(BunServices.layer)))((test) => {
    test.effect("round-trips one thread scope and returns what it stored", () =>
      Effect.gen(function* () {
        const store = yield* Store.Store
        yield* store.save(State.make({ scope: "thread:session", entries: [entry("kept")] }))
        const loaded = yield* store.load("thread:session")
        expect(loaded.entries.memory.map((value) => value.id)).toEqual(["kept"])
      }),
    )

    test.effect("keeps each scope in its own file rather than one shared blob", () =>
      Effect.gen(function* () {
        const store = yield* Store.Store
        yield* store.save(State.make({ scope: "global", entries: [] }))
        yield* store.save(State.make({ scope: "workspace:digest", entries: [entry("shared")] }))
        yield* store.save(State.make({ scope: "thread:session", entries: [entry("local")] }))
        expect((yield* store.load("global")).entries.memory).toEqual([])
        expect((yield* store.load("workspace:digest")).entries.memory.map((value) => value.id)).toEqual(["shared"])
        expect((yield* store.load("thread:session")).entries.memory.map((value) => value.id)).toEqual(["local"])
      }),
    )

    test.effect("returns an empty scope rather than failing when nothing was ever written", () =>
      Effect.gen(function* () {
        const store = yield* Store.Store
        expect(State.allEntries(yield* store.load("thread:fresh"))).toEqual([])
      }),
    )
  })
})

describe("harness store locations", () => {
  it("resolves each scope under the root that owns it", () => {
    const path = StoreLocations.path(roots("/home/ada"))
    expect(path("global")).toBe("/home/ada/.config/rika/harness/global.json")
    expect(path("workspace:digest")).toBe("/home/ada/repo/.rika/harness/workspace%3Adigest.json")
    expect(path("thread:session")).toBe("/home/ada/.rika/harness/thread%3Asession.json")
  })
})
