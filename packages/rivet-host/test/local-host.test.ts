import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Diagnostics } from "@rika/core"
import { Database, ThreadEventLog } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer } from "effect"
import { LocalHost } from "../src/index"

const threadId = Ids.ThreadId.make("thread_rivet_host_redaction")
const turnId = Ids.TurnId.make("turn_rivet_host_redaction")
const workspaceId = Ids.WorkspaceId.make("workspace_rivet_host_redaction")

describe("LocalHost", () => {
  test("resolves the installed Rivet engine binary beside packaged share assets", () => {
    expect(LocalHost.installedEngineBinaryPath("/opt/rika/bin/rika")).toBe("/opt/rika/share/rika/bin/rivet-engine")
    expect(
      LocalHost.engineBinaryPathFromEnv(
        { RIVET_ENGINE_BINARY: "/custom/rivet-engine" },
        "/opt/rika/bin/rika",
        () => true,
      ),
    ).toBe("/custom/rivet-engine")
    expect(LocalHost.engineBinaryPathFromEnv({}, "/opt/rika/bin/rika", () => true)).toBe(
      "/opt/rika/share/rika/bin/rivet-engine",
    )
    expect(LocalHost.engineBinaryPathFromEnv({}, "/opt/rika/bin/rika", () => false)).toBeUndefined()
  })

  test("keeps ready engine pids eligible for shutdown after they stop listening", () => {
    expect(
      [...LocalHost.enginePidsToTerminate(new Set([1]), new Set([1, 2]), new Set([3]))].toSorted(
        (left, right) => left - right,
      ),
    ).toEqual([2, 3])
  })

  test("selects only Rivet engine pids listening on the configured port", async () => {
    const pids = await LocalHost.rivetEnginePidsForPort(6420, async (listing) => {
      if (listing.command === "ps") {
        return [
          "101 /opt/rika/share/rika/bin/rivet-engine start --port 6420",
          "202 /opt/rika/share/rika/bin/rivet-engine start --port 6421",
          "303 /usr/bin/other start",
        ].join("\n")
      }
      if (listing.command === "lsof") return "101\n303\n"
      return undefined
    })

    expect(pids).toEqual(new Set([101]))
  })

  test("waits for Rivet metadata readiness", async () => {
    const seen: Array<string | undefined> = []
    let attempts = 0
    const server = createServer((request, response) => {
      seen.push(request.url)
      attempts += 1
      if (attempts === 1) {
        response.writeHead(503, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "starting" }))
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: true }))
    })
    const endpoint = await new Promise<string>((resolve, reject) => {
      server.on("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (typeof address !== "object" || address === null) {
          reject(new Error("missing server address"))
          return
        }
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })

    try {
      await Effect.runPromise(
        LocalHost.waitForMetadataEndpoint({
          endpoint,
          attempts: 3,
          delayMillis: 1,
        }),
      )

      expect(seen).toEqual(["/metadata", "/metadata"])
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    }
  })

  test("shuts down the raw registry when metadata readiness fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rika-rivet-host-readiness-"))
    const workspaceRoot = join(directory, "workspace")
    const dataDir = join(directory, ".rika")
    let starts = 0
    let shutdowns = 0
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "starting" }))
    })
    const endpoint = await new Promise<string>((resolve, reject) => {
      server.on("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (typeof address !== "object" || address === null) {
          reject(new Error("missing server address"))
          return
        }
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })
    const setupRegistry: NonNullable<LocalHost.Options["setupRegistry"]> = () => ({
      start: () => {
        starts += 1
      },
      shutdown: async () => {
        shutdowns += 1
      },
      parseConfig: () => ({ endpoint }),
    })

    try {
      await mkdir(workspaceRoot, { recursive: true })
      const exit = await Effect.runPromise(
        Effect.scoped(
          LocalHost.managedLayerFromEnv(
            {
              RIKA_API_KEY: "rivet-host-readiness-key",
              RIKA_DATA_DIR: dataDir,
              RIKA_RIVET_ENDPOINT: endpoint,
              RIKA_WORKSPACE_ROOT: workspaceRoot,
            },
            workspaceRoot,
            {
              setupRegistry,
              metadataReadiness: { attempts: 1, delayMillis: 1 },
            },
          ).pipe(Layer.build, Effect.exit),
        ),
      )

      expect(exit._tag).toBe("Failure")
      expect(starts).toBe(1)
      expect(shutdowns).toBe(1)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  test("continues startup when local process listing is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rika-rivet-host-process-listing-"))
    const workspaceRoot = join(directory, "workspace")
    const dataDir = join(directory, ".rika")
    let starts = 0
    let shutdowns = 0
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: true }))
    })
    const endpoint = await new Promise<string>((resolve, reject) => {
      server.on("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (typeof address !== "object" || address === null) {
          reject(new Error("missing server address"))
          return
        }
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })
    const setupRegistry: NonNullable<LocalHost.Options["setupRegistry"]> = () => ({
      start: () => {
        starts += 1
      },
      shutdown: async () => {
        shutdowns += 1
      },
      parseConfig: () => ({ endpoint }),
    })

    try {
      await mkdir(workspaceRoot, { recursive: true })
      await Effect.runPromise(
        Effect.scoped(
          LocalHost.managedLayerFromEnv(
            {
              RIKA_API_KEY: "rivet-host-process-listing-key",
              RIKA_DATA_DIR: dataDir,
              RIKA_RIVET_ENDPOINT: endpoint,
              RIKA_WORKSPACE_ROOT: workspaceRoot,
            },
            workspaceRoot,
            {
              setupRegistry,
              metadataReadiness: { attempts: 1, delayMillis: 1 },
              processListingRunner: async () => undefined,
            },
          ).pipe(Layer.build, Effect.asVoid),
        ),
      )

      expect(starts).toBe(1)
      expect(shutdowns).toBe(1)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
      await rm(directory, { recursive: true, force: true })
    }
  })

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
