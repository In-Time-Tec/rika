import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import { Context, Effect, FileSystem, Layer, Ref } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as ProductDatabase from "../../src/database/product-database-layer"
import * as ThreadRepository from "../../src/thread/sqlite-thread-repository"
import * as TurnRepository from "../../src/turn/sqlite-turn-repository"
import { productLayer } from "../support/operation-layer-harness"

it.layer(BunServices.layer)("product layer thread deletion recovery", (test) => {
  test.effect("reconciles a seeded deletion outbox while the layer is acquired", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-product-deletion-recovery-" })
        const database = ProductDatabase.layer(`${directory}/rika.db`).pipe(Layer.provide(BunServices.layer))
        const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(database))
        const turnRepositoryLayer = TurnRepository.layer.pipe(Layer.provide(database))
        const databaseContext = yield* Layer.build(database)
        const repositoryContext = yield* Layer.build(repositoryLayer)
        const repository = Context.get(repositoryContext, ThreadRepository.Service)
        const sql = Context.get(databaseContext, SqlClient)
        const threadId = Thread.ThreadId.make("seeded-deletion")
        yield* repository.create({ id: threadId, workspace: "/work", title: "Thread", now: 1 })
        yield* repository.requestDeletion(threadId, 2)
        expect(yield* sql`SELECT id FROM rika_threads WHERE id = ${threadId}`).toHaveLength(1)
        expect(
          yield* sql`SELECT thread_id FROM rika_thread_deletion_outbox WHERE thread_id = ${threadId}`,
        ).toHaveLength(1)
        const calls = yield* Ref.make<ReadonlyArray<string>>([])
        const record = (operation: string) => Ref.update(calls, (current) => [...current, operation])

        yield* Layer.build(
          productLayer({
            repositoryLayer,
            turnRepositoryLayer,
            backendLayer: ExecutionGateway.layerTest(),
            executionSessionLifecycleLayer: ExecutionSessionLifecycle.layerTest({
              requestCancellation: () => record("cancel"),
              awaitTerminal: () => record("terminal"),
              closeKernel: () => record("close"),
              dropKernelState: () => record("drop"),
            }),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("unused")),
          }),
        )

        expect(yield* Ref.get(calls)).toEqual(["cancel", "terminal", "close", "drop"])
        expect(yield* sql`SELECT id FROM rika_threads WHERE id = ${threadId}`).toEqual([])
        expect(yield* sql`SELECT thread_id FROM rika_thread_deletion_outbox WHERE thread_id = ${threadId}`).toEqual([])
      }),
    ),
  )
})
