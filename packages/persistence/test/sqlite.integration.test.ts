import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import { Database, Thread, ThreadRepository, ThreadSummaryRepository } from "../src"
import * as TurnRepository from "../src/turn-repository"
import * as Turn from "../src/turn-schema"

const id = Thread.ThreadId.make("thread-a")

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

test("creates, persists, and reopens the current schema", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-persistence-" })
      const filename = `${directory}/rika.db`
      const database = Database.layer(filename)
      const layer = Layer.merge(
        ThreadRepository.layer.pipe(Layer.provide(database)),
        Layer.merge(
          TurnRepository.layer.pipe(Layer.provide(database)),
          ThreadSummaryRepository.layer.pipe(Layer.provide(database)),
        ),
      )
      yield* Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        yield* repository.create({
          id,
          workspace: "/work/a",
          title: "First",
          now: 1,
        })
        yield* repository.label(id, ["local"], 2)
        const turns = yield* TurnRepository.Service
        yield* turns.createForSubmission({
          id: Turn.TurnId.make("turn-a"),
          threadId: id,
          prompt: "hello",
          now: 3,
        })
        yield* turns.setExtensionPin(Turn.TurnId.make("turn-a"), {
          generation: "generation-a",
          sourceDigest: "source-a",
          configFingerprint: "config-a",
          toolSchemaDigest: "tools-a",
          mcpFingerprint: "mcp-a",
          resolvedContextDigest: "context-a",
        })
        yield* turns.setStatus(Turn.TurnId.make("turn-a"), "completed", "cursor-a", 4)
        const summaries = yield* ThreadSummaryRepository.Service
        yield* summaries.replaceTurn({
          turnId: Turn.TurnId.make("turn-a"),
          threadId: id,
          projectedCursor: "cursor-a",
          complete: true,
          editTotals: { added: 3, modified: 2, removed: 1 },
          lastEventAt: 5,
          now: 5,
        })
        yield* summaries.markRead(id, 6)
      }).pipe(provideLayer(layer))
      const reopenedDatabase = Database.layer(filename)
      const reopened = Layer.merge(
        ThreadRepository.layer.pipe(Layer.provide(reopenedDatabase)),
        Layer.merge(
          TurnRepository.layer.pipe(Layer.provide(reopenedDatabase)),
          ThreadSummaryRepository.layer.pipe(Layer.provide(reopenedDatabase)),
        ),
      )
      return yield* Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const summaries = yield* ThreadSummaryRepository.Service
        return {
          thread: yield* repository.get(id),
          turn: yield* turns.get(Turn.TurnId.make("turn-a")),
          summaries: yield* summaries.list(),
        }
      }).pipe(provideLayer(reopened))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      program.pipe(
        provideLayer(BunServices.layer),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.thread?.title).toBe("First")
            expect(result.thread?.labels).toEqual(["local"])
            expect(result.turn?.status).toBe("completed")
            expect(result.turn?.lastCursor).toBe("cursor-a")
            expect(result.turn?.extensionPin).toEqual({
              generation: "generation-a",
              sourceDigest: "source-a",
              configFingerprint: "config-a",
              toolSchemaDigest: "tools-a",
              mcpFingerprint: "mcp-a",
              resolvedContextDigest: "context-a",
            })
            expect(result.summaries).toMatchObject([
              {
                id: "thread-a",
                unread: false,
                lastActivityAt: 5,
                editTotals: { added: 3, modified: 2, removed: 1 },
              },
            ])
          }),
        ),
      ),
    ),
  )
})

test("turn SQL mutations, ordering, and rejection branches", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-turns-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.merge(
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
      )
      return yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        yield* threads.create({
          id,
          workspace: "/work",
          title: "A",
          now: 1,
        })
        const active = yield* turns.createForSubmission({
          id: Turn.TurnId.make("active"),
          threadId: id,
          prompt: "a",
          now: 2,
        })
        const second = yield* turns.createForSubmission({
          id: Turn.TurnId.make("second"),
          threadId: id,
          prompt: "b",
          now: 3,
        })
        const third = yield* turns.createForSubmission({
          id: Turn.TurnId.make("third"),
          threadId: id,
          prompt: "c",
          now: 4,
        })
        expect((yield* turns.findActive(id))?.id).toBe(active.id)
        expect((yield* turns.listQueued(id)).map((turn) => turn.id)).toEqual([second.id, third.id])
        expect((yield* turns.listNonterminal).map((turn) => turn.id)).toEqual([active.id, second.id, third.id])
        expect(yield* turns.claimNextQueued(id, 5)).toBeUndefined()
        expect((yield* turns.editQueued(second.id, "edited", 6)).prompt).toBe("edited")
        expect((yield* Effect.result(turns.editQueued(active.id, "no", 6)))._tag).toBe("Failure")
        expect((yield* Effect.result(turns.dequeue(active.id)))._tag).toBe("Failure")
        yield* turns.dequeue(third.id)
        yield* turns.setStatus(active.id, "completed", undefined, 7)
        expect((yield* turns.claimNextQueued(id, 8))?.id).toBe(second.id)
        expect((yield* turns.list(id)).map((turn) => turn.id)).toEqual([active.id, second.id])
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
