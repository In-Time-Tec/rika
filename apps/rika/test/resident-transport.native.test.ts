import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { afterEach, describe, expect, test } from "bun:test"
import { Config, Data, Effect, FileSystem, Layer, Schema } from "effect"

type Process = ReturnType<typeof Bun.spawn>
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
}

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{
  readonly operation: string
  readonly cause: unknown
}> {}

const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new FixtureFailure({ operation, cause }) })

const provide = <A, E, R, ROut, E2, RIn>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* Effect.provide(effect, context)
    }),
  )

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(provide(effect, BunFileSystem.layer))

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
})

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(EventSchema))

const processes: Array<Process> = []
const hostPids = new Set<number>()

afterEach(() =>
  Effect.runPromise(
    Effect.sync(() => {
      for (const process of processes.splice(0)) process.kill(9)
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
  attempt("clean fixture root", () => Bun.$`chmod -R u+rwx ${root}; rm -rf ${root}`.quiet()).pipe(Effect.asVoid)

const readText = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(path))
const fileStat = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(path))
const fileExists = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.exists(path))

const start = (root: string, grace = 350, finalizerDelay = 0, delayedWork = false) => {
  const client = Bun.spawn(["bun", "test/fixtures/resident-client.ts"], {
    cwd: import.meta.dir.replace(/\/test$/, ""),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      RIKA_TEST_RESIDENT_DATA_ROOT: root,
      RIKA_TEST_RESIDENT_GRACE: String(grace),
      RIKA_TEST_RESIDENT_FINALIZER_DELAY: String(finalizerDelay),
      RIKA_TEST_RESIDENT_DELAYED_WORK: delayedWork ? "1" : "0",
    },
  })
  processes.push(client)
  const reader = client.stdout.getReader()
  let buffered = ""
  const readLine = (): Effect.Effect<string, FixtureFailure> => {
    const index = buffered.indexOf("\n")
    if (index >= 0) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      return Effect.succeed(line)
    }
    return attempt("read client output", () => reader.read()).pipe(
      Effect.flatMap((value) =>
        value.done
          ? attempt("read client error", () => new Response(client.stderr).text()).pipe(
              Effect.flatMap((error) =>
                Effect.fail(new FixtureFailure({ operation: `client exited ${error}`, cause: error })),
              ),
            )
          : Effect.sync(() => {
              buffered += new TextDecoder().decode(value.value)
            }).pipe(Effect.andThen(Effect.suspend(readLine))),
      ),
    )
  }
  const nextEffect = Effect.suspend(readLine).pipe(
    Effect.flatMap((line) =>
      decodeEvent(line).pipe(
        Effect.mapError((cause) => new FixtureFailure({ operation: `decode client event: ${line}`, cause })),
      ),
    ),
  )
  const next = () => Effect.runPromise(nextEffect)
  const send = (command: string) => client.stdin.write(new TextEncoder().encode(`${command}\n`))
  const closeEffect = Effect.gen(function* () {
    send("close")
    expect((yield* nextEffect).type).toBe("closed")
    client.stdin.end()
    yield* attempt("wait for client exit", () => client.exited)
  })
  const close = () => Effect.runPromise(closeEffect)
  return { client, next, nextEffect, send, close, closeEffect }
}

const attachedEffect = (client: ReturnType<typeof start>) =>
  Effect.gen(function* () {
    const event = yield* client.nextEffect
    expect(event).toMatchObject({ type: "attached", role: "attached" })
    expect(event.clientPid).toBe(client.client.pid)
    expect(event.hostPid).not.toBe(event.clientPid)
    if (event.hostPid === undefined) return yield* Effect.die("attached event omitted host pid")
    hostPids.add(event.hostPid)
    return event
  })

const nextTypeEffect = (client: ReturnType<typeof start>, type: string): Effect.Effect<Event, FixtureFailure> =>
  Effect.gen(function* () {
    const event = yield* client.nextEffect
    return event.type === type ? event : yield* nextTypeEffect(client, type)
  })

describe("resident WebSocket process transport", () => {
  test(
    "keeps a healthy connection through a one-second client stall",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = start(root, 2_000)
            yield* attachedEffect(client)
            client.send("stall")
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
            const oneShot = start(root, 1_000)
            const first = yield* attachedEffect(oneShot)
            yield* oneShot.closeEffect
            expect(alive(first.hostPid!)).toBe(true)

            const next = start(root, 1_000)
            expect((yield* attachedEffect(next)).hostPid).toBe(first.hostPid)
            next.send("ping")
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
            const client = start(root)
            const event = yield* attachedEffect(client)

            client.send("output")
            expect(yield* client.nextEffect).toEqual({
              type: "output",
              text: `{"hostPid":${event.hostPid}}\n`,
            })
            expect((yield* client.nextEffect).type).toBe("output-completed")

            client.send("interactive")
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
    "reports an interactive operation failure before the client callback starts",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = start(root)
            yield* attachedEffect(client)

            client.send("rejected-interactive")
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
    "delivers a long burst of interactive execution events without overflowing",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = start(root)
            yield* attachedEffect(client)

            client.send("burst-interactive")
            expect(yield* client.nextEffect).toEqual({ type: "burst-completed", text: "2000" })
            yield* client.closeEffect
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "cancels a resident interactive action before starting the next action",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = start(root)
            yield* attachedEffect(client)

            client.send("cancel-action")
            expect(yield* client.nextEffect).toEqual({
              type: "second-action-event",
              tag: "ThreadsListed",
            })
            expect((yield* client.nextEffect).type).toBe("actions-completed")
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
            const [a, b] = [start(root), start(root)]
            const [aEvent, bEvent] = yield* Effect.all([attachedEffect(a), attachedEffect(b)])
            expect(aEvent.hostPid).toBe(bEvent.hostPid)
            expect(aEvent.id).not.toBe(bEvent.id)
            expect((yield* fileStat(`${root}/resident.token`)).mode & 0o077).toBe(0)
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(`${aEvent.hostPid}\n`)

            a.client.kill(9)
            yield* attempt("wait for client exit", () => a.client.exited)
            expect(alive(aEvent.hostPid!)).toBe(true)
            b.send("ping")
            expect((yield* b.nextEffect).type).toBe("pong")

            const c = start(root)
            const cEvent = yield* attachedEffect(c)
            expect(cEvent.hostPid).toBe(aEvent.hostPid)
            yield* b.closeEffect
            expect(alive(aEvent.hostPid!)).toBe(true)
            c.send("ping")
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
    "survives starter SIGKILL and replaces a SIGKILLed host",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const starter = start(root, 1_000)
            const first = yield* attachedEffect(starter)
            starter.client.kill(9)
            yield* attempt("wait for client exit", () => starter.client.exited)
            expect(alive(first.hostPid!)).toBe(true)

            const survivor = start(root, 1_000)
            expect((yield* attachedEffect(survivor)).hostPid).toBe(first.hostPid)
            process.kill(first.hostPid!, "SIGKILL")
            yield* waitUntil(Effect.sync(() => !alive(first.hostPid!)))

            const replacement = start(root, 1_000)
            const second = yield* attachedEffect(replacement)
            expect(second.hostPid).not.toBe(first.hostPid)
            const acquisitions = (yield* readText(`${root}/owner-acquisitions.log`)).trim().split("\n")
            expect(acquisitions).toEqual([String(first.hostPid), String(second.hostPid)])
            replacement.send("ping")
            expect((yield* replacement.nextEffect).type).toBe("pong")
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "rejects admission while the previous owner is draining",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = start(root, 100, 1_000)
            const first = yield* attachedEffect(client)
            yield* client.closeEffect
            yield* waitUntil(fileExists(`${root}/owner-finalizer-starts.log`))

            const rejected = start(root)
            expect(yield* rejected.nextEffect).toMatchObject({
              type: "rejected",
              error: "Resident service is draining",
            })
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(`${first.hostPid}\n`)

            yield* waitUntil(fileExists(`${root}/owner-finalizations.log`), 4_000)
            const replacement = start(root)
            const second = yield* attachedEffect(replacement)
            expect(second.hostPid).not.toBe(first.hostPid)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )

  test(
    "rejects admission while a signalled owner is draining",
    () =>
      run(
        Effect.gen(function* () {
          const root = yield* makeRoot
          try {
            const client = start(root, 1_000, 1_000)
            const first = yield* attachedEffect(client)
            process.kill(first.hostPid!, "SIGTERM")
            yield* waitUntil(fileExists(`${root}/owner-finalizer-starts.log`))

            const rejected = start(root)
            expect(yield* rejected.nextEffect).toMatchObject({
              type: "rejected",
              error: "Resident service is draining",
            })
            expect(yield* readText(`${root}/owner-acquisitions.log`)).toBe(`${first.hostPid}\n`)

            yield* waitUntil(fileExists(`${root}/owner-finalizations.log`), 4_000)
            const replacement = start(root)
            const second = yield* attachedEffect(replacement)
            expect(second.hostPid).not.toBe(first.hostPid)
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
            const client = start(root, 1_000, 750, true)
            const first = yield* attachedEffect(client)
            const existing = start(root, 1_000, 750, true)
            expect((yield* attachedEffect(existing)).hostPid).toBe(first.hostPid)
            client.send("delayed")
            yield* waitUntil(fileExists(`${root}/delayed-work-starts.log`))
            process.kill(first.hostPid!, "SIGTERM")
            existing.send("rejected")
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
            const client = start(root, 1_000)
            yield* attachedEffect(client)
            client.send("reconnect-interactive")
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
            const client = start(root, 250)
            const event = yield* attachedEffect(client)
            client.send("blocking-interactive")
            expect((yield* client.nextEffect).type).toBe("interactive-callback")
            client.send("close")
            const completed = [yield* client.nextEffect, yield* client.nextEffect]
            expect(completed.map((item) => item.type).toSorted()).toEqual(["blocking-completed", "closed"])
            client.client.stdin.end()
            yield* attempt("wait for client exit", () => client.client.exited)
            yield* waitUntil(fileExists(`${root}/owner-finalizations.log`), 4_000)
            expect(yield* readText(`${root}/owner-finalizations.log`)).toBe(`${event.hostPid}\n`)
          } finally {
            yield* cleanRoot(root)
          }
        }),
      ),
    15_000,
  )
})
