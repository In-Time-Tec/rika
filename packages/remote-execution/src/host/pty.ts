import {
  Context,
  Crypto,
  Deferred,
  Effect,
  Encoding,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  PtyCreate,
  PtyTranscriptChunk,
  type Fence,
  type PtyGap,
  type PtyInput,
  type PtyReconnect,
  type PtyResize,
} from "../protocol/messages"

export const TranscriptLimit = 256
export const OutputChunkLimit = 16_384

const StoredRecord = Schema.Struct({
  ...PtyCreate.fields,
  connected: Schema.Boolean,
  terminated: Schema.Boolean,
  cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  transcript: Schema.Array(PtyTranscriptChunk),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  records: Schema.Array(StoredRecord),
})

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot))
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Snapshot))

export interface Record extends PtyCreate {
  readonly connected: boolean
  readonly terminated: boolean
  readonly cursor: number
  readonly transcript: ReadonlyArray<PtyTranscriptChunk>
  readonly revision: number
}

export interface Connection extends PtyCreate {
  readonly connected: boolean
  readonly terminated: boolean
  readonly cursor: number
  readonly transcript: ReadonlyArray<PtyTranscriptChunk>
  readonly gap: PtyGap | null
}

export type Event =
  | { readonly _tag: "Output"; readonly ptyId: string; readonly chunk: PtyTranscriptChunk }
  | { readonly _tag: "Terminated"; readonly ptyId: string; readonly cursor: number }

export class PtyError extends Schema.TaggedError<PtyError>()("PtyError", {
  kind: Schema.Literals(["conflict", "driver", "missing", "protocol", "storage"]),
  message: Schema.String,
}) {}

export interface RepositoryInterface {
  readonly get: (ptyId: string) => Effect.Effect<Record | undefined, PtyError>
  readonly list: Effect.Effect<ReadonlyArray<Record>, PtyError>
  readonly insert: (record: Record) => Effect.Effect<Record, PtyError>
  readonly update: (record: Record, expectedRevision: number) => Effect.Effect<Record, PtyError>
}

export class Repository extends Context.Service<Repository, RepositoryInterface>()(
  "@rika/remote-execution/host/pty/Repository",
) {}

type Output = (ptyId: string, data: string) => Effect.Effect<void, PtyError>
type Exit = (ptyId: string) => Effect.Effect<void, PtyError>

export interface DriverInterface {
  readonly create: (request: PtyCreate, output: Output, exit: Exit) => Effect.Effect<void, PtyError>
  readonly input: (request: PtyInput) => Effect.Effect<void, PtyError>
  readonly resize: (request: PtyResize) => Effect.Effect<void, PtyError>
  readonly reconnect: (ptyId: string, output: Output, exit: Exit) => Effect.Effect<void, PtyError>
  readonly terminate: (ptyId: string) => Effect.Effect<void, PtyError>
}

export class Driver extends Context.Service<Driver, DriverInterface>()("@rika/remote-execution/host/pty/Driver") {}

export interface Interface {
  readonly create: (request: PtyCreate) => Effect.Effect<Connection, PtyError>
  readonly input: (request: PtyInput) => Effect.Effect<void, PtyError>
  readonly resize: (request: PtyResize) => Effect.Effect<Connection, PtyError>
  readonly disconnect: (ptyId: string) => Effect.Effect<Connection, PtyError>
  readonly disconnectAll: Effect.Effect<void, PtyError>
  readonly reconnect: (request: PtyReconnect) => Effect.Effect<Connection, PtyError>
  readonly terminate: (ptyId: string) => Effect.Effect<Connection, PtyError>
  readonly recordOutput: (ptyId: string, data: string) => Effect.Effect<PtyTranscriptChunk, PtyError>
  readonly cursor: Effect.Effect<number, PtyError>
  readonly events: Stream.Stream<Event>
}

export class Manager extends Context.Service<Manager, Interface>()("@rika/remote-execution/host/pty/Manager") {}

const connection = (
  record: Record,
  transcript: ReadonlyArray<PtyTranscriptChunk> = record.transcript,
  gap: PtyGap | null = null,
): Connection => ({
  ptyId: record.ptyId,
  command: record.command,
  cwd: record.cwd,
  cols: record.cols,
  rows: record.rows,
  connected: record.connected,
  terminated: record.terminated,
  cursor: record.cursor,
  transcript,
  gap,
})

const sameCreate = (record: Record, request: PtyCreate) =>
  record.command === request.command && record.cwd === request.cwd

export const layer: Layer.Layer<Manager, never, Driver | Repository> = Layer.effect(
  Manager,
  Effect.gen(function* () {
    const repository = yield* Repository
    const driver = yield* Driver
    const operation = yield* Semaphore.make(1)
    const changes = yield* PubSub.bounded<Event>(TranscriptLimit)

    const load = Effect.fn("Pty.load")(function* (ptyId: string) {
      const record = yield* repository.get(ptyId)
      if (record === undefined) return yield* PtyError.make({ kind: "missing", message: `PTY ${ptyId} does not exist` })
      return record
    })

    const recordOutput = Effect.fn("Pty.recordOutput")(function* (ptyId: string, data: string) {
      if (data.length > OutputChunkLimit)
        return yield* PtyError.make({ kind: "protocol", message: `PTY ${ptyId} output chunk exceeds the limit` })
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(ptyId)
          if (record.terminated)
            return yield* PtyError.make({ kind: "protocol", message: `PTY ${ptyId} is terminated` })
          const chunk = { cursor: record.cursor + 1, data }
          const transcript = [...record.transcript, chunk].slice(-TranscriptLimit)
          const updated = yield* repository.update({ ...record, cursor: chunk.cursor, transcript }, record.revision)
          if (updated.connected) yield* PubSub.publish(changes, { _tag: "Output", ptyId, chunk })
          return chunk
        }),
      )
    })

    const recordExit = Effect.fn("Pty.recordExit")(function* (ptyId: string) {
      yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(ptyId)
          if (record.terminated) return
          const updated = yield* repository.update({ ...record, connected: false, terminated: true }, record.revision)
          yield* PubSub.publish(changes, { _tag: "Terminated", ptyId, cursor: updated.cursor })
        }),
      )
    })

    const output: Output = (ptyId, data) => recordOutput(ptyId, data).pipe(Effect.asVoid)
    const exit: Exit = recordExit

    const create = Effect.fn("Pty.create")(function* (request: PtyCreate) {
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* repository.get(request.ptyId)
          if (existing !== undefined) {
            if (!sameCreate(existing, request))
              return yield* PtyError.make({
                kind: "conflict",
                message: `PTY ${request.ptyId} already has different settings`,
              })
            if (existing.terminated) return connection(existing)
            yield* driver.reconnect(existing.ptyId, output, exit)
            return connection(
              existing.connected
                ? existing
                : yield* repository.update({ ...existing, connected: true }, existing.revision),
            )
          }
          const gate = yield* Deferred.make<void>()
          yield* driver.create(
            request,
            (ptyId, data) => Deferred.await(gate).pipe(Effect.andThen(output(ptyId, data))),
            (ptyId) => Deferred.await(gate).pipe(Effect.andThen(exit(ptyId))),
          )
          const record = yield* repository.insert({
            ...request,
            connected: true,
            terminated: false,
            cursor: 0,
            transcript: [],
            revision: 0,
          })
          yield* Deferred.succeed(gate, undefined)
          return connection(record)
        }),
      )
    })

    const input = Effect.fn("Pty.input")(function* (request: PtyInput) {
      yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(request.ptyId)
          if (!record.connected || record.terminated)
            return yield* PtyError.make({ kind: "protocol", message: `PTY ${request.ptyId} is not connected` })
          yield* driver.input(request)
        }),
      )
    })

    const resize = Effect.fn("Pty.resize")(function* (request: PtyResize) {
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(request.ptyId)
          if (!record.connected || record.terminated)
            return yield* PtyError.make({ kind: "protocol", message: `PTY ${request.ptyId} is not connected` })
          if (record.cols === request.cols && record.rows === request.rows) return connection(record)
          yield* driver.resize(request)
          return connection(
            yield* repository.update({ ...record, cols: request.cols, rows: request.rows }, record.revision),
          )
        }),
      )
    })

    const disconnect = Effect.fn("Pty.disconnect")(function* (ptyId: string) {
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(ptyId)
          if (!record.connected) return connection(record)
          return connection(yield* repository.update({ ...record, connected: false }, record.revision))
        }),
      )
    })

    const disconnectAll = operation.withPermits(1)(
      Effect.gen(function* () {
        for (const record of yield* repository.list) {
          if (record.connected && !record.terminated)
            yield* repository.update({ ...record, connected: false }, record.revision)
        }
      }),
    )

    const reconnect = Effect.fn("Pty.reconnect")(function* (request: PtyReconnect) {
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(request.ptyId)
          if (record.terminated)
            return yield* PtyError.make({ kind: "protocol", message: `PTY ${request.ptyId} is terminated` })
          if (request.cursor > record.cursor)
            return yield* PtyError.make({
              kind: "protocol",
              message: `PTY ${request.ptyId} cursor is ahead of transcript`,
            })
          yield* driver.reconnect(request.ptyId, output, exit)
          const active = record.connected
            ? record
            : yield* repository.update({ ...record, connected: true }, record.revision)
          const first = active.transcript[0]?.cursor ?? active.cursor + 1
          const gap = request.cursor + 1 < first ? { fromCursor: request.cursor + 1, toCursor: first - 1 } : null
          return connection(
            active,
            active.transcript.filter((chunk) => chunk.cursor > request.cursor),
            gap,
          )
        }),
      )
    })

    const terminate = Effect.fn("Pty.terminate")(function* (ptyId: string) {
      return yield* operation.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* load(ptyId)
          if (record.terminated) return connection(record)
          yield* driver.terminate(ptyId)
          const updated = yield* repository.update({ ...record, connected: false, terminated: true }, record.revision)
          return connection(updated)
        }),
      )
    })

    const cursor = Effect.map(repository.list, (records) =>
      records.reduce((latest, record) => Math.max(latest, record.cursor), 0),
    )
    const events = Stream.fromPubSub(changes)

    return Manager.of({
      create,
      input,
      resize,
      disconnect,
      disconnectAll,
      reconnect,
      terminate,
      recordOutput,
      cursor,
      events,
    })
  }),
)

const directoryMode = 0o700
const fileMode = 0o600

const digestName = Effect.fn("Pty.digestName")(function* (value: string) {
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(value))
    .pipe(Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not identify PTY state" })))
  return Encoding.encodeHex(digest)
})

const fenceIdentity = (fence: Fence) =>
  `${fence.target}\0${fence.assignmentId}\0${fence.assignmentGeneration}\0${fence.instanceId}\0${fence.executorId}\0${fence.processIncarnation}`

export const repositoryLayer = (options: {
  readonly stateDirectory: string
  readonly fence: Fence
}): Layer.Layer<Repository, PtyError, Crypto.Crypto | FileSystem.FileSystem> =>
  Layer.effect(
    Repository,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const assignment = yield* digestName(fenceIdentity(options.fence))
      const directory = `${options.stateDirectory}/pty`
      const filename = `${directory}/assignment-${assignment}.json`
      const lock = yield* Semaphore.make(1)
      const secureDirectory = fileSystem.makeDirectory(directory, { recursive: true, mode: directoryMode }).pipe(
        Effect.andThen(fileSystem.chmod(directory, directoryMode)),
        Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not secure PTY state" })),
      )
      const exists = yield* secureDirectory.pipe(
        Effect.andThen(fileSystem.exists(filename)),
        Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not inspect PTY state" })),
      )
      const loaded = exists
        ? yield* fileSystem.chmod(filename, fileMode).pipe(
            Effect.andThen(fileSystem.readFileString(filename)),
            Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not read PTY state" })),
            Effect.flatMap((text) =>
              decodeSnapshot(text).pipe(
                Effect.mapError(() => PtyError.make({ kind: "storage", message: "PTY state is invalid" })),
              ),
            ),
          )
        : { version: 1 as const, records: [] }
      const records = yield* Ref.make(
        new Map(loaded.records.map((record) => [record.ptyId, record as Record] as const)),
      )

      const persist = Effect.fn("Pty.Repository.persist")(function* (next: Map<string, Record>) {
        const temporary = `${filename}.tmp-${process.pid}`
        const text = yield* encodeSnapshot({ version: 1, records: [...next.values()] }).pipe(
          Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not encode PTY state" })),
        )
        yield* secureDirectory
        yield* fileSystem.writeFileString(temporary, text, { mode: fileMode }).pipe(
          Effect.andThen(fileSystem.chmod(temporary, fileMode)),
          Effect.andThen(fileSystem.rename(temporary, filename)),
          Effect.andThen(fileSystem.chmod(filename, fileMode)),
          Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
          Effect.mapError(() => PtyError.make({ kind: "storage", message: "Could not persist PTY state" })),
        )
        yield* Ref.set(records, next)
      })

      const get = (ptyId: string) => Effect.map(Ref.get(records), (current) => current.get(ptyId))
      const list = Effect.map(Ref.get(records), (current) => [...current.values()])
      const insert = Effect.fn("Pty.Repository.insert")(function* (record: Record) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(records)
            if (current.has(record.ptyId))
              return yield* PtyError.make({ kind: "conflict", message: `PTY ${record.ptyId} already exists` })
            const next = new Map(current).set(record.ptyId, record)
            yield* persist(next)
            return record
          }),
        )
      })
      const update = Effect.fn("Pty.Repository.update")(function* (record: Record, expectedRevision: number) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(records)
            const known = current.get(record.ptyId)
            if (known === undefined)
              return yield* PtyError.make({ kind: "missing", message: `PTY ${record.ptyId} does not exist` })
            if (known.revision !== expectedRevision)
              return yield* PtyError.make({ kind: "conflict", message: `PTY ${record.ptyId} revision is stale` })
            const updated = { ...record, revision: expectedRevision + 1 }
            const next = new Map(current).set(record.ptyId, updated)
            yield* persist(next)
            return updated
          }),
        )
      })

      return Repository.of({ get, list, insert, update })
    }),
  )

const controlOutput = (line: string): string | undefined => {
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
    const value = new TextEncoder().encode(encoded[index]!)
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

export const testing = { controlOutput, digestName } as const
