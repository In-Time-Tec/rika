import * as ResidentService from "@rika/app/resident-service"
import { Config, Effect, FileSystem, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as Net from "node:net"

const StartupMessage = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("ready") }),
  Schema.Struct({ _tag: Schema.tag("failed"), message: Schema.String }),
])

const encode = Schema.encodeSync(Schema.UnknownFromJsonString)
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StartupMessage))
const startupFdEnvironment = "RIKA_INTERNAL_RESIDENT_STARTUP_FD"
const startupFd = 3
let signalled = false
const closeDescriptor = (descriptor: number) =>
  Effect.sync(() => process.getBuiltinModule("node:fs").closeSync(descriptor))
const writeDescriptor = (descriptor: number, value: string) =>
  Effect.try(() => process.getBuiltinModule("node:fs").writeFileSync(descriptor, value))

export const processIsAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })

const linuxListenerProcessIds = Effect.fn("ResidentProcessStartup.linuxListenerProcessIds")(function* (
  port: number,
  candidates: ReadonlyArray<number>,
) {
  const fs = yield* FileSystem.FileSystem
  const portHex = port.toString(16).toUpperCase().padStart(4, "0")
  const inodes = new Set<string>()
  for (const filename of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = yield* fs.readFileString(filename).pipe(Effect.option)
    if (Option.isNone(text)) continue
    for (const line of text.value.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/)
      const local = fields[1]
      const inode = fields[9]
      if (local !== undefined && local.endsWith(`:${portHex}`) && fields[3] === "0A" && inode !== undefined)
        inodes.add(inode)
    }
  }
  const matched = new Array<number>()
  for (const pid of candidates) {
    const descriptors = yield* fs.readDirectory(`/proc/${pid}/fd`).pipe(Effect.option)
    if (Option.isNone(descriptors)) continue
    for (const descriptor of descriptors.value) {
      const target = yield* fs.readLink(`/proc/${pid}/fd/${descriptor}`).pipe(Effect.option)
      if (Option.isSome(target) && target.value.startsWith("socket:[") && inodes.has(target.value.slice(8, -1))) {
        matched.push(pid)
        break
      }
    }
  }
  return matched
})

const listenerCommand = Effect.fn("ResidentProcessStartup.listenerCommand")(function* (
  executable: string,
  arguments_: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make(executable, arguments_, { stdin: "ignore", stdout: "pipe", stderr: "ignore" }),
  )
  const output = yield* Stream.runFold(
    handle.stdout.pipe(Stream.decodeText()),
    () => "",
    (text, chunk) => text + chunk,
  )
  return { output, exitCode: yield* handle.exitCode }
})

export const listenerProcessIds = Effect.fn("ResidentProcessStartup.listenerProcessIds")(function* (
  port: number,
  candidates: ReadonlyArray<number>,
) {
  if (process.platform === "linux") return yield* linuxListenerProcessIds(port, candidates)
  const inspected = yield* Effect.result(
    process.platform === "win32"
      ? listenerCommand("netstat", ["-ano", "-p", "TCP"])
      : listenerCommand("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]),
  )
  if (inspected._tag === "Failure" || inspected.success.exitCode !== 0) return []
  const pids =
    process.platform === "win32"
      ? inspected.success.output
          .split("\n")
          .map((line) => line.trim().split(/\s+/))
          .filter((fields) => {
            const local = fields[1]
            return fields[0] === "TCP" && local !== undefined && local.endsWith(`:${port}`) && fields[3] === "LISTENING"
          })
          .map((fields) => Number(fields[4]))
      : inspected.success.output
          .split(/\s+/)
          .filter((value) => value.length > 0)
          .map(Number)
  const allowed = new Set(candidates)
  return [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && allowed.has(pid)))]
})

export const listenerIsLive = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = Net.createConnection({ host: "127.0.0.1", port })
    let settled = false
    const finish = (live: boolean) => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      socket.destroy()
      resume(Effect.succeed(live))
    }
    socket.once("connect", () => finish(true))
    socket.once("error", (cause) => finish(!("code" in cause) || cause.code !== "ECONNREFUSED"))
    socket.setTimeout(250, () => finish(true))
    return Effect.sync(() => {
      socket.setTimeout(0)
      socket.destroy()
    })
  })

const signalProcess = (pid: number, signal: NodeJS.Signals) =>
  Effect.suspend(() => {
    try {
      process.kill(pid, signal)
      return Effect.void
    } catch (cause) {
      if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ESRCH") return Effect.void
      return Effect.fail(
        ResidentService.ResidentServiceError.make({
          reason: "foreign-listener",
          message: `Could not stop stale Rika resident PID ${pid}: ${String(cause)}. Stop it, then run rika again`,
        }),
      )
    }
  })

const awaitResidentRelease = (pid: number, port: number, attempts: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!(yield* processIsAlive(pid)) && !(yield* listenerIsLive(port))) return true
      yield* Effect.sleep("50 millis")
    }
    return !(yield* processIsAlive(pid)) && !(yield* listenerIsLive(port))
  })

export const supersede = Effect.fn("ResidentProcessStartup.supersede")(function* (pid: number, port: number) {
  if (pid === process.pid)
    return yield* ResidentService.ResidentServiceError.make({
      reason: "foreign-listener",
      message: "Refusing to supersede the current Rika client process",
    })
  if (!(yield* processIsAlive(pid))) return
  yield* signalProcess(pid, "SIGTERM")
  if (yield* awaitResidentRelease(pid, port, 120)) return
  yield* signalProcess(pid, "SIGKILL")
  if (yield* awaitResidentRelease(pid, port, 40)) return
  return yield* ResidentService.ResidentServiceError.make({
    reason: "foreign-listener",
    message: `Stale Rika resident PID ${pid} kept port ${port}; stop it, then run rika again`,
  })
})

const error = (reason: "startup-failed" | "transport-failed", cause: unknown) =>
  ResidentService.ResidentServiceError.make({ reason, message: String(cause) })

const signal = (message: typeof StartupMessage.Type) =>
  Effect.gen(function* () {
    const configured = yield* Config.option(Config.string(startupFdEnvironment))
    if (Option.isNone(configured) || signalled) return
    signalled = true
    const descriptor = Number(configured.value)
    yield* writeDescriptor(descriptor, `${encode(message)}\n`).pipe(Effect.ensuring(closeDescriptor(descriptor)))
  }).pipe(Effect.mapError((cause) => error("startup-failed", `Could not report resident startup: ${String(cause)}`)))

export const signalReady = signal({ _tag: "ready" })
export const signalFailure = (message: string) => signal({ _tag: "failed", message })

const awaitStartup = <E>(output: Stream.Stream<Uint8Array, E>) =>
  Stream.runFold(
    Stream.splitLines(Stream.decodeText(output)),
    () => Option.none<string>(),
    (first, text) => (Option.isSome(first) ? first : Option.some(text)),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(error("startup-failed", "Resident startup signal timed out")),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(error("startup-failed", "Resident startup signal ended without a message")),
        onSome: (text) => decode(text).pipe(Effect.mapError((cause) => error("startup-failed", cause))),
      }),
    ),
    Effect.flatMap((message) =>
      message._tag === "ready" ? Effect.void : Effect.fail(error("startup-failed", message.message)),
    ),
    Effect.mapError((cause) =>
      Schema.is(ResidentService.ResidentServiceError)(cause) ? cause : error("startup-failed", cause),
    ),
  )

export const spawn = Effect.fn("ResidentProcessStartup.spawn")(function* (options: {
  readonly executable: string
  readonly arguments: ReadonlyArray<string>
  readonly cwd?: string
  readonly environment: Readonly<Record<string, string | undefined>>
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(options.executable, options.arguments, {
        detached: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        additionalFds: { fd3: { type: "output" } },
        extendEnv: true,
        env: { ...options.environment, [startupFdEnvironment]: String(startupFd) },
      }),
    )
    .pipe(Effect.mapError((cause) => error("transport-failed", cause)))
  return {
    pid: Number(handle.pid),
    startup: awaitStartup(handle.getOutputFd(startupFd)),
    detach: handle.unref.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => error("transport-failed", cause)),
    ),
    abort: handle
      .kill({ killSignal: "SIGKILL" })
      .pipe(Effect.andThen(handle.exitCode), Effect.timeout("2 seconds"), Effect.ignore),
  } satisfies ResidentService.StartedHost
})
