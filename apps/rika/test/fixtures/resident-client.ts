import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"

import { Clock, Config, Effect, FileSystem, Layer, Logger, Path, Ref, Schema, Stdio, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { make } from "../../src/transport/client/resident-client-startup"

import * as ResidentProcessStartup from "../../src/resident/process/resident-process-launch"
import { runResidentClientCommands } from "./resident-client-commands"

const JsonLine = Schema.UnknownFromJsonString
const HostStatus = Schema.fromJsonString(Schema.Struct({ hostPid: Schema.Finite }))

const program = Effect.gen(function* () {
  const dataRoot = yield* Config.string("RIKA_TEST_RESIDENT_DATA_ROOT")
  const grace = yield* Config.string("RIKA_TEST_RESIDENT_GRACE").pipe(Config.withDefault("500"))
  const finalizerDelay = yield* Config.string("RIKA_TEST_RESIDENT_FINALIZER_DELAY").pipe(Config.withDefault("0"))
  const delayedWork = yield* Config.string("RIKA_TEST_RESIDENT_DELAYED_WORK").pipe(Config.withDefault("0"))
  const activeWorkMilliseconds = yield* Config.string("RIKA_TEST_RESIDENT_ACTIVE_WORK_MILLIS").pipe(
    Config.withDefault("0"),
  )
  const startupHold = yield* Config.string("RIKA_TEST_RESIDENT_STARTUP_HOLD").pipe(Config.withDefault("0"))
  const outboundCapacity = yield* Config.string("RIKA_TEST_RESIDENT_OUTBOUND_CAPACITY").pipe(Config.withDefault("1024"))
  const stdio = yield* Stdio.Stdio
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const clock = yield* Clock.Clock
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const hostPid = yield* Ref.make(0)
  const emit = Effect.fn("ResidentClient.emit")(function* (value: unknown) {
    const encoded = yield* Schema.encodeUnknownEffect(JsonLine)(value)
    yield* Stream.make(`${encoded}\n`).pipe(Stream.run(stdio.stdout({ endOnDone: false })))
  }, Effect.orDie)
  const kill = Effect.fn("ResidentClient.kill")(
    function* (pid: number) {
      const killer = yield* spawner.spawn(ChildProcess.make("kill", ["-KILL", String(pid)]))
      yield* killer.exitCode
    },
    Effect.scoped,
    Effect.orDie,
  )
  const hostScript = yield* Config.string("RIKA_TEST_RESIDENT_HOST_SCRIPT").pipe(
    Config.withDefault("test/fixtures/resident-host.ts"),
  )
  const buildIdentity = yield* Config.string("RIKA_TEST_BUILD_IDENTITY").pipe(Config.withDefault(""))
  const noSupersede = (yield* Config.string("RIKA_TEST_RESIDENT_NO_SUPERSEDE").pipe(Config.withDefault("0"))) === "1"
  const service = yield* make()
  const connected = yield* Effect.result(
    service.getOrCreate({
      profile: "default",
      dataRoot,
      clientKind: "run",
      graceMilliseconds: Number(grace),
      ...(noSupersede ? { allowSupersede: false } : {}),
      startHost: () =>
        ResidentProcessStartup.spawn({
          executable: "bun",
          arguments: [hostScript],
          cwd: path.dirname(path.dirname(import.meta.dir)),
          environment: {
            RIKA_TEST_RESIDENT_DATA_ROOT: dataRoot,
            RIKA_TEST_RESIDENT_GRACE: grace,
            RIKA_TEST_RESIDENT_FINALIZER_DELAY: finalizerDelay,
            RIKA_TEST_RESIDENT_DELAYED_WORK: delayedWork,
            RIKA_TEST_RESIDENT_ACTIVE_WORK_MILLIS: activeWorkMilliseconds,
            RIKA_TEST_RESIDENT_STARTUP_HOLD: startupHold,
            RIKA_TEST_RESIDENT_OUTBOUND_CAPACITY: outboundCapacity,
            ...(buildIdentity === "" ? {} : { RIKA_TEST_BUILD_IDENTITY: buildIdentity }),
          },
        }),
    }),
  )
  if (connected._tag === "Failure") {
    yield* emit({ type: "rejected", tag: connected.failure._tag, error: connected.failure.message })
    return
  }
  const connection = connected.success
  yield* Effect.addFinalizer(() => connection.close)
  yield* connection.run(
    { _tag: "Doctor" },
    {
      stdout: (text) =>
        Schema.decodeUnknownEffect(HostStatus)(text).pipe(
          Effect.flatMap((status) => Ref.set(hostPid, status.hostPid)),
          Effect.orDie,
        ),
    },
  )
  yield* emit({
    type: "attached",
    role: connection.role,
    id: connection.connectionId,
    clientPid: process.pid,
    hostPid: yield* Ref.get(hostPid),
  })
  yield* runResidentClientCommands({ connection, stdio, dataRoot, path, clock, fileSystem: fs, hostPid, emit, kill })
})

let supersedeStatusCount = 0
const statusLogger = Logger.make(({ message }) => {
  if (!Array.isArray(message) || !message.some((value: unknown) => String(value) === "resident.startup.superseding"))
    return
  supersedeStatusCount += 1
  process.stdout.write(`${JSON.stringify({ type: "resident-status", callbacks: supersedeStatusCount })}\n`)
})
const MainLayer = Layer.mergeAll(BunServices.layer, Logger.layer([statusLogger]))

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(MainLayer)
      yield* Effect.provide(program, context)
    }),
  ),
)
