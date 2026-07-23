import * as BunServices from "@effect/platform-bun/BunServices"
import { expect } from "vitest"
import { fileURLToPath } from "node:url"
import { Cause, Config, Data, Effect, FileSystem, Function, Layer, Queue, Ref, Schema, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export type Event = {
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

export class FixtureFailure extends Data.TaggedError("FixtureFailure")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export const provide: {
  <A, E, R, ROut, E2, RIn>(
    effect: Effect.Effect<A, E, R>,
    layer: Layer.Layer<ROut, E2, RIn>,
  ): Effect.Effect<A, E | E2, Exclude<RIn | Exclude<R, ROut>, Scope.Scope>>
  <ROut, E2, RIn>(
    layer: Layer.Layer<ROut, E2, RIn>,
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | E2, Exclude<RIn | Exclude<R, ROut>, Scope.Scope>>
} = Function.dual(
  2,
  <A, E, R, ROut, E2, RIn>(
    effect: Effect.Effect<A, E, R>,
    layer: Layer.Layer<ROut, E2, RIn>,
  ): Effect.Effect<A, E | E2, Exclude<RIn | Exclude<R, ROut>, Scope.Scope>> =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        return yield* Effect.provide(effect, context)
      }),
    ),
)

export const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(provide(effect, BunServices.layer))

export const EventSchema = Schema.Struct({
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

const decodeEventLine = Schema.decodeUnknownEffect(Schema.fromJsonString(EventSchema))
export const decodeEvent = (input: unknown) => decodeEventLine(input)

export const hostPids = new Set<number>()

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const waitUntil: {
  <E, R>(condition: Effect.Effect<boolean, E, R>, timeout?: number): Effect.Effect<undefined, E, R>
  (timeout?: number): <E, R>(condition: Effect.Effect<boolean, E, R>) => Effect.Effect<undefined, E, R>
} = Function.dual(
  (args) => Effect.isEffect(args[0]),
  <E, R>(condition: Effect.Effect<boolean, E, R>, timeout = 2_000): Effect.Effect<undefined, E, R> =>
    Effect.gen(function* () {
      const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      while (!(yield* condition)) {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        if (now - started >= timeout) return yield* Effect.die("condition timed out")
        yield* Effect.sleep("20 millis")
      }
    }),
)

export const makeRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const temporaryDirectory = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"))
  return yield* fileSystem.makeTempDirectory({ directory: temporaryDirectory, prefix: "rika-resident-" })
})

export const cleanRoot = (root: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.remove(root, { recursive: true, force: true })),
    Effect.mapError((cause) => new FixtureFailure({ operation: "clean fixture root", cause })),
  )

export const readText = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(path))
export const fileStat = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(path))
export const fileExists = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.exists(path))

export const legacyClose = (url: string) =>
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

export const startOldResident = Effect.fn("ResidentTransportTest.startOldResident")(function* (
  root: string,
  recordPid: boolean = true,
  mode: "fake-incompatible" | "legacy" | "schema-reject" | "signed-v4" | "v3" = "legacy",
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

export interface ResidentClient {
  readonly pid: number
  readonly nextEffect: Effect.Effect<Event, FixtureFailure>
  readonly send: (command: string) => Effect.Effect<void, FixtureFailure>
  readonly closeEffect: Effect.Effect<void, FixtureFailure>
  readonly kill: Effect.Effect<void, FixtureFailure>
  readonly end: Effect.Effect<void>
  readonly awaitExit: Effect.Effect<void, FixtureFailure>
}

export const start = Effect.fn("ResidentTransportTest.start")(function* (
  root: string,
  grace: number = 350,
  finalizerDelay: number = 0,
  delayedWork: boolean = false,
  outboundCapacity: number = 1_024,
  startupHold: number = 0,
  uninterruptibleOwner: boolean = false,
  ownerDrainMilliseconds?: number,
  ownerStartupDelay: number = 0,
  options: {
    readonly script?: string
    readonly environment?: Readonly<Record<string, string>>
  } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const input = yield* Queue.bounded<string, Cause.Done>(32)
  const events = yield* Queue.bounded<Event, FixtureFailure>(2_048)
  const errors = yield* Ref.make<ReadonlyArray<string>>([])
  const client = yield* spawner
    .spawn(
      ChildProcess.make("bun", [options.script ?? "test/fixtures/resident-client.ts"], {
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
          RIKA_TEST_RESIDENT_OWNER_STARTUP_DELAY: String(ownerStartupDelay),
          ...(ownerDrainMilliseconds === undefined
            ? {}
            : { RIKA_INTERNAL_RESIDENT_OWNER_DRAIN: String(ownerDrainMilliseconds) }),
          ...options.environment,
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

export const attachedEffect = (client: ResidentClient) =>
  Effect.gen(function* () {
    const event = yield* client.nextEffect
    expect(event).toMatchObject({ type: "attached", role: "attached" })
    expect(event.clientPid).toBe(client.pid)
    expect(event.hostPid).not.toBe(event.clientPid)
    if (event.hostPid === undefined) return yield* Effect.die("attached event omitted host pid")
    hostPids.add(event.hostPid)
    return event
  })

export const nextTypeEffect: {
  (client: ResidentClient, type: string): Effect.Effect<Event, FixtureFailure>
  (type: string): (client: ResidentClient) => Effect.Effect<Event, FixtureFailure>
} = Function.dual(
  2,
  (client: ResidentClient, type: string): Effect.Effect<Event, FixtureFailure> =>
    Effect.gen(function* () {
      const event = yield* client.nextEffect
      return event.type === type ? event : yield* nextTypeEffect(client, type)
    }),
)

export const killTrackedHosts = () => {
  for (const pid of hostPids) {
    try {
      globalThis.process.kill(pid, "SIGKILL")
    } catch {}
  }
  hostPids.clear()
}
