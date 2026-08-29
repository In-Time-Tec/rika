import * as PgClient from "@effect/sql-pg/PgClient"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ThreadResult from "@rika/product/thread-result"
import * as Thread from "@rika/product/thread-record"
import * as TurnContract from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import { expect, it } from "@effect/vitest"
import { eq } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Config, DateTime, Effect, FileSystem, Layer, Random, Redacted } from "effect"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { identityUser } from "../../../../identity/src/database/account-schema"
import { identityMigrations } from "../../../../identity/src/database/migrations"
import { runMigration } from "../../../../identity/src/database/postgres"
import {
  rikaHostedOwners,
  rikaHostedThreads,
  rikaHostedWorkspaces,
  rikaThreads,
  rikaTurns,
  rikaWorkspaces,
} from "../../../src/database/schema/product"
import { migrations } from "../../../src/hosted/migrations"
import * as TurnRepository from "../../../src/turn/postgres/repository"

type CurrentCreateInput = Omit<
  Parameters<TurnContract.Interface["createForSubmission"]>[0],
  "executionRoute" | "queueCapacity"
> & {
  readonly executionRoute?: ExecutionRouteSnapshot.ExecutionRouteSnapshot
  readonly queueCapacity?: number
}

const create = (repository: TurnContract.Interface, input: CurrentCreateInput) =>
  repository.createForSubmission({
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    ...input,
    queueCapacity: input.queueCapacity ?? 128,
  })

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const readFileString = (url: URL) =>
  Effect.scoped(
    Layer.build(BunServices.layer).pipe(
      Effect.flatMap((context) =>
        Effect.provide(
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(fileURLToPath(url))),
          context,
        ),
      ),
    ),
  )

const isolated = <A, E, R>(run: (url: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = `rika_turn_repository_${Math.abs(yield* Random.nextInt)}_${Math.abs(yield* Random.nextInt)}`
    const admin = new Pool({ connectionString: databaseUrl })
    yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
    const parsed = new URL(databaseUrl)
    parsed.pathname = `/${database}`
    const url = parsed.toString()
    const pool = new Pool({ connectionString: url })
    try {
      for (const migration of [...identityMigrations, ...migrations]) {
        const sql = yield* readFileString(migration.url)
        yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
      }
      return yield* run(url)
    } finally {
      yield* Effect.tryPromise(() => pool.end())
      yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
      yield* Effect.tryPromise(() => admin.end())
    }
  })

const postgresLayer = (url: string) => {
  const postgres = PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })
  return TurnRepository.layer.pipe(Layer.provideMerge(postgres))
}

it.effect.skipIf(databaseUrl === "")("runs the turn repository contract against isolated PostgreSQL", () =>
  isolated((url) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(postgresLayer(url))
        yield* Effect.gen(function* () {
          const repository = yield* TurnRepository.Service
          const db = yield* PgDrizzle.makeWithDefaults()
          const ownerId = "turn-contract-owner"
          const workspace = "/turn-contract"
          const threadId = Thread.ThreadId.make("turn-contract-main")
          const pageThreadId = Thread.ThreadId.make("turn-contract-page")
          const malformedThreadId = Thread.ThreadId.make("turn-contract-malformed")
          const admissionThreadId = Thread.ThreadId.make("turn-contract-admission")
          const requeueThreadId = Thread.ThreadId.make("turn-contract-requeue")
          const shellThreadId = Thread.ThreadId.make("turn-contract-shell")
          const now = DateTime.toDate(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"))

          yield* db.insert(identityUser).values({
            id: "turn-contract-user",
            name: "Turn Contract",
            email: "turn-contract@example.test",
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          })
          yield* db.insert(rikaHostedOwners).values({ id: ownerId, kind: "personal", userId: "turn-contract-user" })
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(rikaHostedWorkspaces).values({
                id: workspace,
                ownerId,
                createdByUserId: "turn-contract-user",
                executorKind: "orb",
                inheritProjectGrants: false,
                createdAt: now,
              })
              yield* tx.insert(rikaWorkspaces).values({ ownerId, path: workspace, createdAt: 1 })
              yield* tx.insert(rikaHostedThreads).values(
                [threadId, pageThreadId, malformedThreadId, admissionThreadId, requeueThreadId, shellThreadId].map(
                  (id) => ({
                    id,
                    ownerId,
                    workspaceId: workspace,
                    createdByUserId: "turn-contract-user",
                    executorKind: "orb" as const,
                    inheritProjectGrants: false,
                    createdAt: now,
                  }),
                ),
              )
              yield* tx.insert(rikaThreads).values(
                [threadId, pageThreadId, malformedThreadId, admissionThreadId, requeueThreadId, shellThreadId].map(
                  (id) => ({
                    id,
                    ownerId,
                    workspace,
                    title: id,
                    createdAt: 1,
                    updatedAt: 1,
                  }),
                ),
              )
            }),
          )

          const promptParts: ReadonlyArray<ExecutionRequest.PromptPart> = [
            { type: "text", text: "inspect " },
            { type: "image", mediaType: "image/png", data: "cG5n", filename: "shot.png" },
          ]
          const active = yield* create(repository, {
            id: Turn.TurnId.make("turn-active"),
            threadId,
            prompt: "inspect [Image 1]",
            promptParts,
            now: 1,
          })
          const queued = yield* create(repository, {
            id: Turn.TurnId.make("turn-queued"),
            threadId,
            prompt: "queued",
            now: 2,
          })
          const dequeued = yield* create(repository, {
            id: Turn.TurnId.make("turn-dequeued"),
            threadId,
            prompt: "dequeue",
            now: 3,
          })

          expect(active).toMatchObject({ status: "accepted", promptParts })
          const storedActive = yield* repository.get(active.id)
          expect(
            storedActive !== undefined && ThreadResult.TurnResult.isAgentExecution(storedActive)
              ? storedActive.promptParts
              : undefined,
          ).toEqual(promptParts)
          expect(yield* repository.get(Turn.TurnId.make("missing"))).toBeUndefined()
          expect((yield* repository.list(threadId)).map((turn) => turn.id)).toEqual([active.id, queued.id, dequeued.id])
          const persisted = yield* db
            .select({ promptPartsJson: rikaTurns.promptPartsJson })
            .from(rikaTurns)
            .where(eq(rikaTurns.id, active.id))
          expect(persisted[0]?.promptPartsJson).not.toBeNull()

          expect((yield* repository.findActive(threadId))?.id).toBe(active.id)
          expect(yield* repository.findActive(pageThreadId)).toBeUndefined()
          expect(yield* repository.readQueue(threadId)).toMatchObject({
            revision: 2,
            queuedCount: 2,
            turns: [{ id: queued.id }, { id: dequeued.id }],
          })
          expect((yield* repository.listNonterminal).map((turn) => turn.id)).toEqual([
            active.id,
            queued.id,
            dequeued.id,
          ])

          expect((yield* Effect.result(repository.setStatus(active.id, "queued", 4)))._tag).toBe("Failure")
          expect((yield* Effect.result(repository.setStatus(queued.id, "completed", 4)))._tag).toBe("Failure")
          expect((yield* Effect.result(repository.setStatus(Turn.TurnId.make("missing"), "failed", 4)))._tag).toBe(
            "Failure",
          )
          yield* repository.setStatus(active.id, "running", 4)
          yield* repository.setStatus(active.id, "completed", 5)
          expect((yield* repository.get(active.id))?.status).toBe("completed")

          const claim = yield* repository.claimNextQueued(threadId, 6)
          if (claim === undefined) return yield* Effect.die("Expected queued claim")
          expect(claim.turn.id).toBe(queued.id)
          expect(yield* repository.claimNextQueued(threadId, 7)).toBeUndefined()
          yield* repository.releaseQueuedClaim(claim)
          const released = yield* repository.claimNextQueued(threadId, 8)
          if (released === undefined) return yield* Effect.die("Expected released claim")
          expect(released.turn.id).toBe(queued.id)
          yield* repository.resetQueueClaims
          const reset = yield* repository.claimNextQueued(threadId, 9)
          if (reset === undefined) return yield* Effect.die("Expected reset claim")
          expect(reset.turn.id).toBe(queued.id)
          const edited = yield* repository.editQueued(queued.id, "edited", 10)
          expect(edited).toMatchObject({ prompt: "edited", queue: { revision: 3, queuedCount: 2 } })
          expect(edited.promptParts).toBeUndefined()
          expect(yield* repository.finishQueuedClaim(reset, "running", 11)).toEqual({ _tag: "Unavailable" })
          const replacement = yield* repository.claimNextQueued(threadId, 12)
          if (replacement === undefined) return yield* Effect.die("Expected replacement claim")
          expect((yield* repository.finishQueuedClaim(replacement, "running", 13))._tag).toBe("Transitioned")
          expect((yield* repository.get(queued.id))?.status).toBe("running")
          expect(yield* repository.dequeue(dequeued.id)).toMatchObject({ revision: 5, queuedCount: 0 })
          expect(yield* repository.get(dequeued.id)).toBeUndefined()
          expect((yield* Effect.result(repository.dequeue(dequeued.id)))._tag).toBe("Failure")
          expect((yield* repository.listRecentNonqueued(threadId, 1)).map((turn) => turn.id)).toEqual([queued.id])

          const admissionTarget = yield* create(repository, {
            id: Turn.TurnId.make("turn-admission-target"),
            threadId: admissionThreadId,
            prompt: "admission",
            now: 20,
          })
          const startInput: ExecutionGateway.StartTurn = {
            threadId: admissionThreadId,
            turnId: admissionTarget.id,
            workspaceId: workspace,
            prompt: admissionTarget.prompt,
            promptParts: [{ type: "text", text: admissionTarget.prompt }],
            executionRoute: admissionTarget.executionRoute,
            titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "Admission" },
          }
          expect(yield* repository.prepareExecutionAdmission(startInput, 21)).toEqual(startInput)
          expect(yield* repository.prepareExecutionAdmission(startInput, 22)).toEqual(startInput)
          expect(
            (yield* Effect.result(repository.prepareExecutionAdmission({ ...startInput, prompt: "changed" }, 23)))._tag,
          ).toBe("Failure")
          expect(yield* repository.listUnlinkedExecutionAdmissions).toEqual([startInput])
          const link: ExecutionGateway.ExecutionLink = {
            runId: "run-admission-target",
            turnId: admissionTarget.id,
            threadId: admissionThreadId,
          }
          expect(
            (yield* Effect.result(
              repository.attachExecutionLink(admissionTarget.id, { ...link, threadId: pageThreadId }, 24),
            ))._tag,
          ).toBe("Failure")
          expect(yield* repository.listUnlinkedExecutionAdmissions).toEqual([startInput])
          expect(yield* repository.attachExecutionLink(admissionTarget.id, link, 25)).toMatchObject({
            executionLink: link,
          })
          expect(yield* repository.listUnlinkedExecutionAdmissions).toEqual([])
          expect(yield* repository.attachExecutionLink(admissionTarget.id, link, 26)).toMatchObject({
            executionLink: link,
          })
          expect(
            (yield* Effect.result(
              repository.attachExecutionLink(admissionTarget.id, { ...link, runId: "different-run" }, 27),
            ))._tag,
          ).toBe("Failure")
          expect(yield* repository.startAccepted(admissionTarget.id, 28)).toBe(true)
          expect(yield* repository.startAccepted(admissionTarget.id, 29)).toBe(false)
          expect(yield* repository.cancelUnlinked(admissionTarget.id, 30)).toBe(false)

          const directInput: ExecutionGateway.SteeringInput = {
            text: "direct steering",
            idempotencyKey: "steering-direct",
          }
          const directAdmission = yield* repository.prepareSteeringAdmission(link, directInput, [], 31)
          expect(directAdmission).toMatchObject({ target: link, input: directInput, outcome: { _tag: "Pending" } })
          expect(yield* repository.prepareSteeringAdmission(link, directInput, [], 32)).toEqual(directAdmission)
          expect(
            (yield* Effect.result(
              repository.prepareSteeringAdmission(link, { ...directInput, text: "changed" }, [], 33),
            ))._tag,
          ).toBe("Failure")
          const directReceipt: ExecutionGateway.SteeringReceipt = { entryId: "entry-direct", sequence: 1 }
          expect(yield* repository.acceptSteeringAdmission(directInput.idempotencyKey, directReceipt)).toMatchObject({
            outcome: { _tag: "Accepted", receipt: directReceipt },
          })
          expect(yield* repository.acceptSteeringAdmission(directInput.idempotencyKey, directReceipt)).toMatchObject({
            outcome: { _tag: "Accepted", receipt: directReceipt },
          })
          expect(
            (yield* Effect.result(
              repository.acceptSteeringAdmission(directInput.idempotencyKey, {
                ...directReceipt,
                sequence: 2,
              }),
            ))._tag,
          ).toBe("Failure")
          expect(
            yield* repository.completeSteeringAdmission(directInput.idempotencyKey, link, directReceipt),
          ).toBeUndefined()
          expect(yield* repository.listSteeringAdmissions).toEqual([])

          const steeringSource = yield* create(repository, {
            id: Turn.TurnId.make("turn-steering-source"),
            threadId: admissionThreadId,
            prompt: "queued steering",
            now: 34,
          })
          const queuedInput: ExecutionGateway.SteeringInput = {
            text: steeringSource.prompt,
            idempotencyKey: "steering-queued",
          }
          const preparedQueued = yield* repository.prepareQueuedSteeringAdmission(
            steeringSource.id,
            link,
            queuedInput,
            [],
            35,
          )
          expect(preparedQueued).toMatchObject({
            admission: { source: { id: steeringSource.id }, outcome: { _tag: "Pending" } },
            queueChanged: true,
            queue: { revision: 2, queuedCount: 0, change: { _tag: "Removed", turnId: steeringSource.id } },
          })
          expect(yield* repository.readQueue(admissionThreadId)).toMatchObject({ queuedCount: 0, turns: [] })
          expect(
            yield* repository.prepareQueuedSteeringAdmission(steeringSource.id, link, queuedInput, [], 36),
          ).toMatchObject({ queueChanged: false, queue: { revision: 2, queuedCount: 0 } })
          expect(
            (yield* Effect.result(
              repository.prepareQueuedSteeringAdmission(
                steeringSource.id,
                link,
                { ...queuedInput, text: "changed" },
                [],
                37,
              ),
            ))._tag,
          ).toBe("Failure")
          const rejection = ExecutionGateway.SteeringFailure.make({ kind: "rejected", message: "target settled" })
          expect(yield* repository.rejectSteeringAdmission(queuedInput.idempotencyKey, rejection)).toMatchObject({
            outcome: {
              _tag: "Rejected",
              failure: rejection,
              queue: { revision: 3, queuedCount: 1, change: { _tag: "Added", turn: { id: steeringSource.id } } },
            },
          })
          expect(yield* repository.readQueue(admissionThreadId)).toMatchObject({
            revision: 3,
            queuedCount: 1,
            turns: [{ id: steeringSource.id }],
          })
          expect(yield* repository.completeRejectedSteeringAdmission(queuedInput.idempotencyKey)).toBe(true)
          expect(yield* repository.completeRejectedSteeringAdmission(queuedInput.idempotencyKey)).toBe(true)
          expect(
            yield* Effect.result(
              repository.prepareQueuedSteeringAdmission(
                Turn.TurnId.make("missing-steering-source"),
                link,
                { text: "missing", idempotencyKey: "steering-missing" },
                [],
                38,
              ),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { _tag: "QueuedTurnUnavailable" } })

          const acceptedSource = yield* create(repository, {
            id: Turn.TurnId.make("turn-steering-accepted-source"),
            threadId: admissionThreadId,
            prompt: "accepted steering",
            now: 38,
          })
          const acceptedInput: ExecutionGateway.SteeringInput = {
            text: acceptedSource.prompt,
            idempotencyKey: "steering-accepted",
          }
          expect(
            yield* repository.prepareQueuedSteeringAdmission(acceptedSource.id, link, acceptedInput, [], 39),
          ).toMatchObject({ queueChanged: true, queue: { revision: 5, queuedCount: 1 } })
          const acceptedReceipt: ExecutionGateway.SteeringReceipt = { entryId: "entry-accepted", sequence: 2 }
          yield* repository.acceptSteeringAdmission(acceptedInput.idempotencyKey, acceptedReceipt)
          expect(
            yield* repository.completeSteeringAdmission(acceptedInput.idempotencyKey, link, acceptedReceipt),
          ).toBeUndefined()
          expect(yield* repository.get(acceptedSource.id)).toBeUndefined()
          expect(yield* repository.dequeue(steeringSource.id)).toMatchObject({ revision: 6, queuedCount: 0 })

          const requeueTarget = yield* create(repository, {
            id: Turn.TurnId.make("turn-requeue-target"),
            threadId: requeueThreadId,
            prompt: "requeue",
            now: 40,
          })
          expect(yield* repository.requeueAccepted(requeueTarget.id, 1, 41)).toMatchObject({
            status: "queued",
            queue: { revision: 1, queuedCount: 1 },
          })
          const requeueClaim = yield* repository.claimNextQueued(requeueThreadId, 42)
          if (requeueClaim === undefined) return yield* Effect.die("Expected requeued claim")
          expect(yield* repository.finishQueuedClaim(requeueClaim, "failed", 43)).toMatchObject({
            _tag: "Transitioned",
            turn: { status: "failed" },
            queue: { revision: 2, queuedCount: 0 },
          })
          const settledRequeueTarget = yield* repository.get(requeueTarget.id)
          if (settledRequeueTarget?._tag !== "AgentExecution")
            return yield* Effect.die("Expected settled requeue target")
          const copiedAgent = {
            ...settledRequeueTarget,
            id: Turn.TurnId.make("turn-agent-copy"),
            threadId: shellThreadId,
            createdAt: 44,
            updatedAt: 44,
          }
          expect(yield* repository.copy(copiedAgent, 1)).toEqual(copiedAgent)

          const runningShell: ThreadResult.RunningRecordedShellTurn = {
            _tag: "RecordedShell",
            id: Turn.TurnId.make("turn-shell-running"),
            threadId: shellThreadId,
            prompt: "$ printf shell",
            command: "printf shell",
            status: "running",
            author: { _tag: "Human" },
            lineage: { _tag: "Original" },
            createdAt: 44,
            updatedAt: 44,
          }
          expect(yield* repository.createRecordedShell(runningShell)).toEqual(runningShell)
          const terminalShell: ThreadResult.TerminalRecordedShellTurn = {
            ...runningShell,
            status: "completed",
            result: { text: "shell", truncated: false, exitCode: 0 },
            updatedAt: 45,
          }
          expect(
            yield* repository.settleRecordedShell({ ...runningShell, command: "changed" }, terminalShell),
          ).toBeUndefined()
          expect(yield* repository.settleRecordedShell(runningShell, terminalShell)).toEqual(terminalShell)
          expect(yield* repository.settleRecordedShell(runningShell, terminalShell)).toBeUndefined()
          const copiedShell: ThreadResult.TerminalRecordedShellTurn = {
            ...terminalShell,
            id: Turn.TurnId.make("turn-shell-copy"),
            createdAt: 46,
            updatedAt: 46,
          }
          expect(yield* repository.copyRecordedShell(copiedShell)).toEqual(copiedShell)
          expect((yield* repository.list(shellThreadId)).map((turn) => turn.id)).toEqual([
            copiedAgent.id,
            runningShell.id,
            copiedShell.id,
          ])

          const pageIds: Array<Turn.TurnId> = []
          for (let index = 1; index <= 4; index++) {
            const turn = yield* create(repository, {
              id: Turn.TurnId.make(`page-${index}`),
              threadId: pageThreadId,
              prompt: `page ${index}`,
              now: index,
            })
            pageIds.push(turn.id)
            yield* repository.setStatus(turn.id, "completed", index)
          }
          const newest = yield* repository.page(pageThreadId, { limit: 2 })
          const older = yield* repository.page(pageThreadId, { before: newest.oldestCursor, limit: 2 })
          expect(newest.turns.map((turn) => turn.id)).toEqual(pageIds.slice(2))
          expect(newest.hasOlder).toBe(true)
          expect(older.turns.map((turn) => turn.id)).toEqual(pageIds.slice(0, 2))
          expect(older.hasOlder).toBe(false)

          const malformed = yield* create(repository, {
            id: Turn.TurnId.make("turn-malformed"),
            threadId: malformedThreadId,
            prompt: "malformed",
            now: 1,
          })
          yield* db.update(rikaTurns).set({ executionRouteJson: "{" }).where(eq(rikaTurns.id, malformed.id))
          const malformedResult = yield* Effect.result(repository.get(malformed.id))
          expect(malformedResult).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnRepositoryError" } })
        }).pipe(Effect.provide(context))
      }),
    ),
  ),
)
