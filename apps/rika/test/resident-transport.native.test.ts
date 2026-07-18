import * as BunServices from "@effect/platform-bun/BunServices"
import { afterEach, describe, expect, test } from "vitest"
import { fileURLToPath } from "node:url"
import { Cause, Clock, Config, Data, Effect, Fiber, FileSystem, Layer, Queue, Ref, Schema, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { resolve } from "../src/resident-endpoint"

type Event = {
  type: string
  role?: string | undefined
  id?: string | undefined
  clientPid?: number | undefined
  hostPid?: number | undefined
  text?: string | undefined
  tag?: string | undefined
  error?: string | undefined
  callbacks?: number | undefined
  tags?: ReadonlyArray<string> | undefined
  outcome?: string | undefined
}

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{
  readonly operation: string
  readonly cause: unknown
}> {}

const provide = <A, E, R, ROut, E2, RIn>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* Effect.provide(effect, context)
    }),
  )

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(provide(effect, BunServices.layer))

const EventSchema = Schema.Struct({
  type: Schema.String,
  role: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  clientPid: Schema.optional(Schema.Finite),
  hostPid: Schema.optional(Schema.Finite),
  text: Schema.optional(Schema.String),
  tag: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  callbacks: Schema.optional(Schema.Finite),
  tags: Schema.optional(Schema.Array(Schema.String)),
  outcome: Schema.optional(Schema.String),
})

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(EventSchema))

const hostPids = new Set<number>()

afterEach(() =>
  Effect.runPromise(
    Effect.sync(() => {
      for (const pid of hostPids) {
        try {
          globalThis.process.kill(pid, "SIGKILL")
        } catch {}
      }
      hostPids.clear()
    }),
  ),
)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitUntil = <E, R>(condition: Effect.Effect<boolean, E, R>, timeout = 2_000) =>
  Effect.gen(function* () {
    const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    while (!(yield* condition)) {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      if (now - started >= timeout) return yield* Effect.die("condition timed out")
      yield* Effect.sleep("20 millis")
    }
  })

const makeRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
  return yield* fileSystem.makeTempDirectory({ directory: temporaryDirectory, prefix: "rika-resident-" })
})

const cleanRoot = (root: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.remove(root, { recursive: true, force: true })),
    Effect.mapError((cause) => new FixtureFailure({ operation: "clean fixture root", cause })),
  )

const readText = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(path))
const fileStat = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(path))
const fileExists = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.exists(path))

const legacyClose = (url: string) =>
  Effect.callback<{ readonly code: number; readonly reason: string }, FixtureFailure>((resume) => {
    const socket = new WebSocket(url)
    socket.addEventListener("close", (event) => resume(Effect.succeed({ code: event.code, reason: event.reason })))
    socket.addEventListener("error", (cause) =>
      resume(Effect.fail(new FixtureFailure({ operation: "connect legacy resident client", cause }))),
    )
    return Effect.sync(() => socket.close())
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(new FixtureFailure({ operation: "wait for legacy close", cause: "timed out" })),
    }),
  )

const startOldResident = Effect.fn("ResidentTransportTest.startOldResident")(function* (
  root: string,
  recordPid: boolean = true,
  mode: "legacy" | "schema-reject" = "legacy",
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const old = yield* spawner.spawn(
    ChildProcess.make("bun", ["test/fixtures/resident-old-host.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: {
        RIKA_TEST_RESIDENT_DATA_ROOT: root,
        RIKA_TEST_RESIDENT_RECORD_PID: recordPid ? "1" : "0",
        RIKA_TEST_RESIDENT_MODE: mode,
      },
      extendEnv: true,
    }),
  )
  yield* waitUntil(fileExists(`${root}/old-resident-ready`), 3_000)
  return old
})

interface ResidentClient {
  readonly pid: number
  readonly nextEffect: Effect.Effect<Event, FixtureFailure>
  readonly send: (command: string) => Effect.Effect<void, FixtureFailure>
  readonly closeEffect: Effect.Effect<void, FixtureFailure>
  readonly kill: Effect.Effect<void, FixtureFailure>
  readonly end: Effect.Effect<void>
  readonly awaitExit: Effect.Effect<void, FixtureFailure>
}

const start = Effect.fn("ResidentTransportTest.start")(function* (
  root: string,
  grace: number = 350,
  finalizerDelay: number = 0,
  delayedWork: boolean = false,
  outboundCapacity: number = 1_024,
  startupHold: number = 0,
  uninterruptibleOwner: boolean = false,
  ownerDrainMilliseconds?: number,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const input = yield* Queue.bounded<string, Cause.Done>(32)
  const events = yield* Queue.bounded<Event, FixtureFailure>(2_048)
  const errors = yield* Ref.make<ReadonlyArray<string>>([])
  const client = yield* spawner
    .spawn(
      ChildProcess.make("bun", ["test/fixtures/resident-client.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        stdin: { stream: Stream.fromQueue(input).pipe(Stream.encodeText), endOnDone: true },
        stdout: "pipe",
        stderr: "pipe",
        env: {
          RIKA_TEST_RESIDENT_DATA_ROOT: root,
          RIKA_TEST_RESIDENT_GRACE: String(grace),
          RIKA_TEST_RESIDENT_FINALIZER_DELAY: String(finalizerDelay),
          RIKA_TEST_RESIDENT_DELAYED_WORK: delayedWork ? "1" : "0",
          RIKA_TEST_RESIDENT_OUTBOUND_CAPACITY: String(outboundCapacity),
          RIKA_TEST_RESIDENT_STARTUP_HOLD: String(startupHold),
          RIKA_TEST_RESIDENT_UNINTERRUPTIBLE_OWNER: uninterruptibleOwner ? "1" : "0",
          ...(ownerDrainMilliseconds === undefined
            ? {}
            : { RIKA_INTERNAL_RESIDENT_OWNER_DRAIN: String(ownerDrainMilliseconds) }),
        },
        extendEnv: true,
      }),
    )
    .pipe(Effect.mapError((cause) => new FixtureFailure({ operation: "start resident client", cause })))
  yield* client.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Ref.update(errors, (lines) => [...lines, line])),
    Effect.forkScoped,
  )
  yield* client.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      decodeEvent(line).pipe(
        Effect.mapError((cause) => new FixtureFailure({ operation: `decode client event: ${line}`, cause })),
        Effect.flatMap((event) => Queue.offer(events, event)),
      ),
    ),
    Effect.forkScoped,
  )
  yield* client.exitCode.pipe(
    Effect.flatMap((exitCode) =>
      Ref.get(errors).pipe(
        Effect.flatMap((lines) =>
          Queue.fail(
            events,
            new FixtureFailure({ operation: `resident client exited ${exitCode}`, cause: lines.join("\n") }),
          ),
        ),
      ),
    ),
    Effect.forkScoped,
  )
  const nextEffect = Queue.take(events)
  const send = Effect.fn("ResidentTransportTest.send")((command: string) =>
    Queue.offer(input, `${command}\n`).pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new FixtureFailure({ operation: "send resident command", cause })),
    ),
  )
  const awaitExit = client.exitCode.pipe(
    Effect.asVoid,
    Effect.mapError((cause) => new FixtureFailure({ operation: "wait for resident client", cause })),
  )
  const closeEffect = Effect.gen(function* () {
    yield* send("close")
    expect((yield* nextEffect).type).toBe("closed")
    yield* Queue.end(input)
  })
  const kill = client
    .kill({ killSignal: "SIGKILL" })
    .pipe(Effect.mapError((cause) => new FixtureFailure({ operation: "kill resident client", cause })))
  return {
    pid: Number(client.pid),
    nextEffect,
    send,
    closeEffect,
    kill,
    end: Queue.end(input),
    awaitExit,
  } satisfies ResidentClient
})

const attachedEffect = (client: ResidentClient) =>
  Effect.gen(function* () {
    const event = yield* client.nextEffect
    expect(event).toMatchObject({ type: "attached", role: "attached" })
    expect(event.clientPid).toBe(client.pid)
    expect(event.hostPid).not.toBe(event.clientPid)
    if (event.hostPid === undefined) return yield* Effect.die("attached event omitted host pid")
    hostPids.add(event.hostPid)
    return event
  })

const nextTypeEffect = (client: ResidentClient, type: string): Effect.Effect<Event, FixtureFailure> =>
  Effect.gen(function* () {
    const event = yield* client.nextEffect
    return event.type === type ? event : yield* nextTypeEffect(client, type)
  })

describe("resident WebSocket process transport", () => {
  test(
    "supersedes an authenticated old resident before starting the current host",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const old = yield* startOldResident(root)
            const startedAt = yield* Clock.currentTimeMillis
            const client = yield* start(root, 1_000)
            expect(yield* client.nextEffect).toEqual({ type: "resident-status", callbacks: 1 })
            const attached = yield* attachedEffect(client)
            expect(attached.hostPid).not.toBe(Number(old.pid))
            expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(8_000)
            yield* waitUntil(fileExists(`${root}/old-resident-stopped`), 2_000)
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(`${attached.hostPid}\n`)
            yield* client.send("ping")
            expect((yield* client.nextEffect).type).toBe("pong")
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "closes an old-path client with a clean incompatibility signal",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000)
            yield* attachedEffect(client)
            const endpoint = yield* resolve("default", root)
            const closed = yield* legacyClose(endpoint.legacyUrl)
            const oldClientFailure =
              closed.code === 4403
                ? { reason: "upgrade-required", message: "Resident protocol upgrade required", startsHost: false }
                : { reason: "resident-absent", message: closed.reason, startsHost: true }
            expect(closed).toEqual({
              code: 4403,
              reason: "Resident protocol upgrade required",
            })
            expect(oldClientFailure).toEqual({
              reason: "upgrade-required",
              message: "Resident protocol upgrade required",
              startsHost: false,
            })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "supersedes a recorded resident that rejects both handshake schemas",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const old = yield* startOldResident(root, true, "schema-reject")
            const client = yield* start(root, 1_000)
            expect(yield* client.nextEffect).toEqual({ type: "resident-status", callbacks: 1 })
            const attached = yield* attachedEffect(client)
            expect(attached.hostPid).not.toBe(Number(old.pid))
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(`${attached.hostPid}\n`)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "fails once without spawning when an authenticated stale listener PID cannot be verified",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          const old = yield* startOldResident(root, false)
          try {
            const startedAt = yield* Clock.currentTimeMillis
            const client = yield* start(root, 1_000)
            expect(yield* client.nextEffect).toMatchObject({
              type: "rejected",
              error: expect.stringContaining("its PID could not be verified"),
            })
            expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(4_000)
            expect(yield* fileExists(`${root}/owner-acquisitions.log`)).toBe(false)
          } finally {
            yield* old.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
            yield* cleanRoot(root)
          }
        }),
      ),
    10_000,
  )

  test(
    "does not supersede a listener matched only by a stale PID marker",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          const old = yield* startOldResident(root, false, "schema-reject")
          try {
            const fs = yield* FileSystem.FileSystem
            const staleMarker = `${root}/diagnostics/resident-stale-${old.pid}.open.jsonl`
            yield* fs.writeFileString(staleMarker, "", {
              mode: 0o600,
            })
            yield* fs.utimes(staleMarker, 0, 0)
            const client = yield* start(root, 1_000)
            expect(yield* client.nextEffect).toMatchObject({
              type: "rejected",
              error: expect.stringContaining("could not be verified"),
            })
            expect(alive(Number(old.pid))).toBe(true)
            expect(yield* fileExists(`${root}/owner-acquisitions.log`)).toBe(false)
          } finally {
            yield* old.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
            yield* cleanRoot(root)
          }
        }),
      ),
    10_000,
  )

  test(
    "keeps a healthy connection through a one-second client stall",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 2_000)
            yield* attachedEffect(client)
            yield* client.send("stall")
            expect((yield* client.nextEffect).type).toBe("stall-survived")
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "lets the first one-shot client exit without stopping its distinct host",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const oneShot = yield* start(root, 1_000)
            const first = yield* attachedEffect(oneShot)
            const closing = yield* oneShot.closeEffect.pipe(Effect.forkScoped)
            expect(alive(first.hostPid!)).toBe(true)

            const next = yield* start(root, 1_000)
            expect((yield* attachedEffect(next)).hostPid).toBe(first.hostPid)
            yield* Fiber.join(closing)
            yield* oneShot.awaitExit
            yield* next.send("ping")
            expect((yield* next.nextEffect).type).toBe("pong")
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "completes forwarded output and client-owned interactive sessions",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            const event = yield* attachedEffect(client)

            yield* client.send("output")
            expect(yield* client.nextEffect).toEqual({
              type: "output",
              text: `{"hostPid":${event.hostPid}}\n`,
            })
            expect((yield* client.nextEffect).type).toBe("output-completed")

            yield* client.send("interactive")
            expect((yield* client.nextEffect).type).toBe("interactive-callback")
            expect(yield* client.nextEffect).toEqual({
              type: "interactive-event",
              tag: "ThreadsListed",
            })
            expect((yield* client.nextEffect).type).toBe("interactive-completed")
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "forwards parent and child execution patches through the resident feed unchanged",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("child-execution-interactive")
            expect(yield* client.nextEffect).toEqual({
              type: "child-execution-events-completed",
              tags: [
                "parent-turn:child_run.spawned",
                "parent-turn:child:oracle:tool.call.requested",
                "parent-turn:child:oracle:model.output.completed",
              ],
            })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "forwards 200ms tool lifecycle events into distinct TUI model states",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("timed-tool-interactive")
            const event = yield* client.nextEffect
            expect(event.type).toBe("timed-tool-events-completed")
            const tags = event.tags ?? []
            expect(tags.map((tag) => tag.split(":")[0])).toEqual([
              "tool.call.requested",
              "tool.call.requested",
              "tool.result.received",
              "tool.result.received",
            ])
            const times = tags.map((tag) => Number(tag.split(":")[1]))
            expect(times[1]! - times[0]!).toBeLessThan(100)
            expect(times[2]! - times[0]!).toBeGreaterThanOrEqual(100)
            expect(times[3]! - times[2]!).toBeGreaterThanOrEqual(100)
            expect(tags.map((tag) => tag.split(":")[2])).toEqual([
              "Running tools",
              "Running tools",
              "Running tools",
              "Waiting",
            ])
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "reports an interactive operation failure before the client callback starts",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("rejected-interactive")
            expect(yield* client.nextEffect).toEqual({
              type: "interactive-rejected",
              error: "Interactive setup rejected",
            })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "serializes concurrent admissions without making execution block later admissions",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("serialized-interactive")
            const event = yield* client.nextEffect
            expect(event.type).toBe("serialized-interactive-completed")
            const result = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  admissionMaximum: Schema.optionalKey(Schema.Finite),
                  admissions: Schema.optionalKey(Schema.Array(Schema.Finite)),
                  executionMaximum: Schema.optionalKey(Schema.Finite),
                  completions: Schema.optionalKey(Schema.Array(Schema.Finite)),
                }),
              ),
            )(event.text ?? "{}")
            expect(result.admissionMaximum).toBe(1)
            expect(result.admissions).toEqual([0, 1, 2, 3])
            expect(result.executionMaximum).toBeGreaterThan(1)
            expect(result.completions?.toSorted((left, right) => left - right)).toEqual([0, 1, 2, 3])
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "chunks oversized operation output and keeps the connection healthy",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("oversized-output")
            const output = yield* client.nextEffect
            expect(output).toMatchObject({
              type: "oversized-output-completed",
              text: "1100001",
              outcome: "exact",
            })
            expect(output.callbacks).toBeGreaterThan(1)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "delivers a long bounded burst of interactive execution events without overflowing",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("burst-interactive")
            expect(yield* client.nextEffect).toEqual({ type: "burst-completed", text: "1000" })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "delivers an oversized interactive event without reconnecting",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("oversized-interactive-event")
            expect(yield* client.nextEffect).toEqual({
              type: "oversized-interactive-event-completed",
              text: "1100000",
            })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    30_000,
  )

  test(
    "backpressures two fragment-heavy sessions without failing either session",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 350, 0, false, 2)
            yield* attachedEffect(client)
            yield* client.send("fragment-burst")
            expect(yield* client.nextEffect).toEqual({
              type: "fragment-burst-completed",
              text: "8000000,8000000",
            })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    30_000,
  )

  test(
    "degrades a 20 MB event and survives replay after resident replacement",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000)
            yield* attachedEffect(client)
            yield* client.send("wire-limit-reattach")
            expect(yield* nextTypeEffect(client, "wire-limit-reattach-completed")).toMatchObject({ callbacks: 2 })
            expect((yield* readText(`${root}/owner-acquisitions.log`)).trim().split("\n")).toHaveLength(2)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    30_000,
  )

  test(
    "resyncs transcript delivery without failing the current physical feed",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 350, 0, false, 4)
            yield* attachedEffect(client)

            yield* client.send("overflow-interactive")
            const event = yield* client.nextEffect
            expect(event).toMatchObject({
              type: "overflow-completed",
              tag: "TranscriptResyncRequired",
            })
            expect(event.callbacks).toBeLessThan(12)
            expect(event.tags).toContain("TranscriptResyncRequired")
            expect((event.tags ?? []).includes("ExecutionFailed")).toBe(false)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "holds feed acknowledgements until a slow consumer releases capacity",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 350, 0, false, 4)
            yield* attachedEffect(client)
            yield* client.send("slow-consumer")
            const event = yield* client.nextEffect
            expect(event.type).toBe("slow-consumer-completed")
            expect(event.tags).toContain("TranscriptResyncRequired")
            expect(event.tags).not.toContain("execution.completed")
            expect(event.callbacks).toBeLessThan(10)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "keeps an interactive subscription alive after transcript delivery resyncs",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 350, 0, false, 4)
            yield* attachedEffect(client)

            yield* client.send("overflow-watch")
            const event = yield* client.nextEffect
            expect((event.tags ?? []).includes("ExecutionFailed")).toBe(false)
            expect(event).toMatchObject({
              type: "overflow-watch-finished",
              outcome: "Success",
              tags: expect.arrayContaining(["TranscriptResyncRequired", "ThreadsListed"]),
            })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "resyncs queue delivery without failing the current physical feed",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 350, 0, false, 4)
            yield* attachedEffect(client)

            yield* client.send("queue-overflow-interactive")
            const event = yield* client.nextEffect
            expect(event).toMatchObject({
              type: "queue-overflow-completed",
              tag: "QueueResyncRequired",
            })
            expect(event.callbacks).toBeLessThan(12)
            expect(event.tags).toContain("QueueResyncRequired")
            expect((event.tags ?? []).includes("TranscriptResyncRequired")).toBe(false)
            expect((event.tags ?? []).includes("ExecutionFailed")).toBe(false)
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "detaches and replaces the one resident event consumer",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root)
            yield* attachedEffect(client)

            yield* client.send("feed-takeover")
            expect(yield* client.nextEffect).toEqual({
              type: "replacement-feed-event",
              tag: "ThreadsListed",
            })
            expect((yield* client.nextEffect).type).toBe("feed-takeover-completed")
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "uses one distinct host for simultaneous clients and exits after final-client grace",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const [a, b] = yield* Effect.all([start(root), start(root)], { concurrency: 2 })
            const [aEvent, bEvent] = yield* Effect.all([attachedEffect(a), attachedEffect(b)])
            expect(aEvent.hostPid).toBe(bEvent.hostPid)
            expect(aEvent.id).not.toBe(bEvent.id)
            expect((yield* fileStat(`${root}/resident.token`)).mode & 0o077).toBe(0)
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(`${aEvent.hostPid}\n`)

            yield* a.kill
            expect(alive(aEvent.hostPid!)).toBe(true)
            yield* b.send("ping")
            expect((yield* b.nextEffect).type).toBe("pong")

            const c = yield* start(root)
            const cEvent = yield* attachedEffect(c)
            expect(cEvent.hostPid).toBe(aEvent.hostPid)
            yield* b.closeEffect
            expect(alive(aEvent.hostPid!)).toBe(true)
            yield* c.send("ping")
            expect((yield* c.nextEffect).type).toBe("pong")
            yield* c.closeEffect

            yield* waitUntil(fileExists(`${root}/owner-finalizations.log`), 4_000)
            expect(yield* readText(`${root}/owner-finalizations.log`)).toBe(`${aEvent.hostPid}\n`)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "keeps the cold startup host alive for clients arriving after normal grace",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const firstClient = yield* start(root, 100, 0, false, 1_024, 2_000)
            const first = yield* attachedEffect(firstClient)
            yield* firstClient.closeEffect
            yield* firstClient.awaitExit.pipe(
              Effect.timeoutOrElse({
                duration: "500 millis",
                orElse: () => Effect.die("resident startup owner did not exit after detaching its live host"),
              }),
            )
            expect(alive(first.hostPid!)).toBe(true)
            yield* Effect.sleep("500 millis")

            const lateClient = yield* start(root, 100, 0, false, 1_024, 2_000)
            const late = yield* attachedEffect(lateClient)
            expect(late.hostPid).toBe(first.hostPid)
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(`${first.hostPid}\n`)
            yield* lateClient.closeEffect

            yield* waitUntil(fileExists(`${root}/owner-finalizations.log`), 3_000)
            expect(yield* readText(`${root}/owner-finalizations.log`)).toBe(`${first.hostPid}\n`)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    10_000,
  )

  test(
    "survives starter SIGKILL and replaces a SIGKILLed host",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const starter = yield* start(root, 1_000)
            const first = yield* attachedEffect(starter)
            yield* starter.kill
            expect(alive(first.hostPid!)).toBe(true)

            const survivor = yield* start(root, 1_000)
            expect((yield* attachedEffect(survivor)).hostPid).toBe(first.hostPid)
            process.kill(first.hostPid!, "SIGKILL")
            yield* waitUntil(Effect.sync(() => !alive(first.hostPid!)))

            const replacement = yield* start(root, 1_000)
            const second = yield* attachedEffect(replacement)
            expect(second.hostPid).not.toBe(first.hostPid)
            const acquisitions = (yield* readText(`${root}/owner-acquisitions.log`)).trim().split("\n")
            expect(acquisitions).toEqual([String(first.hostPid), String(second.hostPid)])
            yield* replacement.send("ping")
            expect((yield* replacement.nextEffect).type).toBe("pong")
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "waits for the previous owner to finish draining before replacing it",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 100, 1_000)
            const first = yield* attachedEffect(client)
            yield* client.closeEffect
            yield* waitUntil(fileExists(`${root}/owner-finalizer-starts.log`))

            const replacement = yield* start(root)
            const second = yield* attachedEffect(replacement)
            expect(second.hostPid).not.toBe(first.hostPid)
            expect((yield* readText(`${root}/owner-acquisitions.log`)).trim().split("\n")).toEqual([
              String(first.hostPid),
              String(second.hostPid),
            ])
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "waits for a signalled owner to finish draining before replacing it",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000, 1_000)
            const first = yield* attachedEffect(client)
            process.kill(first.hostPid!, "SIGTERM")
            yield* waitUntil(fileExists(`${root}/owner-finalizer-starts.log`))

            const replacement = yield* start(root)
            const second = yield* attachedEffect(replacement)
            expect(second.hostPid).not.toBe(first.hostPid)
            expect((yield* readText(`${root}/owner-acquisitions.log`)).trim().split("\n")).toEqual([
              String(first.hostPid),
              String(second.hostPid),
            ])
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "exits promptly when signalled with ten attached clients",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const clients = yield* Effect.forEach(Array.from({ length: 10 }), () => start(root, 1_000), {
              concurrency: 10,
            })
            const attachments = yield* Effect.forEach(clients, attachedEffect, { concurrency: 10 })
            const hostPid = attachments[0]!.hostPid!
            expect(new Set(attachments.map((attachment) => attachment.hostPid))).toEqual(new Set([hostPid]))

            process.kill(hostPid, "SIGTERM")
            yield* waitUntil(
              Effect.sync(() => !alive(hostPid)),
              3_000,
            )
            expect(yield* fileExists(`${root}/resident-${(yield* resolve("default", root)).identity}.startup`)).toBe(
              false,
            )
            yield* Effect.forEach(clients, (client) => client.kill, { concurrency: 10, discard: true })
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "hard-exits within the owner-drain bound when an owner finalizer hangs uninterruptibly",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000, 0, false, 1_024, 0, true, 700)
            const attached = yield* attachedEffect(client)
            const hostPid = attached.hostPid!
            yield* waitUntil(fileExists(`${root}/owner-acquisitions.log`))
            process.kill(hostPid, "SIGTERM")
            yield* waitUntil(
              Effect.sync(() => !alive(hostPid)),
              4_000,
            )
            expect(yield* fileExists(`${root}/owner-finalizer-starts.log`)).toBe(true)
            expect(yield* fileExists(`${root}/owner-finalizations.log`)).toBe(false)
            yield* client.kill
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "interrupts host work before owner finalization and rejects work from an attached client while draining",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000, 750, true)
            const first = yield* attachedEffect(client)
            const existing = yield* start(root, 1_000, 750, true)
            expect((yield* attachedEffect(existing)).hostPid).toBe(first.hostPid)
            yield* client.send("delayed")
            yield* waitUntil(fileExists(`${root}/delayed-work-starts.log`))
            process.kill(first.hostPid!, "SIGTERM")
            yield* waitUntil(fileExists(`${root}/delayed-work-finalizations.log`))
            yield* existing.send("rejected")
            expect(yield* existing.nextEffect).toMatchObject({
              type: "rejected-work",
              error: "Resident service is draining",
            })
            yield* waitUntil(fileExists(`${root}/owner-finalizer-starts.log`))

            expect(yield* readText(`${root}/owner-finalizer-starts.log`)).toBe(`${first.hostPid}:0\n`)
            expect(yield* readText(`${root}/delayed-work-finalizations.log`)).toBe(`${first.hostPid}\n`)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "keeps one interactive callback and restores reads across resident replacements without retrying mutations",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000)
            yield* attachedEffect(client)
            yield* client.send("reconnect-interactive")
            expect(yield* client.nextEffect).toMatchObject({
              type: "interactive-callback",
              callbacks: 1,
            })
            expect(yield* client.nextEffect).toMatchObject({
              type: "initial-read",
              tag: "ThreadsListed",
            })
            expect(yield* nextTypeEffect(client, "replacement-read")).toMatchObject({
              tag: "ThreadsListed",
            })
            expect(yield* nextTypeEffect(client, "mutation-failed")).toMatchObject({
              tag: "ExecutionFailed",
            })
            expect(yield* nextTypeEffect(client, "post-mutation-read")).toMatchObject({
              tag: "ThreadsListed",
            })
            expect(yield* nextTypeEffect(client, "mutation-attempts")).toMatchObject({
              text: "1",
            })
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "logical close completes a blocking interactive callback and stops its physical connection",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 250)
            const event = yield* attachedEffect(client)
            yield* client.send("blocking-interactive")
            expect((yield* client.nextEffect).type).toBe("interactive-callback")
            yield* client.send("close")
            const completed = [yield* client.nextEffect, yield* client.nextEffect]
            expect(completed.map((item) => item.type).toSorted()).toEqual(["blocking-completed", "closed"])
            yield* client.end
            yield* client.awaitExit
            yield* waitUntil(fileExists(`${root}/owner-finalizations.log`), 4_000)
            expect(yield* readText(`${root}/owner-finalizations.log`)).toBe(`${event.hostPid}\n`)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "bounds repeated physical reconnects and terminates the logical interactive session",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = yield* start(root, 1_000)
            yield* attachedEffect(client)
            yield* client.send("flap-interactive")
            expect(yield* client.nextEffect).toMatchObject({
              type: "interactive-callback",
              callbacks: 1,
            })
            const failed = yield* nextTypeEffect(client, "flap-failed")
            expect(failed.error).toContain("closed 8 times before becoming stable")
            expect(failed.callbacks).toBe(8)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    30_000,
  )
})
