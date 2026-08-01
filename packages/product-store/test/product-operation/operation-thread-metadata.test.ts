import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Catalog as ToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import { Effect, Layer, Ref, Schema } from "effect"
import { TestConsole } from "effect/testing"
import { Operation } from "@rika/product/product-operation-service"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { backend } from "../support/operation-execution-fixtures"

describe("Operation", () => {
  it.effect("runs thread metadata and tool catalog operations", () =>
    Effect.gen(function* () {
      const ids = yield* Ref.make(["thread-a", "session-a"] as ReadonlyArray<string>)
      const nextId = Effect.gen(function* () {
        const values = yield* Ref.get(ids)
        const value = values[0]
        if (value === undefined) return yield* Effect.die("No test id")
        yield* Ref.set(ids, values.slice(1))
        return value
      })
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const layer = Layer.mergeAll(
        TestConsole.layer,
        productLayer({
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: nextId.pipe(Effect.map(Thread.ThreadId.make)),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Thread", action: "new", clientWorkspace: "/client-work" })
        yield* operation.run({ _tag: "Thread", action: "rename", threadId: "thread-a", title: "\nNamed\tthread\u001b" })
        yield* operation.run({ _tag: "Thread", action: "label", threadId: "thread-a", labels: ["one"] })
        yield* operation.run({ _tag: "Thread", action: "pin", threadId: "thread-a" })
        yield* operation.run({ _tag: "Thread", action: "archive", threadId: "thread-a" })
        yield* operation.run({ _tag: "Thread", action: "list", includeArchived: true })
        yield* operation.run({ _tag: "Thread", action: "search", query: ["Named thread"], includeArchived: true })
        yield* operation.run({ _tag: "Thread", action: "unarchive", threadId: "thread-a" })
        const catalogLine = (yield* TestConsole.logLines).length
        yield* operation.run({ _tag: "ToolCatalog", action: "list" })
        for (const mode of ["low", "medium", "high", "ultra"] as const)
          yield* operation.run({ _tag: "ToolCatalog", action: "list", mode })
        yield* operation.run({ _tag: "ToolCatalog", action: "show", name: "read" })
        const missing = yield* Effect.result(operation.run({ _tag: "ToolCatalog", action: "show", name: "missing" }))
        const catalogOutput = (yield* TestConsole.logLines).slice(catalogLine)
        yield* operation.run({ _tag: "Thread", action: "delete", threadId: "thread-a" })
        expect(missing._tag).toBe("Failure")
        if (missing._tag === "Failure")
          expect(missing.failure).toMatchObject({
            _tag: "OperationUnavailable",
            message: "Tool missing does not exist",
          })
        return { catalogOutput, lines: yield* TestConsole.logLines }
      }).pipe(provideLayer(layer))
      const lines = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(output.lines)
      expect(lines.some((line) => line.includes('"title":"Named thread"'))).toBe(true)
      expect(lines.some((line) => line.includes('"workspace":"/client-work"'))).toBe(true)
      expect(lines.some((line) => line.includes('"name":"read"'))).toBe(true)
      const catalogOutput = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(output.catalogOutput)
      expect(catalogOutput).toHaveLength(6)
      expect(new Set(catalogOutput.slice(0, 5))).toEqual(new Set([catalogOutput[0]!]))
      expect(catalogOutput[0]!.length).toBeLessThanOrEqual(40_000)
      expect(catalogOutput[5]!.length).toBeLessThanOrEqual(4_000)
      for (const forbidden of ["apiKey", "accessToken", "credential", "secret"]) {
        expect(catalogOutput[0]!.toLowerCase()).not.toContain(forbidden.toLowerCase())
        expect(catalogOutput[5]!.toLowerCase()).not.toContain(forbidden.toLowerCase())
      }
      const listedJson = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(catalogOutput[0]!)
      const definitions = yield* Schema.decodeUnknownEffect(Schema.Array(ToolCatalog.Definition))(listedJson)
      expect(definitions.length).toBeGreaterThan(0)
      expect(definitions.length).toBeLessThanOrEqual(64)
      expect(new Set(definitions.map(({ name }) => name)).size).toBe(definitions.length)
      expect(
        definitions.every(
          ({ description, timeoutMillis, outputLimit, presentation }) =>
            description.length > 0 &&
            timeoutMillis > 0 &&
            timeoutMillis <= 600_000 &&
            outputLimit > 0 &&
            outputLimit <= 40_000 &&
            presentation.action.length > 0 &&
            presentation.activeLabel.length > 0 &&
            presentation.completeLabel.length > 0,
        ),
      ).toBe(true)
      const shownJson = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(catalogOutput[5]!)
      const shown = yield* Schema.decodeUnknownEffect(ToolCatalog.Definition)(shownJson)
      expect(shown).toEqual(definitions.find(({ name }) => name === "read"))
    }),
  )
})
