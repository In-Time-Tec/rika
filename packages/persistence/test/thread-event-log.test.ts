import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SecretRedactor } from "@rika/core"
import { Event, Ids, Message } from "@rika/schema"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database, Migration, ThreadEventLog } from "../src/index"

const threadId = Ids.ThreadId.make("thread_event_log_thread")
const workspaceId = Ids.WorkspaceId.make("workspace_1")
const layer = Layer.mergeAll(Database.memoryLayer, Migration.layer, ThreadEventLog.layer)

describe("ThreadEventLog", () => {
  test("appends and reads events in sequence order", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* ThreadEventLog.append(threadCreated(1))
        const message = yield* ThreadEventLog.append(messageAdded(2, "hello"))
        const replay = yield* ThreadEventLog.readThread({ thread_id: threadId })
        return { created, message, replay }
      }).pipe(Effect.provide(layer)),
    )

    expect(events.replay).toEqual([events.created, events.message])
  })

  test("appendMany appends contiguous events in one call", async () => {
    const replay = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.appendMany([threadCreated(1), messageAdded(2, "hello")])
        return yield* ThreadEventLog.readThread({ thread_id: threadId })
      }).pipe(Effect.provide(layer)),
    )

    expect(replay.map((event) => event.sequence)).toEqual([1, 2])
    expect(replay.map((event) => event.type)).toEqual(["thread.created", "message.added"])
  })

  test("appendMany rolls back the whole batch when one event fails validation", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const error = yield* ThreadEventLog.appendMany([threadCreated(1), messageAdded(3, "gap")]).pipe(Effect.flip)
        const replay = yield* ThreadEventLog.readThread({ thread_id: threadId })
        return { error, replay }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.error).toBeInstanceOf(ThreadEventLog.ThreadEventLogError)
    expect(result.error.operation).toBe("appendMany")
    expect(result.replay).toEqual([])
  })

  test("treats appending the same event as idempotent", async () => {
    const count = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const event = threadCreated(1)
        yield* ThreadEventLog.append(event)
        yield* ThreadEventLog.append(event)
        return yield* ThreadEventLog.readThread({ thread_id: threadId })
      }).pipe(Effect.provide(layer)),
    )

    expect(count).toHaveLength(1)
  })

  test("redacts secrets before storage and raw reappend idempotency checks", async () => {
    const secret = "event-log-secret-value"
    const redacted = "[REDACTED:FAKE_API_KEY]"
    const event = messageAdded(2, `token ${secret}`)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.append(threadCreated(1))
        const inserted = yield* ThreadEventLog.appendIfAbsent(event)
        const skipped = yield* ThreadEventLog.appendIfAbsent(event)
        const replay = yield* ThreadEventLog.readThread({ thread_id: threadId })
        const payloads = yield* Database.withDatabase((database) =>
          database.all<{ payload: string }>(sql`select payload from thread_events order by sequence asc`),
        )
        return { inserted, skipped, replay, payloads }
      }).pipe(Effect.provide(redactionLayer([{ label: "FAKE_API_KEY", value: secret }]))),
    )

    expect(result.inserted.status).toBe("inserted")
    expect(result.skipped.status).toBe("skipped")
    expect(result.inserted.event).toEqual(messageAdded(2, `token ${redacted}`))
    expect(result.skipped.event).toEqual(messageAdded(2, `token ${redacted}`))
    expect(
      Message.displayText(result.replay[1]?.type === "message.added" ? result.replay[1].data.message : { content: [] }),
    ).toBe(`token ${redacted}`)
    expect(JSON.stringify(result.payloads)).toContain(redacted)
    expect(JSON.stringify(result.payloads)).not.toContain(secret)
  })

  test("appendIfAbsent skips the exact existing thread sequence", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const first = threadCreated(1)
        const inserted = yield* ThreadEventLog.appendIfAbsent(first)
        const skipped = yield* ThreadEventLog.appendIfAbsent(first)
        const replay = yield* ThreadEventLog.readThread({ thread_id: threadId })
        return { inserted, skipped, replay }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.inserted.status).toBe("inserted")
    expect(result.skipped.status).toBe("skipped")
    expect(result.replay).toEqual([threadCreated(1)])
  })

  test("appendIfAbsent rejects a different payload at the same thread sequence", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.appendIfAbsent(threadCreated(1))
        return yield* ThreadEventLog.appendIfAbsent(messageAdded(1, "divergent remote payload")).pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )

    expect(error).toBeInstanceOf(ThreadEventLog.ThreadEventLogError)
    expect(error.operation).toBe("appendIfAbsent")
  })

  test("redacts all secret-bearing event fields while preserving references and schema round-trip", async () => {
    const secret = "all-event-secret-value"
    const redacted = "[REDACTED:FAKE_API_KEY]"
    const events = allEventFixtures(secret)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const appended = yield* ThreadEventLog.appendMany(events)
        const replay = yield* ThreadEventLog.readThread({ thread_id: threadId })
        const payloads = yield* Database.withDatabase((database) =>
          database.all<{ payload: string }>(sql`select payload from thread_events order by sequence asc`),
        )
        return { appended, replay, payloads }
      }).pipe(Effect.provide(redactionLayer([{ label: "FAKE_API_KEY", value: secret }]))),
    )

    expect(result.appended.map((event) => Event.references(event))).toEqual(
      events.map((event) => Event.references(event)),
    )
    expect(result.replay.map((event) => Event.references(event))).toEqual(
      events.map((event) => Event.references(event)),
    )
    for (const event of result.replay) {
      expect(ThreadEventLog.decodePayload(ThreadEventLog.encodePayload(event))).toEqual(event)
    }
    expect(JSON.stringify(result.replay)).toContain(redacted)
    expect(JSON.stringify(result.replay)).not.toContain(secret)
    expect(JSON.stringify(result.payloads)).toContain(redacted)
    expect(JSON.stringify(result.payloads)).not.toContain(secret)
  })

  test("appendIfAbsent rejects a duplicate event id at a different thread sequence", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const first = threadCreated(1)
        yield* ThreadEventLog.appendIfAbsent(first)
        return yield* ThreadEventLog.appendIfAbsent({
          ...first,
          thread_id: Ids.ThreadId.make("thread_event_log_other"),
        }).pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )

    expect(error).toBeInstanceOf(ThreadEventLog.ThreadEventLogError)
    expect(error.operation).toBe("appendIfAbsent")
  })

  test("appendIfAbsent rejects gaps", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* ThreadEventLog.appendIfAbsent(messageAdded(2, "gap")).pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )

    expect(error).toBeInstanceOf(ThreadEventLog.ThreadEventLogError)
    expect(error.operation).toBe("appendIfAbsent")
  })

  test("reads complete history by default and only caps when a limit is provided", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.append(threadCreated(1))
        yield* ThreadEventLog.append(messageAdded(2, "first"))
        yield* ThreadEventLog.append(messageAdded(3, "second"))
        const complete = yield* ThreadEventLog.readThread({ thread_id: threadId })
        const capped = yield* ThreadEventLog.readThread({ thread_id: threadId, limit: 2 })
        return { complete, capped }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.complete.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(result.capped.map((event) => event.sequence)).toEqual([1, 2])
  })

  test("reads the latest thread tail in ascending sequence order", async () => {
    const tail = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.append(threadCreated(1))
        yield* ThreadEventLog.append(messageAdded(2, "first"))
        yield* ThreadEventLog.append(messageAdded(3, "second"))
        yield* ThreadEventLog.append(messageAdded(4, "third"))
        return yield* ThreadEventLog.readThreadTail({ thread_id: threadId, limit: 2 })
      }).pipe(Effect.provide(layer)),
    )

    expect(tail.map((event) => event.sequence)).toEqual([3, 4])
  })

  test("rejects stale sequence attempts explicitly", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.append(threadCreated(1))
        return yield* ThreadEventLog.append(messageAdded(1, "stale")).pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )

    expect(error).toBeInstanceOf(ThreadEventLog.ThreadEventLogError)
    expect(error.operation).toBe("append")
  })

  test("reconstructs a thread after reopening a file-backed database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rika-event-log-"))
    const path = join(directory, "rika.sqlite")

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* ThreadEventLog.append(threadCreated(1))
          yield* ThreadEventLog.append(messageAdded(2, "persisted"))
        }).pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path), Migration.layer, ThreadEventLog.layer))),
      )

      const replay = await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          return yield* ThreadEventLog.readThread({ thread_id: threadId })
        }).pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path), Migration.layer, ThreadEventLog.layer))),
      )

      expect(replay.map((event) => event.type)).toEqual(["thread.created", "message.added"])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`event_created_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`event_message_${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn_1"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(`message_${sequence}`),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      content,
      created_at: sequence,
    }),
  },
})

const redactionLayer = (entries: ReadonlyArray<SecretRedactor.Entry>) => {
  const redactorLayer = SecretRedactor.layerFromEntries(entries)
  return Layer.mergeAll(
    Database.memoryLayer,
    Migration.layer,
    redactorLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
  )
}

const allEventFixtures = (secret: string): ReadonlyArray<Event.Event> => {
  const toolCallId = Ids.ToolCallId.make("tool_call_redaction")
  const artifactId = Ids.ArtifactId.make("artifact_redaction")
  return [
    { ...threadCreated(1), data: { workspace_id: workspaceId, title_text: `title ${secret}` } },
    {
      id: Ids.EventId.make("event_redaction_turn_started"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 2,
      version: 1,
      created_at: 2,
      type: "turn.started",
      data: { tool_access: "full" },
    },
    messageAdded(3, `message ${secret}`),
    {
      id: Ids.EventId.make("event_redaction_model_stream"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 4,
      version: 1,
      created_at: 4,
      type: "model.stream.chunk",
      data: { text: `stream ${secret}`, provider: "fake", model: "fake" },
    },
    {
      id: Ids.EventId.make("event_redaction_reasoning"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 5,
      version: 1,
      created_at: 5,
      type: "model.reasoning.delta",
      data: { text: `reasoning ${secret}`, provider: "fake", model: "fake" },
    },
    {
      id: Ids.EventId.make("event_redaction_context"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 6,
      version: 1,
      created_at: 6,
      type: "context.resolved",
      data: {
        entries: [
          {
            kind: "file",
            source: "test",
            reason: "redaction",
            trusted: false,
            content: `context ${secret}`,
            thread_reference: `reference ${secret}`,
          },
        ],
        rendered: `rendered ${secret}`,
        total_chars: 1,
        metadata: { nested: `metadata ${secret}` },
      },
    },
    {
      id: Ids.EventId.make("event_redaction_compacted"),
      thread_id: threadId,
      sequence: 7,
      version: 1,
      created_at: 7,
      type: "context.compacted",
      data: {
        summary: `summary ${secret}`,
        tail_start_sequence: 6,
        trigger: "manual",
        tokens_before: 10,
        model: "fake",
      },
    },
    {
      id: Ids.EventId.make("event_redaction_pruned"),
      thread_id: threadId,
      sequence: 8,
      version: 1,
      created_at: 8,
      type: "context.pruned",
      data: { tool_call_ids: [toolCallId], estimated_tokens_freed: 10 },
    },
    {
      id: Ids.EventId.make("event_redaction_skill"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 9,
      version: 1,
      created_at: 9,
      type: "skill.loaded",
      data: { name: "test", description: "safe", source: "test", skill_file: "SKILL.md", resource_paths: [] },
    },
    {
      id: Ids.EventId.make("event_redaction_subagent"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 10,
      version: 1,
      created_at: 10,
      type: "subagent.completed",
      data: {
        subagent_id: "subagent",
        name: "reviewer",
        status: "completed",
        summary: `summary ${secret}`,
        evidence: [`evidence ${secret}`],
        tool_access: "read-only",
        tool_names: [],
        started_at: 9,
        completed_at: 10,
      },
    },
    {
      id: Ids.EventId.make("event_redaction_tool_input_started"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 11,
      version: 1,
      created_at: 11,
      type: "tool.call.input.started",
      data: { id: toolCallId, name: "shell_command" },
    },
    {
      id: Ids.EventId.make("event_redaction_tool_input_delta"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 12,
      version: 1,
      created_at: 12,
      type: "tool.call.input.delta",
      data: { id: toolCallId, text: `delta ${secret}` },
    },
    {
      id: Ids.EventId.make("event_redaction_tool_input_ended"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 13,
      version: 1,
      created_at: 13,
      type: "tool.call.input.ended",
      data: { id: toolCallId, name: "shell_command", input_text: `input ${secret}` },
    },
    {
      id: Ids.EventId.make("event_redaction_tool_requested"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 14,
      version: 1,
      created_at: 14,
      type: "tool.call.requested",
      data: { call: { id: toolCallId, name: "shell_command", input: { command: `echo ${secret}` } } },
    },
    {
      id: Ids.EventId.make("event_redaction_tool_completed"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 15,
      version: 1,
      created_at: 15,
      type: "tool.call.completed",
      data: {
        result: {
          id: toolCallId,
          name: "shell_command",
          status: "error",
          output: { stdout: `success ${secret}` },
          error: { kind: "tool", message: `failed ${secret}`, details: { stderr: `stderr ${secret}` } },
        },
      },
    },
    {
      id: Ids.EventId.make("event_redaction_artifact"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 16,
      version: 1,
      created_at: 16,
      type: "artifact.created",
      data: {
        artifact: {
          id: artifactId,
          thread_id: threadId,
          turn_id: Ids.TurnId.make("turn_1"),
          kind: "other",
          title: `artifact ${secret}`,
          content: { body: `artifact ${secret}` },
          created_at: 16,
        },
      },
    },
    {
      id: Ids.EventId.make("event_redaction_completed"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 17,
      version: 1,
      created_at: 17,
      type: "turn.completed",
      data: { provider: "fake", model: "fake", usage: { total_tokens: 1 } },
    },
    {
      id: Ids.EventId.make("event_redaction_failed"),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      sequence: 18,
      version: 1,
      created_at: 18,
      type: "turn.failed",
      data: {
        error: { kind: "unknown", message: `turn failed ${secret}`, details: { output: `details ${secret}` } },
      },
    },
    {
      id: Ids.EventId.make("event_redaction_archived"),
      thread_id: threadId,
      sequence: 19,
      version: 1,
      created_at: 19,
      type: "thread.archived",
      data: {},
    },
    {
      id: Ids.EventId.make("event_redaction_unarchived"),
      thread_id: threadId,
      sequence: 20,
      version: 1,
      created_at: 20,
      type: "thread.unarchived",
      data: {},
    },
  ]
}
