import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as ThreadRepository from "../../src/thread/repository"
import * as Thread from "@rika/product/thread-record"

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

const id = (value: string) => Thread.ThreadId.make(value)

const behavior = (name: string, layer: Layer.Layer<ThreadRepository.Service>) => {
  describe(name, () => {
    it.effect("supports the complete metadata lifecycle", () =>
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        const first = yield* repository.create({
          id: id("thread-a"),
          workspace: "/work/a",
          title: "First",
          now: 1,
        })
        yield* repository.create({
          id: id("thread-b"),
          workspace: "/work/b",
          title: "Second",
          now: 2,
        })
        const renamed = yield* repository.rename(first.id, "Renamed", 3)
        const labeled = yield* repository.label(first.id, ["bug", "bug", "urgent"], 4)
        const pinned = yield* repository.setPinned(first.id, true, 5)
        const archived = yield* repository.setArchived(id("thread-b"), true, 6)
        const visible = yield* repository.list()
        const all = yield* repository.list({ includeArchived: true })
        const search = yield* repository.list({ includeArchived: true, query: "urgent" })
        const bounded = yield* repository.list({ includeArchived: true, limit: 0 })
        yield* repository.discard(first.id)
        const removed = yield* repository.get(first.id)
        expect(renamed.title).toBe("Renamed")
        expect(labeled.labels).toEqual(["bug", "urgent"])
        expect(pinned).toMatchObject({ workspace: "/work/a", pinned: true, archived: false })
        expect(archived.archived).toBe(true)
        expect(visible.map((thread) => thread.id)).toEqual([id("thread-a")])
        expect(all.map((thread) => thread.id)).toEqual([id("thread-a"), id("thread-b")])
        expect(search.map((thread) => thread.id)).toEqual([id("thread-a")])
        expect(bounded).toHaveLength(1)
        expect(removed).toBeUndefined()
      }).pipe(provideLayer(layer)),
    )

    it.effect("reports duplicate and missing records", () =>
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        const input = {
          id: id("thread-a"),
          workspace: "/work/a",
          title: "First",
          now: 1,
        }
        yield* repository.create(input)
        const duplicate = yield* Effect.result(repository.create(input))
        const missing = yield* Effect.result(repository.rename(id("missing"), "No", 2))
        expect(duplicate._tag).toBe("Failure")
        expect(missing._tag).toBe("Failure")
      }).pipe(provideLayer(layer)),
    )

    it.effect("renames only while the expected title still owns the thread", () =>
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        yield* repository.create({
          id: id("thread-a"),
          workspace: "/work/a",
          title: "Temporary",
          now: 1,
        })
        const renamed = yield* repository.renameIfTitle(id("thread-a"), "Temporary", "Generated", 2)
        const stale = yield* repository.renameIfTitle(id("thread-a"), "Temporary", "Late", 3)
        expect(renamed?.title).toBe("Generated")
        expect(stale).toBeUndefined()
        expect((yield* repository.get(id("thread-a")))?.title).toBe("Generated")
      }).pipe(provideLayer(layer)),
    )

    it.effect("archives the current thread while creating its replacement", () =>
      Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        yield* repository.create({
          id: id("thread-a"),
          workspace: "/work/a",
          title: "Current",
          now: 1,
        })
        const created = yield* repository.archiveAndCreate(id("thread-a"), {
          id: id("thread-b"),
          workspace: "/work/a",
          title: "Replacement",
          now: 2,
        })

        expect(created).toMatchObject({ id: id("thread-b"), archived: false })
        expect(yield* repository.get(id("thread-a"))).toMatchObject({ archived: true, updatedAt: 2 })
      }).pipe(provideLayer(layer)),
    )
  })
}

behavior("memory", ThreadRepository.memoryLayer())
