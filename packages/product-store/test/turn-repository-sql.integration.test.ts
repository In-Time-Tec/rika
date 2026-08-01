import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as TurnContract from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import { expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { makeRecordingSql } from "./recording-sql"

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

type CurrentCreateInput = Omit<
  Parameters<TurnContract.Interface["createForSubmission"]>[0],
  "executionRoute" | "queueCapacity"
> & {
  readonly executionRoute?: Turn.ExecutionRoutePin
  readonly queueCapacity?: number
}

const create = (repository: TurnContract.Interface, input: CurrentCreateInput) =>
  repository.createForSubmission({
    executionRoute: Turn.testExecutionRoute(),
    ...input,
    queueCapacity: input.queueCapacity ?? 128,
  })

const stopIntentContract = (label: string, layer: Layer.Layer<TurnRepository.Service, never, never>) =>
  it.effect(`${label} keeps a stopped turn out of the resumable set`, () =>
    Effect.gen(function* () {
      const repository = yield* TurnRepository.Service
      const threadId = Thread.ThreadId.make("stop-thread")
      const stopped = yield* create(repository, {
        id: Turn.TurnId.make("stopped-turn"),
        threadId,
        prompt: "stop me",
        now: 1,
      })
      expect(stopped.stopIntent).toBe("none")
      expect((yield* repository.listNonterminal).map((turn) => turn.id)).toEqual([stopped.id])
      expect(yield* repository.listStopRequested).toEqual([])

      const marked = yield* repository.requestStop(stopped.id, 2)
      expect(marked?.stopIntent).toBe("requested")

      // A stopped turn is still unfinished, but nothing may re-follow it after a restart.
      expect(yield* repository.listNonterminal).toEqual([])
      expect((yield* repository.listStopRequested).map((turn) => turn.id)).toEqual([stopped.id])
      expect((yield* repository.get(stopped.id))?.stopIntent).toBe("requested")
    }).pipe(provideLayer(layer)),
  )

stopIntentContract("memory", TurnRepository.memoryLayer())

it.effect("memory editQueued replaces content and clears stale prompt parts", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-edit")
    yield* create(repository, { id: Turn.TurnId.make("active"), threadId, prompt: "active", now: 1 })
    const queued = yield* create(repository, {
      id: Turn.TurnId.make("queued"),
      threadId,
      prompt: "old",
      promptParts: [{ type: "text", text: "old" }],
      now: 2,
    })
    yield* repository.editQueued(queued.id, "edited", 3)
    const stored = yield* repository.get(queued.id)
    expect(stored?.prompt).toBe("edited")
    expect(stored !== undefined && Turn.isAgentExecution(stored) ? stored.promptParts : undefined).toBeUndefined()
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory setStatus forbids transitions into or out of queued", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-guard")
    const active = yield* create(repository, { id: Turn.TurnId.make("active"), threadId, prompt: "active", now: 1 })
    const queued = yield* create(repository, { id: Turn.TurnId.make("queued"), threadId, prompt: "queued", now: 2 })
    expect((yield* Effect.result(repository.setStatus(active.id, "queued", undefined, 3)))._tag).toBe("Failure")
    const before = yield* repository.readQueue(threadId)
    expect(before.queuedCount).toBe(1)
    expect((yield* Effect.result(repository.setStatus(queued.id, "completed", undefined, 4)))._tag).toBe("Failure")
    const after = yield* repository.readQueue(threadId)
    expect(after).toEqual(before)
    expect((yield* repository.get(queued.id))?.status).toBe("queued")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory seeds queue revision to match the seeded queued count", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const snapshot = yield* repository.readQueue(Thread.ThreadId.make("thread-seed"))
    expect(snapshot.queuedCount).toBe(2)
    expect(snapshot.revision).toBe(2)
  }).pipe(
    provideLayer(
      TurnRepository.memoryLayer([
        {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("s1"),
          threadId: Thread.ThreadId.make("thread-seed"),
          prompt: "one",
          status: "queued",
          stopIntent: "none",
          executionRoute: Turn.testExecutionRoute(),
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _tag: "AgentExecution",
          id: Turn.TurnId.make("s2"),
          threadId: Thread.ThreadId.make("thread-seed"),
          prompt: "two",
          status: "queued",
          stopIntent: "none",
          executionRoute: Turn.testExecutionRoute(),
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          createdAt: 2,
          updatedAt: 2,
        },
      ]),
    ),
  ),
)

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "turn-a",
  thread_id: "thread-a",
  turn_kind: "AgentExecution",
  prompt: "hello",
  execution_route_json: JSON.stringify(Turn.testExecutionRoute()),
  shell_command: null,
  shell_result_text: null,
  shell_result_truncated: null,
  shell_result_exit_code: null,
  author_json: '{"_tag":"Human"}',
  lineage_json: '{"_tag":"Original"}',
  status: "accepted",
  last_cursor: null,
  created_at: 1,
  updated_at: 1,
  ...overrides,
})

const queueRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  thread_id: "thread-a",
  revision: 1,
  queued_count: 1,
  wake_generation: 0,
  wake_pending: 0,
  ...overrides,
})

const sqlTest = (
  run: (
    sql: ReturnType<typeof makeRecordingSql>,
  ) => Effect.Effect<
    void,
    TurnContract.RepositoryError | TurnContract.QueueFull | Schema.SchemaError,
    TurnRepository.Service
  >,
) => {
  const sql = makeRecordingSql()
  return run(sql).pipe(provideLayer(TurnRepository.layer.pipe(Layer.provide(sql.layer))))
}

it.effect("sql turns create, get, list, and decode cursor variants", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows()
      sql.rows(row())
      sql.rows(row({ last_cursor: "cursor-a" }))
      sql.rows()
      sql.rows(row(), row({ id: "turn-b", last_cursor: "cursor-b", created_at: 2, updated_at: 2 }))
      const repository = yield* TurnRepository.Service
      const created = yield* create(repository, {
        id: Turn.TurnId.make("turn-a"),
        threadId: Thread.ThreadId.make("thread-a"),
        prompt: "hello",
        now: 1,
      })
      const found = yield* repository.get(Turn.TurnId.make("turn-a"))
      const missing = yield* repository.get(Turn.TurnId.make("missing"))
      const listed = yield* repository.list(Thread.ThreadId.make("thread-a"))
      expect(created.lastCursor).toBeUndefined()
      expect(found !== undefined && Turn.isAgentExecution(found) ? found.lastCursor : undefined).toBe("cursor-a")
      expect(missing).toBeUndefined()
      expect(listed.filter(Turn.isAgentExecution).map((turn) => turn.lastCursor)).toEqual([undefined, "cursor-b"])
      const parameters = sql.statements[0]?.parameters ?? []
      expect(parameters.slice(0, 4)).toEqual(["turn-a", "thread-a", "hello", null])
      const executionRoute = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(String(parameters[4]))
      expect(executionRoute).toEqual(Turn.testExecutionRoute())
      expect(parameters.slice(5)).toEqual([null, '{"_tag":"Human"}', '{"_tag":"Original"}', "thread-a", 1, 1])
      expect(sql.statements.at(-1)).toEqual({
        sql: "SELECT * FROM rika_turns WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
        parameters: ["thread-a"],
      })
    }),
  ),
)

it.effect("sql turns encode and decode structured attachments", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      const promptParts: ReadonlyArray<Turn.PromptPart> = [
        { type: "text", text: "inspect " },
        { type: "image", mediaType: "image/png", data: "cG5n", filename: "shot.png" },
      ]
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Turn.PromptPart)))(promptParts)
      sql.rows()
      sql.rows(row({ prompt: "inspect [Image 1]", prompt_parts_json: encoded }))
      const repository = yield* TurnRepository.Service
      const created = yield* create(repository, {
        id: Turn.TurnId.make("turn-a"),
        threadId: Thread.ThreadId.make("thread-a"),
        prompt: "inspect [Image 1]",
        promptParts,
        now: 1,
      })
      expect(created.promptParts).toEqual(promptParts)
      expect(sql.statements[0]?.parameters[3]).toBe(encoded)
    }),
  ),
)

it.effect("sql status updates bind cursor and null cursor", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ status: "accepted" }))
      sql.rows(row({ status: "running", last_cursor: "cursor-a", updated_at: 2 }))
      sql.rows(row({ status: "running" }))
      sql.rows(row({ status: "completed", updated_at: 3 }))
      const repository = yield* TurnRepository.Service
      yield* repository.setStatus(Turn.TurnId.make("turn-a"), "running", "cursor-a", 2)
      yield* repository.setStatus(Turn.TurnId.make("turn-a"), "completed", undefined, 3)
      expect(sql.statements[0]?.parameters).toEqual(["turn-a"])
      expect(sql.statements[1]?.parameters).toEqual(["running", "cursor-a", 2, "turn-a"])
      expect(sql.statements[3]?.parameters).toEqual(["completed", null, 3, "turn-a"])
    }),
  ),
)

it.effect("sql setStatus refuses to move a queued turn out of the queue", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ status: "queued" }))
      const repository = yield* TurnRepository.Service
      expect(
        (yield* Effect.result(repository.setStatus(Turn.TurnId.make("turn-a"), "completed", undefined, 5)))._tag,
      ).toBe("Failure")
      expect(sql.statements.map((statement) => statement.sql)).toEqual([
        "SELECT * FROM rika_turns WHERE id = ? AND turn_kind = 'AgentExecution'",
      ])
    }),
  ),
)

it.effect("sql setStatus refuses to move a turn into queued", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      const repository = yield* TurnRepository.Service
      expect(
        (yield* Effect.result(repository.setStatus(Turn.TurnId.make("turn-a"), "queued", undefined, 5)))._tag,
      ).toBe("Failure")
      expect(sql.statements).toEqual([])
    }),
  ),
)

it.effect("sql pages turns backward and returns chronological results", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(
        row({ id: "turn-4", created_at: 4, updated_at: 4 }),
        row({ id: "turn-3", created_at: 3, updated_at: 3 }),
        row({ id: "turn-2", created_at: 2, updated_at: 2 }),
      )
      sql.rows(row({ id: "turn-1", created_at: 1, updated_at: 1 }))
      const repository = yield* TurnRepository.Service
      const newest = yield* repository.page(Thread.ThreadId.make("thread-a"), { limit: 2 })
      const older = yield* repository.page(Thread.ThreadId.make("thread-a"), {
        before: newest.oldestCursor,
        limit: 2,
      })
      expect(newest.turns.map((turn) => turn.id)).toEqual([Turn.TurnId.make("turn-3"), Turn.TurnId.make("turn-4")])
      expect(newest.hasOlder).toBe(true)
      expect(older.turns.map((turn) => turn.id)).toEqual([Turn.TurnId.make("turn-1")])
      expect(sql.statements).toEqual([
        {
          sql: "SELECT * FROM rika_turns WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          parameters: ["thread-a", 3],
        },
        {
          sql: "SELECT * FROM rika_turns WHERE thread_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
          parameters: ["thread-a", 3, 3, "turn-3", 3],
        },
      ])
    }),
  ),
)

it.effect("sql writes report missing rows after create and update", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows()
      sql.rows()
      sql.rows()
      sql.rows()
      const repository = yield* TurnRepository.Service
      const missingCreate = yield* Effect.result(
        create(repository, {
          id: Turn.TurnId.make("turn-a"),
          threadId: Thread.ThreadId.make("thread-a"),
          prompt: "hello",
          now: 1,
        }),
      )
      const missingUpdate = yield* Effect.result(
        repository.setStatus(Turn.TurnId.make("turn-a"), "failed", undefined, 2),
      )
      expect(missingCreate._tag === "Failure" && missingCreate.failure._tag).toBe("TurnRepositoryError")
      expect(missingUpdate._tag === "Failure" && missingUpdate.failure._tag).toBe("TurnRepositoryError")
    }),
  ),
)

it.effect("sql malformed rows, statuses, and failures map to repository errors", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ prompt: 1 }))
      sql.rows(row({ status: "unknown" }))
      sql.error("database unavailable")
      const repository = yield* TurnRepository.Service
      const malformed = yield* Effect.result(repository.get(Turn.TurnId.make("turn-a")))
      const status = yield* Effect.result(repository.get(Turn.TurnId.make("turn-a")))
      const failed = yield* Effect.result(repository.list(Thread.ThreadId.make("thread-a")))
      expect(malformed._tag === "Failure" && malformed.failure._tag).toBe("TurnRepositoryError")
      expect(status._tag === "Failure" && status.failure._tag).toBe("TurnRepositoryError")
      expect(failed._tag === "Failure" && failed.failure._tag).toBe("TurnRepositoryError")
    }),
  ),
)

it.effect("sql finds active turns and lists queued turns", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ status: "running" }))
      sql.rows()
      sql.rows(queueRow({ revision: 2, queued_count: 2 }))
      sql.rows(row({ status: "queued" }), row({ id: "turn-b", status: "queued" }))
      const repository = yield* TurnRepository.Service
      expect((yield* repository.findActive(Thread.ThreadId.make("thread-a")))?.status).toBe("running")
      expect(yield* repository.findActive(Thread.ThreadId.make("thread-empty"))).toBeUndefined()
      expect((yield* repository.readQueue(Thread.ThreadId.make("thread-a"))).turns.map((turn) => turn.id)).toEqual([
        Turn.TurnId.make("turn-a"),
        Turn.TurnId.make("turn-b"),
      ])
    }),
  ),
)

it.effect("sql claims queued turns and reports empty, malformed, and failed queries", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows({ ...row({ status: "queued" }), queue_claim_token: "TOKEN" })
      sql.rows()
      sql.rows(row({ status: "invalid" }))
      sql.error("claim unavailable")
      sql.rows(row({ prompt: 1 }))
      sql.error("active unavailable")
      sql.error("queue unavailable")
      const repository = yield* TurnRepository.Service
      const threadId = Thread.ThreadId.make("thread-a")
      expect((yield* repository.claimNextQueued(threadId, 2))?.turn.status).toBe("queued")
      expect(yield* repository.claimNextQueued(threadId, 3)).toBeUndefined()
      const malformedClaim = yield* Effect.result(repository.claimNextQueued(threadId, 4))
      const failedClaim = yield* Effect.result(repository.claimNextQueued(threadId, 5))
      const malformedActive = yield* Effect.result(repository.findActive(threadId))
      const failedActive = yield* Effect.result(repository.findActive(threadId))
      const failedQueue = yield* Effect.result(repository.readQueue(threadId))
      expect(malformedClaim._tag).toBe("Failure")
      expect(failedClaim._tag).toBe("Failure")
      expect(malformedActive._tag).toBe("Failure")
      expect(failedActive._tag).toBe("Failure")
      expect(failedQueue._tag).toBe("Failure")
      expect(sql.statements[0]?.parameters).toEqual(["thread-a", "thread-a", "thread-a"])
    }),
  ),
)

it.effect("sql edits and dequeues only queued turns", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ status: "queued", prompt: "after", updated_at: 3 }))
      sql.rows(queueRow())
      sql.rows()
      sql.rows(row({ status: "queued" }))
      sql.rows(queueRow({ revision: 2, queued_count: 0 }))
      sql.rows()
      const repository = yield* TurnRepository.Service
      expect(yield* repository.editQueued(Turn.TurnId.make("turn-a"), "after", 3)).toMatchObject({
        prompt: "after",
        updatedAt: 3,
      })
      expect((yield* Effect.result(repository.editQueued(Turn.TurnId.make("active"), "invalid", 4)))._tag).toBe(
        "Failure",
      )
      yield* repository.dequeue(Turn.TurnId.make("turn-a"))
      expect((yield* Effect.result(repository.dequeue(Turn.TurnId.make("active"))))._tag).toBe("Failure")
      expect(sql.statements).toEqual([
        {
          sql: "UPDATE rika_turns SET prompt = ?, prompt_parts_json = NULL, updated_at = ?, queue_claim_token = NULL WHERE id = ? AND turn_kind = 'AgentExecution' AND status = 'queued' RETURNING *",
          parameters: ["after", 3, "turn-a"],
        },
        {
          sql: "UPDATE rika_thread_queue_state SET revision = revision + 1 WHERE thread_id = ? RETURNING *",
          parameters: ["thread-a"],
        },
        {
          sql: "UPDATE rika_turns SET prompt = ?, prompt_parts_json = NULL, updated_at = ?, queue_claim_token = NULL WHERE id = ? AND turn_kind = 'AgentExecution' AND status = 'queued' RETURNING *",
          parameters: ["invalid", 4, "active"],
        },
        {
          sql: "DELETE FROM rika_turns WHERE id = ? AND turn_kind = 'AgentExecution' AND status = 'queued' RETURNING *",
          parameters: ["turn-a"],
        },
        {
          sql: "UPDATE rika_thread_queue_state SET revision = revision + 1, queued_count = MAX(queued_count - 1, 0) WHERE thread_id = ? RETURNING *",
          parameters: ["thread-a"],
        },
        {
          sql: "DELETE FROM rika_turns WHERE id = ? AND turn_kind = 'AgentExecution' AND status = 'queued' RETURNING *",
          parameters: ["active"],
        },
      ])
    }),
  ),
)

it.effect("sql lists nonterminal turns and mutates extension pins", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      const pin = {
        generation: "generation-a",
        sourceDigest: "source-a",
        configFingerprint: "config-a",
        toolSchemaDigest: "tools-a",
        mcpFingerprint: "mcp-a",
        resolvedContextDigest: "context-a",
      }
      sql.rows(row(), row({ id: "turn-b", status: "waiting" }))
      const encodedPin = yield* Schema.encodeEffect(Schema.fromJsonString(Turn.ExecutionExtensionPin))(pin)
      sql.rows(row({ extension_pin_json: encodedPin }))
      sql.rows()
      sql.error("list failed")
      sql.error("pin failed")
      const repository = yield* TurnRepository.Service
      expect((yield* repository.listNonterminal).map((turn) => turn.id)).toEqual([
        Turn.TurnId.make("turn-a"),
        Turn.TurnId.make("turn-b"),
      ])
      expect((yield* repository.setExtensionPin(Turn.TurnId.make("turn-a"), pin)).extensionPin).toEqual(pin)
      expect((yield* Effect.result(repository.setExtensionPin(Turn.TurnId.make("missing"), pin)))._tag).toBe("Failure")
      expect((yield* Effect.result(repository.listNonterminal))._tag).toBe("Failure")
      expect((yield* Effect.result(repository.setExtensionPin(Turn.TurnId.make("turn-a"), pin)))._tag).toBe("Failure")
    }),
  ),
)
