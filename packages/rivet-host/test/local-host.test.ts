import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Diagnostics } from "@rika/core"
import { Database, ThreadEventLog } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect } from "effect"
import { LocalHost } from "../src/index"

const threadId = Ids.ThreadId.make("thread_rivet_host_redaction")
const turnId = Ids.TurnId.make("turn_rivet_host_redaction")
const workspaceId = Ids.WorkspaceId.make("workspace_rivet_host_redaction")

describe("LocalHost", () => {
  test("shares env-seeded secret redaction with event log and diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rika-rivet-host-redaction-"))
    const workspaceRoot = join(directory, "workspace")
    const dataDir = join(directory, ".rika")
    const logPath = join(directory, "session.ndjson")
    const secret = "rivet-host-secret-value"
    const redacted = "[REDACTED:FAKE_API_KEY]"

    try {
      await mkdir(workspaceRoot, { recursive: true })
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ThreadEventLog.append(threadCreated(1))
          yield* ThreadEventLog.append(messageAdded(2, `host ${secret}`))
          yield* Diagnostics.emit({
            level: "info",
            message: "rivet host secret",
            data: { value: secret },
          })
          return yield* Database.withDatabase((database) =>
            database.all<{ payload: string }>("select payload from thread_events order by sequence asc"),
          )
        }).pipe(
          Effect.provide(
            LocalHost.serviceLayerFromEnv(
              {
                FAKE_API_KEY: secret,
                RIKA_API_KEY: "rivet-host-provider-key",
                RIKA_DATA_DIR: dataDir,
                RIKA_LOG_FILE: logPath,
                RIKA_WORKSPACE_ROOT: workspaceRoot,
              },
              workspaceRoot,
            ),
          ),
        ),
      )
      const payloads = JSON.stringify(result)
      const diagnostics = await readFile(logPath, "utf8")

      expect(payloads).toContain(redacted)
      expect(diagnostics).toContain(redacted)
      expect(payloads).not.toContain(secret)
      expect(diagnostics).not.toContain(secret)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`rivet_host_redaction_event_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(1_950_000_000_000 + sequence),
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`rivet_host_redaction_event_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(1_950_000_000_000 + sequence),
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("rivet_host_redaction_message"),
      thread_id: threadId,
      turn_id: turnId,
      content,
      created_at: Common.TimestampMillis.make(1_950_000_000_000 + sequence),
    }),
  },
})
