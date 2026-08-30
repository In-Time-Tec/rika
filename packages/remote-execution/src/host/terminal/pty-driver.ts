import { Crypto, Deferred, Effect, Encoding, Fiber, Layer, Path, Ref, Scope, Semaphore, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { Fence, PtyCreate, PtyInput, PtyResize } from "../../protocol/messages"
import { Driver, OutputChunkLimit, PtyError, type Exit, type Output } from "./pty-types"

const fenceIdentity = (fence: Fence) =>
  `${fence.target}\0${fence.assignmentId}\0${fence.assignmentGeneration}\0${fence.instanceId}\0${fence.executorId}\0${fence.processIncarnation}`

export const controlOutput = (line: string): string | undefined => {
  if (!line.startsWith("%output ")) return undefined
  const separator = line.indexOf(" ", 8)
  if (separator < 0) return undefined
  const encoded = line.slice(separator + 1)
  const bytes: Array<number> = []
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === "\\" && encoded[index + 1] === "\\") {
      bytes.push("\\".charCodeAt(0))
      index += 1
      continue
    }
    if (encoded[index] === "\\" && /^[0-7]{3}/.test(encoded.slice(index + 1, index + 4))) {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 4), 8))
      index += 3
      continue
    }
    const value = new TextEncoder().encode(encoded[index])
    bytes.push(...value)
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

export const driverLayer = (options: {
  readonly fence: Fence
  readonly workspaceRoot: string
  readonly workspaceUser: string
}): Layer.Layer<Driver, PtyError, ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Path.Path> =>
  Layer.effect(
    Driver,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const crypto = yield* Crypto.Crypto
      const path = yield* Path.Path
      const scope = yield* Effect.scope
      const hash = Effect.fn("Pty.Driver.hash")(function* (value: string) {
        const digest = yield* crypto
          .digest("SHA-256", new TextEncoder().encode(value))
          .pipe(Effect.mapError(() => PtyError.make({ kind: "driver", message: "Could not identify tmux session" })))
        return Encoding.encodeHex(digest)
      })
      const fenceKey = fenceIdentity(options.fence)
      const socket = `rika-${(yield* hash(fenceKey)).slice(0, 40)}`
      const observers = yield* Ref.make(new Map<string, Fiber.Fiber<void, unknown>>())
      const observerLock = yield* Semaphore.make(1)

      const sessionName = (ptyId: string) => hash(`${fenceKey}\0${ptyId}`).pipe(Effect.map((digest) => `pty-${digest}`))
      const command = (args: ReadonlyArray<string>) =>
        ChildProcess.make("sudo", ["-n", "-u", options.workspaceUser, "tmux", "-L", socket, ...args])
      const run = Effect.fn("Pty.Driver.run")(function* (args: ReadonlyArray<string>) {
        const code = yield* spawner
          .exitCode(command(args))
          .pipe(Effect.mapError(() => PtyError.make({ kind: "driver", message: "Could not execute tmux" })))
        if (Number(code) !== 0)
          return yield* PtyError.make({ kind: "driver", message: `tmux ${args[0] ?? "command"} failed` })
      })
      const running = Effect.fn("Pty.Driver.running")(function* (ptyId: string) {
        const session = yield* sessionName(ptyId)
        const code = yield* spawner
          .exitCode(command(["has-session", "-t", session]))
          .pipe(Effect.mapError(() => PtyError.make({ kind: "driver", message: "Could not inspect tmux session" })))
        return Number(code) === 0
      })
      const observe = Effect.fn("Pty.Driver.observe")(function* (
        ptyId: string,
        args: ReadonlyArray<string>,
        output: Output,
        exit: Exit,
      ) {
        yield* observerLock.withPermits(1)(
          Effect.gen(function* () {
            if ((yield* Ref.get(observers)).has(ptyId)) return
            const ready = yield* Deferred.make<void, PtyError>()
            const gate = yield* Deferred.make<void>()
            const attached = yield* Ref.make(false)
            const observer = Effect.gen(function* () {
              yield* Deferred.await(gate)
              let controlArgs = args
              while (true) {
                const attempt = yield* Effect.scoped(
                  Effect.gen(function* () {
                    const handle = yield* spawner
                      .spawn(command(controlArgs))
                      .pipe(
                        Effect.mapError(() =>
                          PtyError.make({ kind: "driver", message: "Could not attach tmux session" }),
                        ),
                      )
                    yield* handle.stdout.pipe(
                      Stream.decodeText(),
                      Stream.splitLines,
                      Stream.runForEach((line) => {
                        if (line.startsWith("%session-changed "))
                          return Ref.set(attached, true).pipe(
                            Effect.andThen(Deferred.succeed(ready, undefined)),
                            Effect.asVoid,
                          )
                        const data = controlOutput(line)
                        if (data === undefined || data.length === 0) return Effect.void
                        return Effect.forEach(
                          Array.from({ length: Math.ceil(data.length / OutputChunkLimit) }, (_, index) =>
                            data.slice(index * OutputChunkLimit, (index + 1) * OutputChunkLimit),
                          ),
                          (chunk) => output(ptyId, chunk),
                          { discard: true },
                        )
                      }),
                      Effect.mapError(() => PtyError.make({ kind: "driver", message: "Could not read tmux output" })),
                    )
                  }),
                ).pipe(
                  Effect.match({
                    onFailure: (error) => ({ _tag: "Failure" as const, error }),
                    onSuccess: () => ({ _tag: "Success" as const }),
                  }),
                )
                if (!(yield* Ref.get(attached))) {
                  yield* Deferred.fail(
                    ready,
                    attempt._tag === "Failure"
                      ? attempt.error
                      : PtyError.make({ kind: "driver", message: `PTY ${ptyId} did not attach` }),
                  )
                  return
                }
                if (!(yield* running(ptyId))) {
                  yield* exit(ptyId)
                  return
                }
                controlArgs = ["-C", "attach-session", "-t", yield* sessionName(ptyId)]
                yield* Effect.sleep("100 millis")
              }
            }).pipe(
              Effect.ensuring(
                Ref.update(observers, (current) => {
                  const next = new Map(current)
                  next.delete(ptyId)
                  return next
                }),
              ),
            )
            const fiber = yield* Effect.forkIn(observer.pipe(Effect.provideService(Scope.Scope, scope)), scope, {
              startImmediately: false,
            })
            yield* Ref.update(observers, (current) => new Map(current).set(ptyId, fiber))
            yield* Deferred.succeed(gate, undefined)
            const readiness = yield* Deferred.await(ready).pipe(Effect.timeoutOption("5 seconds"))
            if (readiness._tag === "None") {
              yield* Fiber.interrupt(fiber)
              return yield* PtyError.make({ kind: "driver", message: `PTY ${ptyId} did not attach` })
            }
          }),
        )
      })

      const create = Effect.fn("Pty.Driver.create")(function* (request: PtyCreate, output: Output, exit: Exit) {
        const cwd = path.resolve(request.cwd)
        const root = path.resolve(options.workspaceRoot)
        if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`))
          return yield* PtyError.make({ kind: "protocol", message: "PTY working directory is outside the Workspace" })
        const session = yield* sessionName(request.ptyId)
        yield* observe(
          request.ptyId,
          [
            "-f",
            "/dev/null",
            "-C",
            "new-session",
            "-s",
            session,
            "-x",
            String(request.cols),
            "-y",
            String(request.rows),
            "-c",
            cwd,
            request.command,
          ],
          output,
          exit,
        ).pipe(Effect.tapError(() => run(["kill-session", "-t", session]).pipe(Effect.ignore)))
      })
      const input = Effect.fn("Pty.Driver.input")(function* (request: PtyInput) {
        const session = yield* sessionName(request.ptyId)
        yield* run(["send-keys", "-l", "-t", session, request.data])
      })
      const resize = Effect.fn("Pty.Driver.resize")(function* (request: PtyResize) {
        const session = yield* sessionName(request.ptyId)
        yield* run(["resize-window", "-t", session, "-x", String(request.cols), "-y", String(request.rows)])
      })
      const reconnect = Effect.fn("Pty.Driver.reconnect")(function* (ptyId: string, output: Output, exit: Exit) {
        if (!(yield* running(ptyId)))
          return yield* PtyError.make({ kind: "missing", message: `PTY ${ptyId} process is not running` })
        const session = yield* sessionName(ptyId)
        yield* observe(ptyId, ["-C", "attach-session", "-t", session], output, exit)
      })
      const terminate = Effect.fn("Pty.Driver.terminate")(function* (ptyId: string) {
        const session = yield* sessionName(ptyId)
        yield* run(["kill-session", "-t", session])
      })

      return Driver.of({ create, input, resize, reconnect, terminate })
    }),
  )

export const detectCapabilities = (
  check: (command: string, args: ReadonlyArray<string>) => Effect.Effect<boolean>,
): Effect.Effect<{
  readonly cells: true
  readonly checkpoints: false
  readonly pty: boolean
  readonly browser: boolean
  readonly services: boolean
}> =>
  Effect.gen(function* () {
    const [tmux, chromium, agentBrowser, services] = yield* Effect.all([
      check("tmux", ["-V"]),
      check("chromium", ["--version"]),
      check("agent-browser", ["--version"]),
      check("true", []),
    ])
    return {
      cells: true,
      checkpoints: false,
      pty: tmux,
      browser: chromium && agentBrowser,
      services,
    }
  })

export const liveCapabilities = (
  workspaceUser: string,
): Effect.Effect<
  {
    readonly cells: true
    readonly checkpoints: false
    readonly pty: boolean
    readonly browser: boolean
    readonly services: boolean
  },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* detectCapabilities((executable, args) =>
      spawner.exitCode(ChildProcess.make("sudo", ["-n", "-u", workspaceUser, executable, ...args])).pipe(
        Effect.map((code) => Number(code) === 0),
        Effect.orElseSucceed(() => false),
      ),
    )
  })
