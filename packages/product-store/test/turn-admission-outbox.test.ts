import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as Database from "../src/database/product-database-layer"
import { Context, Deferred, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { executionSessionLifecycleLayerTest, productLayer } from "./support/operation-layer-harness"
import { backend, projectionSnapshot } from "./support/operation-execution-fixtures"

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
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

it.layer(BunServices.layer)("SQLite turn admission outbox", (test) => {
  test.effect("decodes the previous durable route version in turns and prepared admissions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-turn-route-version-" })
        const filename = `${directory}/rika.db`
        const threadId = Thread.ThreadId.make("route-version-thread")
        const turnId = Turn.TurnId.make("route-version-turn")
        const executionRoute = ExecutionRouteSnapshot.testExecutionRoute("high")
        const input: ExecutionGateway.StartTurn = {
          threadId,
          turnId,
          workspace: "/workspace",
          prompt: "persisted before recursive subagents",
          executionRoute,
        }

        yield* withStore(
          filename,
          Effect.gen(function* () {
            const threads = yield* ThreadRepository.Service
            const turns = yield* TurnRepository.Service
            const sql = yield* SqlClient
            yield* threads.create({ id: threadId, workspace: input.workspace, title: "Route version", now: 1 })
            yield* turns.createForSubmission({
              id: turnId,
              threadId,
              prompt: input.prompt,
              executionRoute,
              queueCapacity: 128,
              now: 2,
            })
            yield* turns.prepareExecutionAdmission(input, 3)
            const { subagents: _subagents, ...previousRoute } = executionRoute
            const legacyRoute = { ...previousRoute, version: 1 }
            const encodedRoute = encodeJson(legacyRoute)
            const encodedInput = encodeJson({ ...input, executionRoute: legacyRoute })
            yield* sql`UPDATE rika_turns SET execution_route_json = ${encodedRoute} WHERE id = ${turnId}`
            yield* sql`UPDATE rika_turn_admission_outbox SET start_input_json = ${encodedInput} WHERE turn_id = ${turnId}`

            expect(yield* turns.listNonterminal).toMatchObject([
              { id: turnId, executionRoute: { version: 2, subagents: { maxDepth: 1, maxSubagents: 4 } } },
            ])
            expect(yield* turns.listUnlinkedExecutionAdmissions).toMatchObject([
              {
                turnId,
                executionRoute: { version: 2, subagents: { maxDepth: 1, maxSubagents: 4 } },
              },
            ])
          }),
        )
      }),
    ),
  )

  test.effect("recovers steering and queued work when a nonterminal turn has the previous route version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-legacy-route-recovery-" })
        const filename = `${directory}/rika.db`
        const database = Database.layer(filename).pipe(Layer.provide(BunServices.layer))
        const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(database))
        const turnRepositoryLayer = TurnRepository.layer.pipe(Layer.provide(database))
        const transcriptRepositoryLayer = TranscriptRepository.layer.pipe(Layer.provide(database))
        const repositories = yield* Layer.build(
          Layer.mergeAll(database, repositoryLayer, turnRepositoryLayer, transcriptRepositoryLayer),
        )
        const threads = Context.get(repositories, ThreadRepository.Service)
        const turns = Context.get(repositories, TurnRepository.Service)
        const sql = Context.get(repositories, SqlClient)
        const threadId = Thread.ThreadId.make("legacy-route-recovery-thread")
        const activeId = Turn.TurnId.make("legacy-route-recovery-active")
        const steeringId = Turn.TurnId.make("legacy-route-recovery-steering")
        const followUpId = Turn.TurnId.make("legacy-route-recovery-follow-up")
        const route = ExecutionRouteSnapshot.testExecutionRoute("high")
        const link = { runId: "legacy-route-recovery-run", threadId, turnId: activeId }
        const provenance = {
          _tag: "AgentExecution" as const,
          author: { _tag: "Human" as const },
          lineage: { _tag: "Original" as const },
        }
        yield* threads.create({ id: threadId, workspace: "/workspace", title: "Legacy route recovery", now: 1 })
        yield* turns.copy(
          {
            ...provenance,
            id: activeId,
            threadId,
            prompt: "active",
            executionRoute: route,
            executionLink: link,
            status: "running",
            createdAt: 2,
            updatedAt: 2,
          },
          128,
        )
        yield* turns.copy(
          {
            ...provenance,
            id: steeringId,
            threadId,
            prompt: "steer the active turn",
            executionRoute: route,
            status: "queued",
            createdAt: 3,
            updatedAt: 3,
          },
          128,
        )
        yield* turns.copy(
          {
            ...provenance,
            id: followUpId,
            threadId,
            prompt: "run after completion",
            executionRoute: route,
            status: "queued",
            createdAt: 4,
            updatedAt: 4,
          },
          128,
        )
        const steering = { text: "steer the active turn", idempotencyKey: "legacy-route-recovery-steering" }
        yield* turns.prepareQueuedSteeringAdmission(steeringId, link, steering, [], 5)
        const { subagents: _subagents, ...previousRoute } = route
        yield* sql`UPDATE rika_turns SET execution_route_json = ${encodeJson({
          ...previousRoute,
          version: 1,
        })} WHERE id = ${activeId}`

        const steeringDelivered = yield* Deferred.make<void>()
        const followUpStarted = yield* Deferred.make<void>()
        const recoveryBackend = ExecutionGateway.Service.of({
          ...backend,
          startTurn: (input) =>
            Deferred.succeed(followUpStarted, undefined).pipe(
              Effect.as({ runId: `${input.turnId}-run`, threadId: input.threadId, turnId: input.turnId }),
            ),
          steerTurn: () =>
            Deferred.succeed(steeringDelivered, undefined).pipe(
              Effect.as({ entryId: "legacy-route-recovery-entry", sequence: 0 }),
            ),
          inspectTurn: () =>
            Deferred.isDone(steeringDelivered).pipe(
              Effect.map((delivered) => ({ status: delivered ? ("completed" as const) : ("running" as const) })),
            ),
          watchTurn: (target) =>
            target.turnId === activeId
              ? Stream.fromEffect(Deferred.await(steeringDelivered)).pipe(
                  Stream.map(() =>
                    projectionSnapshot(target.turnId, "completed", `${target.turnId}-completed`, "complete"),
                  ),
                )
              : Stream.make(projectionSnapshot(target.turnId, "completed", `${target.turnId}-completed`, "complete")),
        })
        yield* Layer.build(
          productLayer({
            repositoryLayer: Layer.succeedContext(repositories),
            turnRepositoryLayer: Layer.succeedContext(repositories),
            transcriptRepositoryLayer: Layer.succeedContext(repositories),
            backendLayer: Layer.succeed(ExecutionGateway.Service, recoveryBackend),
            executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
            defaultWorkspace: "/workspace",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
          }),
        )

        yield* Deferred.await(steeringDelivered)
        yield* Deferred.await(followUpStarted)
        while ((yield* turns.get(followUpId))?.status !== "completed") yield* Effect.yieldNow
        expect(yield* turns.get(activeId)).toMatchObject({
          status: "completed",
          executionRoute: { version: 2, subagents: { maxDepth: 1, maxSubagents: 4 } },
        })
        expect(yield* turns.get(steeringId)).toBeUndefined()
        expect(yield* turns.get(followUpId)).toMatchObject({ status: "completed" })
        expect(yield* turns.listSteeringAdmissions).toEqual([])
        expect(yield* turns.readQueue(threadId)).toMatchObject({ queuedCount: 0, turns: [] })
      }),
    ),
  )

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
