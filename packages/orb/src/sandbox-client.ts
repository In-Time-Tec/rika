import { Config } from "@rika/core"
import { Ids } from "@rika/schema"
import { CommandExitError, Sandbox, type CommandHandle, type CommandResult, type SandboxInfo } from "e2b"
import { Cause, Context, Effect, Layer, Queue, Schema, Stream } from "effect"

export interface SandboxMetadata extends Record<string, string> {
  readonly thread_id: Ids.ThreadId
  readonly project_id: Ids.ProjectId
}

export interface CreateInput {
  readonly templateId: string
  readonly envs: Record<string, string>
  readonly metadata: Record<string, string>
  readonly timeoutMs: number
}

export interface ExecOptions {
  readonly cwd?: string
  readonly envs?: Record<string, string>
  readonly background?: boolean
}

export type ExecChunk =
  | {
      readonly type: "stdout"
      readonly data: string
    }
  | {
      readonly type: "stderr"
      readonly data: string
    }
  | {
      readonly type: "exit"
      readonly exitCode: number
    }
  | {
      readonly type: "started"
      readonly pid: number
    }

export interface SandboxSummary {
  readonly sandboxId: string
  readonly templateId: string
  readonly metadata: Record<string, string>
  readonly state: "running" | "paused"
}

export interface ListFilter {
  readonly metadata: Record<string, string>
}

export class SandboxClientError extends Schema.TaggedErrorClass<SandboxClientError>()("SandboxClientError", {
  message: Schema.String,
  operation: Schema.String,
  sandboxId: Schema.optional(Schema.String),
}) {}

export class OrbConfigError extends Schema.TaggedErrorClass<OrbConfigError>()("OrbConfigError", {
  message: Schema.String,
  key: Schema.String,
}) {}

export type RunError = SandboxClientError | OrbConfigError
type ExecQueue = Queue.Queue<ExecChunk, SandboxClientError | Cause.Done>

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<{ readonly sandboxId: string }, RunError>
  readonly exec: (
    sandboxId: string,
    cmd: ReadonlyArray<string>,
    opts: ExecOptions,
  ) => Stream.Stream<ExecChunk, SandboxClientError>
  readonly writeFile: (sandboxId: string, path: string, bytes: Uint8Array) => Effect.Effect<void, SandboxClientError>
  readonly readFile: (sandboxId: string, path: string) => Effect.Effect<Uint8Array, SandboxClientError>
  readonly hostUrl: (sandboxId: string, port: number) => Effect.Effect<string, SandboxClientError>
  readonly pause: (sandboxId: string) => Effect.Effect<void, SandboxClientError>
  readonly resume: (sandboxId: string) => Effect.Effect<void, SandboxClientError>
  readonly kill: (sandboxId: string) => Effect.Effect<void, SandboxClientError>
  readonly setTimeout: (sandboxId: string, ms: number) => Effect.Effect<void, SandboxClientError>
  readonly list: (filter?: ListFilter) => Effect.Effect<ReadonlyArray<SandboxSummary>, SandboxClientError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/orb/SandboxClient") {}

export const layer: Layer.Layer<Service, OrbConfigError, Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const apiKey = yield* config.requireEnv("E2B_API_KEY").pipe(
      Effect.mapError(
        (error) =>
          new OrbConfigError({
            message: error.message,
            key: error.key ?? "E2B_API_KEY",
          }),
      ),
    )

    return makeLive(apiKey)
  }),
)

export const create = Effect.fn("SandboxClient.create.call")(function* (input: CreateInput) {
  const service = yield* Service
  return yield* service.create(input)
})

export const exec = (sandboxId: string, cmd: ReadonlyArray<string>, opts: ExecOptions = {}) =>
  Stream.unwrap(Effect.map(Service, (service) => service.exec(sandboxId, cmd, opts)))

export const writeFile = Effect.fn("SandboxClient.writeFile.call")(function* (
  sandboxId: string,
  path: string,
  bytes: Uint8Array,
) {
  const service = yield* Service
  return yield* service.writeFile(sandboxId, path, bytes)
})

export const readFile = Effect.fn("SandboxClient.readFile.call")(function* (sandboxId: string, path: string) {
  const service = yield* Service
  return yield* service.readFile(sandboxId, path)
})

export const hostUrl = Effect.fn("SandboxClient.hostUrl.call")(function* (sandboxId: string, port: number) {
  const service = yield* Service
  return yield* service.hostUrl(sandboxId, port)
})

export const pause = Effect.fn("SandboxClient.pause.call")(function* (sandboxId: string) {
  const service = yield* Service
  return yield* service.pause(sandboxId)
})

export const resume = Effect.fn("SandboxClient.resume.call")(function* (sandboxId: string) {
  const service = yield* Service
  return yield* service.resume(sandboxId)
})

export const kill = Effect.fn("SandboxClient.kill.call")(function* (sandboxId: string) {
  const service = yield* Service
  return yield* service.kill(sandboxId)
})

export const setTimeout = Effect.fn("SandboxClient.setTimeout.call")(function* (sandboxId: string, ms: number) {
  const service = yield* Service
  return yield* service.setTimeout(sandboxId, ms)
})

export const list = Effect.fn("SandboxClient.list.call")(function* (filter?: ListFilter) {
  const service = yield* Service
  return yield* service.list(filter)
})

export const validateCreateInput = (input: CreateInput): Effect.Effect<void, SandboxClientError> => {
  const missing = ["thread_id", "project_id"].filter((key) => {
    const value = input.metadata[key]
    return value === undefined || value.length === 0
  })
  if (missing.length === 0) return Effect.void
  return new SandboxClientError({
    message: `Missing sandbox metadata ${missing.join(", ")}`,
    operation: "create",
  })
}

export const encodeArgvForShell = (
  cmd: ReadonlyArray<string>,
  sandboxId?: string,
): Effect.Effect<string, SandboxClientError> => {
  if (cmd.length === 0) {
    return new SandboxClientError({
      message: "Sandbox exec command cannot be empty",
      operation: "exec",
      ...(sandboxId === undefined ? {} : { sandboxId }),
    })
  }
  return Effect.succeed(cmd.map(shellQuote).join(" "))
}

export const urlFromHost = (host: string) => (/^https?:\/\//.test(host) ? host : `https://${host}`)

const makeLive = (apiKey: string): Interface =>
  Service.of({
    create: Effect.fn("SandboxClient.create")(function* (input: CreateInput) {
      yield* validateCreateInput(input)
      const sandbox = yield* tryPromise("create", () =>
        Sandbox.create(input.templateId, {
          apiKey,
          envs: input.envs,
          metadata: input.metadata,
          timeoutMs: input.timeoutMs,
        }),
      )
      return { sandboxId: sandbox.sandboxId }
    }),
    exec: (sandboxId: string, cmd: ReadonlyArray<string>, opts: ExecOptions) =>
      Stream.callback<ExecChunk, SandboxClientError>(
        (queue) =>
          Effect.gen(function* () {
            const emitted = { stdout: false, stderr: false }
            yield* Effect.gen(function* () {
              const command = yield* encodeArgvForShell(cmd, sandboxId)
              const sandbox = yield* connect(apiKey, sandboxId, "exec")
              const result = yield* runCommand(sandbox, sandboxId, command, opts, queue, emitted)
              if (result.type === "started") {
                yield* Queue.offer(queue, { type: "started", pid: result.pid }).pipe(Effect.asVoid)
                return
              }
              yield* offerMissingOutput(queue, emitted, result.result)
              yield* Queue.offer(queue, { type: "exit", exitCode: result.result.exitCode }).pipe(Effect.asVoid)
            }).pipe(
              Effect.catch((error) => Queue.fail(queue, error).pipe(Effect.asVoid)),
              Effect.ensuring(Queue.end(queue).pipe(Effect.ignore)),
              Effect.forkScoped,
            )
          }),
        { bufferSize: 64, strategy: "suspend" },
      ),
    writeFile: Effect.fn("SandboxClient.writeFile")(function* (sandboxId: string, path: string, bytes: Uint8Array) {
      const sandbox = yield* connect(apiKey, sandboxId, "writeFile")
      yield* tryPromise("writeFile", () => sandbox.files.write(path, new Blob([bytes])), sandboxId)
    }),
    readFile: Effect.fn("SandboxClient.readFile")(function* (sandboxId: string, path: string) {
      const sandbox = yield* connect(apiKey, sandboxId, "readFile")
      return yield* tryPromise("readFile", () => sandbox.files.read(path, { format: "bytes" }), sandboxId)
    }),
    hostUrl: Effect.fn("SandboxClient.hostUrl")(function* (sandboxId: string, port: number) {
      const sandbox = yield* connect(apiKey, sandboxId, "hostUrl")
      return urlFromHost(sandbox.getHost(port))
    }),
    pause: Effect.fn("SandboxClient.pause")(function* (sandboxId: string) {
      yield* tryPromise("pause", () => Sandbox.pause(sandboxId, { apiKey }), sandboxId)
    }),
    resume: Effect.fn("SandboxClient.resume")(function* (sandboxId: string) {
      yield* connect(apiKey, sandboxId, "resume")
    }),
    kill: Effect.fn("SandboxClient.kill")(function* (sandboxId: string) {
      yield* tryPromise("kill", () => Sandbox.kill(sandboxId, { apiKey }), sandboxId)
    }),
    setTimeout: Effect.fn("SandboxClient.setTimeout")(function* (sandboxId: string, ms: number) {
      yield* tryPromise("setTimeout", () => Sandbox.setTimeout(sandboxId, ms, { apiKey }), sandboxId)
    }),
    list: Effect.fn("SandboxClient.list")(function* (filter?: ListFilter) {
      return yield* tryPromise("list", async () => {
        const paginator = Sandbox.list(
          filter === undefined
            ? { apiKey }
            : {
                apiKey,
                query: { metadata: filter.metadata },
              },
        )
        const sandboxes: Array<SandboxSummary> = []
        while (paginator.hasNext) {
          const items = await paginator.nextItems()
          sandboxes.push(...items.map(sandboxSummaryFromInfo))
        }
        return sandboxes
      })
    }),
  })

const connect = (apiKey: string, sandboxId: string, operation: string) =>
  tryPromise(operation, () => Sandbox.connect(sandboxId, { apiKey }), sandboxId)

const runCommand = (
  sandbox: Sandbox,
  sandboxId: string,
  command: string,
  opts: ExecOptions,
  queue: ExecQueue,
  emitted: { stdout: boolean; stderr: boolean },
): Effect.Effect<
  { readonly type: "completed"; readonly result: CommandResult } | { readonly type: "started"; readonly pid: number },
  SandboxClientError
> =>
  tryPromise(
    "exec",
    async () => {
      try {
        const base = {
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          ...(opts.envs === undefined ? {} : { envs: opts.envs }),
        }
        const result =
          opts.background === true
            ? await sandbox.commands.run(command, { ...base, background: true })
            : await sandbox.commands.run(command, {
                ...base,
                onStdout: (data) => {
                  emitted.stdout = true
                  return Effect.runPromise(Queue.offer(queue, { type: "stdout", data }).pipe(Effect.asVoid))
                },
                onStderr: (data) => {
                  emitted.stderr = true
                  return Effect.runPromise(Queue.offer(queue, { type: "stderr", data }).pipe(Effect.asVoid))
                },
              })
        if (isCommandHandle(result)) {
          const pid = result.pid
          await result.disconnect()
          return { type: "started", pid }
        }
        return { type: "completed", result }
      } catch (error) {
        if (error instanceof CommandExitError) {
          return { type: "completed", result: commandResultFromExitError(error) }
        }
        throw error
      }
    },
    sandboxId,
  )

const offerMissingOutput = (queue: ExecQueue, emitted: { stdout: boolean; stderr: boolean }, result: CommandResult) => {
  const stdout =
    result.stdout.length > 0 && !emitted.stdout ? Queue.offer(queue, stdoutChunk(result.stdout)) : Effect.void
  const stderr =
    result.stderr.length > 0 && !emitted.stderr ? Queue.offer(queue, stderrChunk(result.stderr)) : Effect.void
  return stdout.pipe(Effect.andThen(stderr), Effect.asVoid)
}

const stdoutChunk = (data: string): ExecChunk => ({ type: "stdout", data })

const stderrChunk = (data: string): ExecChunk => ({ type: "stderr", data })

const isCommandHandle = (value: CommandHandle | CommandResult): value is CommandHandle =>
  "wait" in value && typeof value.wait === "function"

const commandResultFromExitError = (error: CommandExitError): CommandResult => ({
  exitCode: error.exitCode,
  stdout: error.stdout,
  stderr: error.stderr,
  ...(error.error === undefined ? {} : { error: error.error }),
})

const sandboxSummaryFromInfo = (info: SandboxInfo): SandboxSummary => ({
  sandboxId: info.sandboxId,
  templateId: info.templateId,
  metadata: info.metadata,
  state: info.state,
})

const shellQuote = (value: string): string => {
  if (value.length === 0) return "''"
  if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

const tryPromise = <A>(
  operation: string,
  run: () => Promise<A>,
  sandboxId?: string,
): Effect.Effect<A, SandboxClientError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => sandboxClientError(operation, cause, sandboxId),
  })

const sandboxClientError = (operation: string, cause: unknown, sandboxId?: string) =>
  new SandboxClientError({
    message: messageFromUnknown(cause),
    operation,
    ...(sandboxId === undefined ? {} : { sandboxId }),
  })

const messageFromUnknown = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
