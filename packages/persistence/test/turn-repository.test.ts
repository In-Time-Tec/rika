import * as Thread from "../src/thread-schema"
import * as TurnRepository from "../src/turn-repository"
import * as Turn from "../src/turn-schema"
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

it.effect("memory turns preserve structured image prompt parts", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* repository.createForSubmission({
      id: Turn.TurnId.make("image-turn"),
      threadId: Thread.ThreadId.make("image-thread"),
      prompt: "inspect [Image 1]",
      promptParts: [
        { type: "text", text: "inspect " },
        { type: "image", mediaType: "image/png", data: "cG5n", filename: "shot.png" },
      ],
      now: 1,
    })
    expect((yield* repository.get(created.id))?.promptParts).toEqual(created.promptParts)
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns preserve immutable execution extension pins", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* repository.createForSubmission({
      id: Turn.TurnId.make("turn-pin"),
      threadId: Thread.ThreadId.make("thread-pin"),
      prompt: "pin",
      now: 1,
    })
    const pin = {
      generation: "generation-a",
      sourceDigest: "source-a",
      configFingerprint: "config-a",
      toolSchemaDigest: "tools-a",
      mcpFingerprint: "mcp-a",
      resolvedContextDigest: "context-a",
    }
    expect((yield* repository.setExtensionPin(created.id, pin)).extensionPin).toEqual(pin)
    expect(
      (yield* Effect.result(repository.setExtensionPin(created.id, { ...pin, generation: "generation-b" })))._tag,
    ).toBe("Failure")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns preserve immutable execution route pins", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* repository.createForSubmission({
      id: Turn.TurnId.make("turn-route-pin"),
      threadId: Thread.ThreadId.make("thread-route-pin"),
      prompt: "pin route",
      executionRoute: Turn.testExecutionRoute("low"),
      now: 1,
    })
    expect(created.executionRoute?.mode).toBe("low")
    expect(
      (yield* Effect.result(repository.setExecutionRoute(created.id, Turn.testExecutionRoute("ultra"))))._tag,
    ).toBe("Failure")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns preserve review fan-out route ownership while nonterminal", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* repository.createForSubmission({
      id: Turn.TurnId.make("review-owner"),
      threadId: Thread.ThreadId.make("review-thread"),
      prompt: "Review workspace changes",
      executionRoute: Turn.testExecutionRoute("medium"),
      reviewFanOutId: "review:review-owner",
      now: 1,
    })
    yield* repository.setStatus(created.id, "running", undefined, 2)
    expect(yield* repository.get(created.id)).toMatchObject({
      status: "running",
      reviewFanOutId: "review:review-owner",
    })
    expect((yield* repository.listNonterminal).map((turn) => turn.id)).toContain(created.id)
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns preserve deterministic identity and status", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* repository.createForSubmission({
      id: Turn.TurnId.make("turn-a"),
      threadId: Thread.ThreadId.make("thread-a"),
      prompt: "hello",
      now: 1,
    })
    yield* repository.createForSubmission({
      id: Turn.TurnId.make("turn-b"),
      threadId: Thread.ThreadId.make("thread-a"),
      prompt: "next",
      now: 1,
    })
    const completed = yield* repository.setStatus(created.id, "completed", "cursor-a", 2)
    const failed = yield* repository.setStatus(created.id, "failed", undefined, 3)
    const listed = yield* repository.list(created.threadId)
    expect(created.status).toBe("accepted")
    expect(completed.lastCursor).toBe("cursor-a")
    expect(failed.lastCursor).toBeUndefined()
    expect(listed.map((turn) => turn.id)).toEqual([Turn.TurnId.make("turn-a"), Turn.TurnId.make("turn-b")])
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory terminal status does not regress to nonterminal", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const created = yield* repository.createForSubmission({
      id: Turn.TurnId.make("terminal"),
      threadId: Thread.ThreadId.make("terminal-thread"),
      prompt: "done",
      now: 1,
    })
    yield* repository.setStatus(created.id, "completed", "terminal-cursor", 2)
    const unchanged = yield* repository.setStatus(created.id, "running", "stale-cursor", 3)
    expect(unchanged).toMatchObject({ status: "completed", lastCursor: "terminal-cursor", updatedAt: 2 })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory turns reject duplicates and missing updates", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const input = {
      id: Turn.TurnId.make("turn-a"),
      threadId: Thread.ThreadId.make("thread-a"),
      prompt: "hello",
      now: 1,
    }
    yield* repository.createForSubmission(input)
    const duplicate = yield* Effect.result(repository.createForSubmission(input))
    const missing = yield* Effect.result(repository.setStatus(Turn.TurnId.make("missing"), "failed", undefined, 2))
    expect(duplicate._tag).toBe("Failure")
    expect(missing._tag).toBe("Failure")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory submissions queue while active and promote one in FIFO order", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-a")
    const first = yield* repository.createForSubmission({
      id: Turn.TurnId.make("turn-active"),
      threadId,
      prompt: "active",
      now: 1,
    })
    const third = yield* repository.createForSubmission({
      id: Turn.TurnId.make("turn-b"),
      threadId,
      prompt: "third",
      now: 2,
    })
    const second = yield* repository.createForSubmission({
      id: Turn.TurnId.make("turn-a"),
      threadId,
      prompt: "second",
      now: 2,
    })
    expect(first.status).toBe("accepted")
    expect((yield* repository.findActive(threadId))?.id).toBe(first.id)
    expect((yield* repository.listQueued(threadId)).map((turn) => turn.id)).toEqual([third.id, second.id])
    expect(yield* repository.claimNextQueued(threadId, 3)).toBeUndefined()
    yield* repository.setStatus(first.id, "completed", undefined, 3)
    expect((yield* repository.claimNextQueued(threadId, 4))?.id).toBe(third.id)
    expect(yield* repository.claimNextQueued(threadId, 4)).toBeUndefined()
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory claim is empty when no turn is queued", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-empty")
    expect(yield* repository.findActive(threadId)).toBeUndefined()
    expect(yield* repository.listQueued(threadId)).toEqual([])
    expect(yield* repository.claimNextQueued(threadId, 2)).toBeUndefined()
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory lists nonterminal turns and rejects a missing extension pin", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-a")
    expect((yield* repository.listNonterminal).map((turn) => turn.id)).toEqual([
      Turn.TurnId.make("b"),
      Turn.TurnId.make("a"),
    ])
    expect((yield* repository.findActive(threadId))?.id).toBe(Turn.TurnId.make("b"))
    expect(
      (yield* Effect.result(
        repository.setExtensionPin(Turn.TurnId.make("missing"), {
          generation: "g",
          sourceDigest: "s",
          configFingerprint: "c",
          toolSchemaDigest: "t",
          mcpFingerprint: "m",
          resolvedContextDigest: "r",
        }),
      ))._tag,
    ).toBe("Failure")
  }).pipe(
    provideLayer(
      TurnRepository.memoryLayer([
        {
          id: Turn.TurnId.make("b"),
          threadId: Thread.ThreadId.make("thread-a"),
          prompt: "b",
          status: "waiting",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("a"),
          threadId: Thread.ThreadId.make("thread-a"),
          prompt: "a",
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    ),
  ),
)

it.effect("memory edits and dequeues only queued turns", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-a")
    const active = yield* repository.createForSubmission({
      id: Turn.TurnId.make("active"),
      threadId,
      prompt: "active",
      now: 1,
    })
    const queued = yield* repository.createForSubmission({
      id: Turn.TurnId.make("queued"),
      threadId,
      prompt: "before",
      now: 2,
    })
    expect(yield* repository.editQueued(queued.id, "after", 3)).toMatchObject({ prompt: "after", updatedAt: 3 })
    expect((yield* Effect.result(repository.editQueued(active.id, "invalid", 4)))._tag).toBe("Failure")
    expect((yield* Effect.result(repository.dequeue(active.id)))._tag).toBe("Failure")
    yield* repository.dequeue(queued.id)
    expect(yield* repository.get(queued.id)).toBeUndefined()
    expect((yield* Effect.result(repository.dequeue(queued.id)))._tag).toBe("Failure")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "turn-a",
  thread_id: "thread-a",
  prompt: "hello",
  status: "accepted",
  last_cursor: null,
  created_at: 1,
  updated_at: 1,
  ...overrides,
})

const sqlTest = (
  run: (
    sql: ReturnType<typeof makeRecordingSql>,
  ) => Effect.Effect<void, TurnRepository.RepositoryError | Schema.SchemaError, TurnRepository.Service>,
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
      const created = yield* repository.createForSubmission({
        id: Turn.TurnId.make("turn-a"),
        threadId: Thread.ThreadId.make("thread-a"),
        prompt: "hello",
        now: 1,
      })
      const found = yield* repository.get(Turn.TurnId.make("turn-a"))
      const missing = yield* repository.get(Turn.TurnId.make("missing"))
      const listed = yield* repository.list(Thread.ThreadId.make("thread-a"))
      expect(created.lastCursor).toBeUndefined()
      expect(found?.lastCursor).toBe("cursor-a")
      expect(missing).toBeUndefined()
      expect(listed.map((turn) => turn.lastCursor)).toEqual([undefined, "cursor-b"])
      expect(sql.statements[0]?.parameters).toEqual(["turn-a", "thread-a", "hello", null, null, null, "thread-a", 1, 1])
      expect(sql.statements.at(-1)).toEqual({
        sql: "SELECT * FROM rika_turns WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
        parameters: ["thread-a"],
      })
    }),
  ),
)

it.effect("sql status updates bind cursor and null cursor", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ status: "running", last_cursor: "cursor-a", updated_at: 2 }))
      sql.rows(row({ status: "completed", updated_at: 3 }))
      const repository = yield* TurnRepository.Service
      yield* repository.setStatus(Turn.TurnId.make("turn-a"), "running", "cursor-a", 2)
      yield* repository.setStatus(Turn.TurnId.make("turn-a"), "completed", undefined, 3)
      expect(sql.statements[0]?.parameters).toEqual(["running", "cursor-a", 2, "turn-a", "running"])
      expect(sql.statements[1]?.parameters).toEqual(["completed", null, 3, "turn-a", "completed"])
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
        repository.createForSubmission({
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
      sql.rows(row({ status: "queued" }), row({ id: "turn-b", status: "queued" }))
      const repository = yield* TurnRepository.Service
      expect((yield* repository.findActive(Thread.ThreadId.make("thread-a")))?.status).toBe("running")
      expect(yield* repository.findActive(Thread.ThreadId.make("thread-empty"))).toBeUndefined()
      expect((yield* repository.listQueued(Thread.ThreadId.make("thread-a"))).map((turn) => turn.id)).toEqual([
        Turn.TurnId.make("turn-a"),
        Turn.TurnId.make("turn-b"),
      ])
    }),
  ),
)

it.effect("sql claims queued turns and reports empty, malformed, and failed queries", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ status: "accepted", updated_at: 2 }))
      sql.rows()
      sql.rows(row({ status: "invalid" }))
      sql.error("claim unavailable")
      sql.rows(row({ prompt: 1 }))
      sql.error("active unavailable")
      sql.error("queue unavailable")
      const repository = yield* TurnRepository.Service
      const threadId = Thread.ThreadId.make("thread-a")
      expect((yield* repository.claimNextQueued(threadId, 2))?.status).toBe("accepted")
      expect(yield* repository.claimNextQueued(threadId, 3)).toBeUndefined()
      const malformedClaim = yield* Effect.result(repository.claimNextQueued(threadId, 4))
      const failedClaim = yield* Effect.result(repository.claimNextQueued(threadId, 5))
      const malformedActive = yield* Effect.result(repository.findActive(threadId))
      const failedActive = yield* Effect.result(repository.findActive(threadId))
      const failedQueue = yield* Effect.result(repository.listQueued(threadId))
      expect(malformedClaim._tag).toBe("Failure")
      expect(failedClaim._tag).toBe("Failure")
      expect(malformedActive._tag).toBe("Failure")
      expect(failedActive._tag).toBe("Failure")
      expect(failedQueue._tag).toBe("Failure")
      expect(sql.statements[0]?.parameters).toEqual([2, "thread-a", "thread-a"])
    }),
  ),
)

it.effect("sql edits and dequeues only queued turns", () =>
  sqlTest((sql) =>
    Effect.gen(function* () {
      sql.rows(row({ status: "queued", prompt: "after", updated_at: 3 }))
      sql.rows()
      sql.rows({ id: "turn-a" })
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
          sql: "UPDATE rika_turns SET prompt = ?, updated_at = ? WHERE id = ? AND status = 'queued' RETURNING *",
          parameters: ["after", 3, "turn-a"],
        },
        {
          sql: "UPDATE rika_turns SET prompt = ?, updated_at = ? WHERE id = ? AND status = 'queued' RETURNING *",
          parameters: ["invalid", 4, "active"],
        },
        { sql: "DELETE FROM rika_turns WHERE id = ? AND status = 'queued' RETURNING id", parameters: ["turn-a"] },
        { sql: "DELETE FROM rika_turns WHERE id = ? AND status = 'queued' RETURNING id", parameters: ["active"] },
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
