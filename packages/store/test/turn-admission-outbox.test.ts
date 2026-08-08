import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/store/sqlite-thread-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as Database from "../src/database/product-database-layer"
import { Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

const withStore = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, ThreadRepository.Service | TurnRepository.Service | SqlClient>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = Database.layer(filename)
      const context = yield* Layer.build(
        Layer.mergeAll(
          database,
          ThreadRepository.layer.pipe(Layer.provide(database)),
          TurnRepository.layer.pipe(Layer.provide(database)),
        ),
      )
      return yield* effect.pipe(Effect.provide(context))
    }),
  )

const count = (rows: ReadonlyArray<unknown>) => Number((rows[0] as { readonly count: unknown }).count)

it.layer(BunServices.layer)("SQLite turn admission outbox", (test) => {
  test.effect("survives reopen and atomically attaches exactly one matching execution link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-turn-admission-" })
        const filename = `${directory}/rika.db`
        const threadId = Thread.ThreadId.make("admission-thread")
        const turnId = Turn.TurnId.make("admission-turn")
        const promptParts = [{ type: "text" as const, text: "persisted admission" }]
        const input: ExecutionGateway.StartTurn = {
          threadId,
          turnId,
          workspace: "/workspace",
          prompt: "persisted admission",
          promptParts,
          executionRoute: ExecutionRouteSnapshot.testExecutionRoute("high"),
          titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "Persisted admission" },
        }

        yield* withStore(
          filename,
          Effect.gen(function* () {
            const threads = yield* ThreadRepository.Service
            const turns = yield* TurnRepository.Service
            const sql = yield* SqlClient
            yield* threads.create({ id: threadId, workspace: input.workspace, title: "Admission", now: 1 })
            yield* turns.createForSubmission({
              id: turnId,
              threadId,
              prompt: input.prompt,
              promptParts,
              executionRoute: input.executionRoute,
              queueCapacity: 128,
              now: 2,
            })
            expect(yield* turns.prepareExecutionAdmission(input, 3)).toEqual(input)
            expect(count(yield* sql`SELECT COUNT(*) AS count FROM rika_turn_admission_outbox`)).toBe(1)
          }),
        )

        yield* withStore(
          filename,
          Effect.gen(function* () {
            const turns = yield* TurnRepository.Service
            const sql = yield* SqlClient
            expect(yield* turns.listUnlinkedExecutionAdmissions).toEqual([input])

            const link: ExecutionGateway.ExecutionLink = { runId: "run-1", threadId, turnId }
            const identityConflict = yield* Effect.result(
              turns.attachExecutionLink(turnId, { ...link, threadId: "different-thread" }, 4),
            )
            expect(identityConflict).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "TurnRepositoryError" },
            })
            expect(count(yield* sql`SELECT COUNT(*) AS count FROM rika_turn_admission_outbox`)).toBe(1)

            yield* sql`CREATE TRIGGER reject_admission_delete
              BEFORE DELETE ON rika_turn_admission_outbox
              BEGIN SELECT RAISE(ABORT, 'simulated admission delete failure'); END`
            expect((yield* Effect.result(turns.attachExecutionLink(turnId, link, 5)))._tag).toBe("Failure")
            expect(yield* sql`SELECT execution_link_json FROM rika_turns WHERE id = ${turnId}`).toEqual([
              { execution_link_json: null },
            ])
            expect(count(yield* sql`SELECT COUNT(*) AS count FROM rika_turn_admission_outbox`)).toBe(1)
            yield* sql`DROP TRIGGER reject_admission_delete`

            expect(yield* turns.attachExecutionLink(turnId, link, 6)).toMatchObject({ executionLink: link })
            expect(yield* turns.listUnlinkedExecutionAdmissions).toEqual([])
            expect(count(yield* sql`SELECT COUNT(*) AS count FROM rika_turn_admission_outbox`)).toBe(0)
            expect(yield* turns.attachExecutionLink(turnId, link, 7)).toMatchObject({
              executionLink: link,
              updatedAt: 6,
            })
            expect(
              yield* Effect.result(turns.attachExecutionLink(turnId, { ...link, runId: "run-2" }, 8)),
            ).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnRepositoryError" } })
          }),
        )
      }),
    ),
  )
})
