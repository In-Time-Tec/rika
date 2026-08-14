import * as ServerService from "@rika/product/server-service"
import { Effect, FileSystem, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as Net from "node:net"

export const processIsAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })

const linuxListenerProcessIds = Effect.fn("ServerProcessStartup.linuxListenerProcessIds")(function* (
  port: number,
  requested: ReadonlyArray<number> | "any",
) {
  const fs = yield* FileSystem.FileSystem
  const candidates =
    requested === "any"
      ? (yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => [])))
          .map(Number)
          .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
      : requested
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

const listenerCommand = Effect.fn("ServerProcessStartup.listenerCommand")(function* (
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

export const listenerProcessIds = Effect.fn("ServerProcessStartup.listenerProcessIds")(function* (
  port: number,
  candidates: ReadonlyArray<number> | "any",
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
  const allowed = candidates === "any" ? undefined : new Set(candidates)
  return [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && (allowed === undefined || allowed.has(pid))))]
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
        ServerService.ServerServiceError.make({
          reason: "foreign-listener",
          message: `Could not stop stale Rika server PID ${pid}: ${String(cause)}. Stop it, then run rika again`,
        }),
      )
    }
  })

const awaitServerRelease = (pid: number, port: number, attempts: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!(yield* processIsAlive(pid)) && !(yield* listenerIsLive(port))) return true
      yield* Effect.sleep("50 millis")
    }
    return !(yield* processIsAlive(pid)) && !(yield* listenerIsLive(port))
  })

export const supersede = Effect.fn("ServerProcessStartup.supersede")(function* (pid: number, port: number) {
  if (pid === process.pid)
    return yield* ServerService.ServerServiceError.make({
      reason: "foreign-listener",
      message: "Refusing to supersede the current Rika client process",
    })
  if (yield* awaitServerRelease(pid, port, 120)) return
  yield* signalProcess(pid, "SIGTERM")
  if (yield* awaitServerRelease(pid, port, 120)) return
  yield* signalProcess(pid, "SIGKILL")
  if (yield* awaitServerRelease(pid, port, 40)) return
  return yield* ServerService.ServerServiceError.make({
    reason: "foreign-listener",
    message: `Stale Rika server PID ${pid} kept port ${port}; stop it, then run rika again`,
  })
})
