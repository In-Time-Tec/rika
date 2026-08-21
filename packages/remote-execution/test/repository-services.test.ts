import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, FileSystem, Layer } from "effect"
import { TestClock } from "effect/testing"
import {
  Driver,
  Repository,
  RepositoryServices,
  layer,
  repositoryLayer,
  type StoredService,
} from "../src/repository-services"
import type { Fence } from "../src/protocol"
import { provideLayer } from "./support/layer"

const service = { serviceId: "docs", command: "bun", args: ["run", "dev"], cwd: "." } as const

const harness = () => {
  const records = new Map<string, StoredService>()
  const starts: Array<string> = []
  const stops: Array<string> = []
  const exits: Array<Deferred.Deferred<number>> = []
  const repository = Repository.of({
    get: (serviceId) => Effect.succeed(records.get(serviceId)),
    list: Effect.sync(() => [...records.values()]),
    save: (record) => Effect.sync(() => void records.set(record.serviceId, record)),
  })
  const driver = Driver.of({
    start: (definition) =>
      Effect.gen(function* () {
        starts.push(definition.serviceId)
        const exit = yield* Deferred.make<number>()
        exits.push(exit)
        yield* Effect.addFinalizer(() => Effect.sync(() => void stops.push(definition.serviceId)))
        return { exit: Deferred.await(exit) }
      }),
  })
  return {
    records,
    starts,
    stops,
    exits,
    layer: layer.pipe(Layer.provide(Layer.merge(Layer.succeed(Repository, repository), Layer.succeed(Driver, driver)))),
  }
}

describe("Repository service supervision", () => {
  it.effect("starts an idempotent desired service once and stops it without restart", () => {
    const test = harness()
    return Effect.gen(function* () {
      const services = yield* RepositoryServices
      yield* Effect.all([services.ensure(service), services.ensure(service)], { concurrency: "unbounded" })
      expect(test.starts).toEqual(["docs"])
      expect(test.records.get("docs")?.desired).toBe(true)

      yield* services.stop("docs")
      expect(test.records.get("docs")?.desired).toBe(false)
      expect(test.stops).toEqual(["docs"])
      yield* TestClock.adjust("500 millis")
      expect(test.starts).toEqual(["docs"])
    }).pipe(provideLayer(test.layer))
  })

  it.effect("restarts after an unexpected exit and restores desired services exactly once after a cold start", () => {
    const test = harness()
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(test.layer)
          yield* Context.get(context, RepositoryServices).ensure(service)
        }),
      )
      expect(test.starts).toEqual(["docs"])
      expect(test.stops).toEqual(["docs"])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(test.layer)
          const services = Context.get(context, RepositoryServices)
          yield* services.resume
          expect(test.starts).toEqual(["docs", "docs"])
          yield* Deferred.succeed(test.exits[1]!, 1)
          yield* TestClock.adjust("100 millis")
          expect(test.starts).toEqual(["docs", "docs", "docs"])
          yield* services.stop("docs")
        }),
      )
      expect(test.records.get("docs")?.desired).toBe(false)
    })
  })

  it.effect("rejects conflicting definitions", () => {
    const test = harness()
    return Effect.gen(function* () {
      const services = yield* RepositoryServices
      yield* services.ensure(service)
      const error = yield* Effect.flip(services.ensure({ ...service, command: "node" }))
      expect(error.kind).toBe("conflict")
      expect(test.starts).toEqual(["docs"])
    }).pipe(provideLayer(test.layer))
  })

  it.effect("fences persisted desired state by assignment generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const platform = yield* Layer.build(BunServices.layer)
        const fileSystem = Context.get(platform, FileSystem.FileSystem)
        const stateDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-repository-services-" })
        const fence = {
          target: "e2b",
          assignmentId: "assignment-1",
          assignmentGeneration: 1,
          instanceId: "sandbox-1",
          executorId: "executor-1",
          processIncarnation: "process-1",
        } satisfies Fence
        const first = yield* Layer.build(repositoryLayer({ stateDirectory, fence })).pipe(Effect.provide(platform))
        yield* Context.get(first, Repository).save({ ...service, desired: true })
        const restored = yield* Layer.build(repositoryLayer({ stateDirectory, fence })).pipe(Effect.provide(platform))
        expect(yield* Context.get(restored, Repository).list).toEqual([{ ...service, desired: true }])
        const replacement = yield* Layer.build(
          repositoryLayer({ stateDirectory, fence: { ...fence, assignmentGeneration: 2 } }),
        ).pipe(Effect.provide(platform))
        expect(yield* Context.get(replacement, Repository).list).toEqual([])
      }),
    ),
  )
})
