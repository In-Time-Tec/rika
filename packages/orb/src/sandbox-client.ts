import { Config } from "@rika/core"
import { Ids } from "@rika/schema"
import {
  CommandExitError,
  Sandbox,
  Template,
  type CommandHandle,
  type CommandResult,
  type SandboxInfo,
  type SandboxLifecycle as E2bSandboxLifecycle,
} from "e2b"
import { Cause, Context, Effect, Exit, Layer, Queue, Redacted, Schema, Stream } from "effect"

export interface SandboxMetadata extends Record<string, string> {
  readonly thread_id: Ids.ThreadId
  readonly project_id: Ids.ProjectId
}

export interface CreateInput {
  readonly templateId: string
  readonly envs: Record<string, string>
  readonly metadata: Record<string, string>
  readonly timeoutMs: number
  readonly lifecycle?: SandboxLifecycle
}

export type SandboxLifecycle =
  | {
      readonly onTimeout: "pause"
      readonly autoResume?: boolean
    }
  | {
      readonly onTimeout: "kill"
      readonly autoResume?: false
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
  ) => Stream.Stream<ExecChunk, RunError>
  readonly writeFile: (sandboxId: string, path: string, bytes: Uint8Array) => Effect.Effect<void, RunError>
  readonly readFile: (sandboxId: string, path: string) => Effect.Effect<Uint8Array, RunError>
  readonly hostUrl: (sandboxId: string, port: number) => Effect.Effect<string, RunError>
  readonly pause: (sandboxId: string) => Effect.Effect<void, RunError>
  readonly resume: (sandboxId: string) => Effect.Effect<void, RunError>
  readonly kill: (sandboxId: string) => Effect.Effect<void, RunError>
  readonly setTimeout: (sandboxId: string, ms: number) => Effect.Effect<void, RunError>
  readonly list: (filter?: ListFilter) => Effect.Effect<ReadonlyArray<SandboxSummary>, RunError>
  readonly templateExists: (templateId: string) => Effect.Effect<boolean, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/orb/SandboxClient") {}

export const layer: Layer.Layer<Service, OrbConfigError, Config.Service> = Layer.effect(
  Service,
  Effect.map(Config.Service, (config) => makeLiveFromConfig(config)),
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

export const templateExists = Effect.fn("SandboxClient.templateExists.call")(function* (templateId: string) {
  const service = yield* Service
  return yield* service.templateExists(templateId)
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

const makeLive = (apiKey: Redacted.Redacted): Interface =>
  Service.of({
    create: Effect.fn("SandboxClient.create")(function* (input: CreateInput) {
      yield* validateCreateInput(input)
      const sandbox = yield* tryPromise("create", () =>
        Sandbox.create(input.templateId, {
          apiKey: Redacted.value(apiKey),
          envs: input.envs,
          metadata: input.metadata,
          timeoutMs: input.timeoutMs,
          ...(input.lifecycle === undefined ? {} : { lifecycle: toE2bLifecycle(input.lifecycle) }),
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
      yield* tryPromise("pause", () => Sandbox.pause(sandboxId, { apiKey: Redacted.value(apiKey) }), sandboxId)
    }),
    resume: Effect.fn("SandboxClient.resume")(function* (sandboxId: string) {
      yield* connect(apiKey, sandboxId, "resume")
    }),
    kill: Effect.fn("SandboxClient.kill")(function* (sandboxId: string) {
      yield* tryPromise("kill", () => Sandbox.kill(sandboxId, { apiKey: Redacted.value(apiKey) }), sandboxId)
    }),
    setTimeout: Effect.fn("SandboxClient.setTimeout")(function* (sandboxId: string, ms: number) {
      yield* tryPromise(
        "setTimeout",
        () => Sandbox.setTimeout(sandboxId, ms, { apiKey: Redacted.value(apiKey) }),
        sandboxId,
      )
    }),
    list: Effect.fn("SandboxClient.list")(function* (filter?: ListFilter) {
      return yield* tryPromise("list", async () => {
        const paginator = Sandbox.list(
          filter === undefined
            ? { apiKey: Redacted.value(apiKey) }
            : {
                apiKey: Redacted.value(apiKey),
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
    templateExists: Effect.fn("SandboxClient.templateExists")(function* (templateId: string) {
      return yield* tryPromise("templateExists", () => Template.exists(templateId, { apiKey: Redacted.value(apiKey) }))
    }),
  })

const makeLiveFromConfig = (config: Config.Interface): Interface =>
  Service.of({
    create: (input) => apiKeyFromConfig(config).pipe(Effect.flatMap((apiKey) => makeLive(apiKey).create(input))),
    exec: (sandboxId, cmd, opts) =>
      Stream.unwrap(apiKeyFromConfig(config).pipe(Effect.map((apiKey) => makeLive(apiKey).exec(sandboxId, cmd, opts)))),
    writeFile: (sandboxId, path, bytes) =>
      apiKeyFromConfig(config).pipe(Effect.flatMap((apiKey) => makeLive(apiKey).writeFile(sandboxId, path, bytes))),
    readFile: (sandboxId, path) =>
      apiKeyFromConfig(config).pipe(Effect.flatMap((apiKey) => makeLive(apiKey).readFile(sandboxId, path))),
    hostUrl: (sandboxId, port) =>
      apiKeyFromConfig(config).pipe(Effect.flatMap((apiKey) => makeLive(apiKey).hostUrl(sandboxId, port))),
    pause: (sandboxId) => apiKeyFromConfig(config).pipe(Effect.flatMap((apiKey) => makeLive(apiKey).pause(sandboxId))),
    resume: (sandboxId) =>
      apiKeyFromConfig(config).pipe(Effect.flatMap((apiKey) => makeLive(apiKey).resume(sandboxId))),
    kill: (sandboxId) => apiKeyFromConfig(config).pipe(Effect.flatMap((apiKey) => makeLive(apiKey).kill(sandboxId))),
    setTimeout: (sandboxId, ms) =>
      apiKeyFromConfig(config).pipe(Effect.flatMap((apiKey) => makeLive(apiKey).setTimeout(sandboxId, ms))),
    list: (filter) => apiKeyFromConfig(config).pipe(Effect.flatMap((apiKey) => makeLive(apiKey).list(filter))),
    templateExists: (templateId) =>
      apiKeyFromConfig(config).pipe(Effect.flatMap((apiKey) => makeLive(apiKey).templateExists(templateId))),
  })

const apiKeyFromConfig = (config: Config.Interface) =>
  config.requireSecret("E2B_API_KEY").pipe(
    Effect.mapError(
      (error) =>
        new OrbConfigError({
          message: error.message,
          key: error.key ?? "E2B_API_KEY",
        }),
    ),
  )

const toE2bLifecycle = (lifecycle: SandboxLifecycle): E2bSandboxLifecycle => ({
  onTimeout: lifecycle.onTimeout,
  ...(lifecycle.autoResume === undefined ? {} : { autoResume: lifecycle.autoResume }),
})

const connect = (apiKey: Redacted.Redacted, sandboxId: string, operation: string) =>
  tryPromise(operation, () => Sandbox.connect(sandboxId, { apiKey: Redacted.value(apiKey) }), sandboxId)

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
  opts.background === true
    ? runBackgroundCommand(sandbox, sandboxId, command, opts)
    : runForegroundCommand(sandbox, sandboxId, command, opts, queue, emitted)

const commandBaseOptions = (opts: ExecOptions, signal: AbortSignal) => ({
  ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  ...(opts.envs === undefined ? {} : { envs: opts.envs }),
  signal,
})

const runBackgroundCommand = (
  sandbox: Sandbox,
  sandboxId: string,
  command: string,
  opts: ExecOptions,
): Effect.Effect<{ readonly type: "started"; readonly pid: number }, SandboxClientError> =>
  tryPromise(
    "exec",
    async (signal) => {
      const result = await sandbox.commands.run(command, { ...commandBaseOptions(opts, signal), background: true })
      const pid = result.pid
      await result.disconnect()
      return { type: "started", pid }
    },
    sandboxId,
  )

const runForegroundCommand = (
  sandbox: Sandbox,
  sandboxId: string,
  command: string,
  opts: ExecOptions,
  queue: ExecQueue,
  emitted: { stdout: boolean; stderr: boolean },
): Effect.Effect<{ readonly type: "completed"; readonly result: CommandResult }, SandboxClientError> =>
  Effect.acquireUseRelease(
    tryPromise(
      "exec",
      (signal) =>
        sandbox.commands.run(command, {
          ...commandBaseOptions(opts, signal),
          background: true,
          onStdout: (data) => {
            emitted.stdout = true
            return Effect.runPromise(Queue.offer(queue, { type: "stdout", data }).pipe(Effect.asVoid))
          },
          onStderr: (data) => {
            emitted.stderr = true
            return Effect.runPromise(Queue.offer(queue, { type: "stderr", data }).pipe(Effect.asVoid))
          },
        }),
      sandboxId,
    ),
    (handle) => waitCommand(handle, sandboxId).pipe(Effect.map((result) => ({ type: "completed" as const, result }))),
    (handle, exit) => (Exit.isSuccess(exit) ? Effect.void : killCommandHandle(handle, sandboxId)),
  )

const waitCommand = (handle: CommandHandle, sandboxId: string): Effect.Effect<CommandResult, SandboxClientError> =>
  tryPromise(
    "exec",
    async (signal) => {
      const killOnAbort = () => {
        void handle.kill().catch(() => undefined)
      }
      if (signal.aborted) killOnAbort()
      signal.addEventListener("abort", killOnAbort, { once: true })
      try {
        return await handle.wait()
      } catch (error) {
        if (error instanceof CommandExitError) return commandResultFromExitError(error)
        throw error
      } finally {
        signal.removeEventListener("abort", killOnAbort)
      }
    },
    sandboxId,
  )

const killCommandHandle = (handle: CommandHandle, sandboxId: string): Effect.Effect<void> =>
  tryPromise("exec_kill", () => handle.kill(), sandboxId).pipe(Effect.ignore)

const offerMissingOutput = (queue: ExecQueue, emitted: { stdout: boolean; stderr: boolean }, result: CommandResult) => {
  const stdout =
    result.stdout.length > 0 && !emitted.stdout ? Queue.offer(queue, stdoutChunk(result.stdout)) : Effect.void
  const stderr =
    result.stderr.length > 0 && !emitted.stderr ? Queue.offer(queue, stderrChunk(result.stderr)) : Effect.void
  return stdout.pipe(Effect.andThen(stderr), Effect.asVoid)
}

const stdoutChunk = (data: string): ExecChunk => ({ type: "stdout", data })

const stderrChunk = (data: string): ExecChunk => ({ type: "stderr", data })

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
  run: (signal: AbortSignal) => Promise<A>,
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
