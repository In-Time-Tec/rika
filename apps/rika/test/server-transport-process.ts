import { expect } from "vitest"
import { fileURLToPath } from "node:url"
import { Effect, Function, Queue, Ref, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Event, FixtureFailure, decodeEvent, waitUntil } from "./server-transport-runtime"
import { fileExists } from "./server-transport-files"

export const hostPids = new Set<number>()

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const startHostOnly = Effect.fn("ServerTransportTest.startHostOnly")(function* (
  root: string,
  environment: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const host = yield* spawner.spawn(
    ChildProcess.make("bun", ["test/fixtures/server-host.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: {
        RIKA_TEST_SERVER_DATA_ROOT: root,
        ...environment,
      },
      extendEnv: true,
    }),
  )
  if (host.pid !== undefined) hostPids.add(host.pid)
  yield* waitUntil(fileExists(`${root}/owner-acquisitions.log`), 5_000)
  return host
})

export interface ServerClient {
  readonly pid: number
  readonly nextEffect: Effect.Effect<Event, FixtureFailure>
  readonly send: (command: string) => Effect.Effect<void, FixtureFailure>
  readonly closeEffect: Effect.Effect<void, FixtureFailure>
  readonly kill: Effect.Effect<void, FixtureFailure>
  readonly end: Effect.Effect<void>
  readonly awaitExit: Effect.Effect<void, FixtureFailure>
}

export const start = Effect.fn("ServerTransportTest.start")(function* (
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
      ChildProcess.make("bun", [options.script ?? "test/fixtures/server-client.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        stdin: { stream: Stream.fromQueue(input).pipe(Stream.encodeText), endOnDone: true },
        stdout: "pipe",
        stderr: "pipe",
        env: {
          RIKA_TEST_SERVER_DATA_ROOT: root,
          RIKA_TEST_SERVER_GRACE: String(grace),
          RIKA_TEST_SERVER_FINALIZER_DELAY: String(finalizerDelay),
          RIKA_TEST_SERVER_DELAYED_WORK: delayedWork ? "1" : "0",
          RIKA_TEST_SERVER_OUTBOUND_CAPACITY: String(outboundCapacity),
          RIKA_TEST_SERVER_STARTUP_HOLD: String(startupHold),
          RIKA_TEST_SERVER_UNINTERRUPTIBLE_OWNER: uninterruptibleOwner ? "1" : "0",
          RIKA_TEST_SERVER_OWNER_STARTUP_DELAY: String(ownerStartupDelay),
          ...(ownerDrainMilliseconds === undefined
            ? {}
            : { RIKA_INTERNAL_SERVER_OWNER_DRAIN: String(ownerDrainMilliseconds) }),
          ...options.environment,
        },
        extendEnv: true,
      }),
    )
    .pipe(Effect.mapError((cause) => new FixtureFailure({ operation: "start server client", cause })))
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
            new FixtureFailure({ operation: `server client exited ${exitCode}`, cause: lines.join("\n") }),
          ),
        ),
      ),
    ),
    Effect.forkScoped,
  )
  const nextEffect = Queue.take(events)
  const send = Effect.fn("ServerTransportTest.send")((command: string) =>
    Queue.offer(input, `${command}\n`).pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new FixtureFailure({ operation: "send server command", cause })),
    ),
  )
  const awaitExit = client.exitCode.pipe(
    Effect.asVoid,
    Effect.mapError((cause) => new FixtureFailure({ operation: "wait for server client", cause })),
  )
  const closeEffect = Effect.gen(function* () {
    yield* send("close")
    expect((yield* nextEffect).type).toBe("closed")
    yield* Queue.end(input)
  })
  const kill = client
    .kill({ killSignal: "SIGKILL" })
    .pipe(Effect.mapError((cause) => new FixtureFailure({ operation: "kill server client", cause })))
  return {
    pid: Number(client.pid),
    nextEffect,
    send,
    closeEffect,
    kill,
    end: Queue.end(input),
    awaitExit,
  } satisfies ServerClient
})

export const attachedEffect = (client: ServerClient) =>
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
  (client: ServerClient, type: string): Effect.Effect<Event, FixtureFailure>
  (type: string): (client: ServerClient) => Effect.Effect<Event, FixtureFailure>
} = Function.dual(
  2,
  (client: ServerClient, type: string): Effect.Effect<Event, FixtureFailure> =>
    Effect.gen(function* () {
      const event = yield* client.nextEffect
      return event.type === type ? event : yield* nextTypeEffect(client, type)
    }),
)
