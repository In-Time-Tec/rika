import { mkdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Config, SecretRedactor } from "@rika/core"
import { Ids, Remote } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"

const defaultHost = "127.0.0.1"
const recordFile = "local-backend.json"
const lockDirectory = "local-backend.lock"
const staleLockMillis = 10_000
const startupAttempts = 100
const startupDelayMillis = 100

export const BackendEndpoint = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("local"),
    url: Schema.String,
    token: Schema.String,
    workspace_root: Schema.String,
    data_dir: Schema.String,
    pid: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("env"),
    url: Schema.String,
    token: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("orb"),
    url: Schema.String,
    token: Schema.String,
    orb_id: Ids.OrbId,
    thread_id: Ids.ThreadId,
  }),
]).annotate({ identifier: "Rika.Cli.LocalBackend.BackendEndpoint" })
export type BackendEndpoint = typeof BackendEndpoint.Type

export interface BackendRecord extends Schema.Schema.Type<typeof BackendRecord> {}
export const BackendRecord = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  workspace_root: Schema.String,
  data_dir: Schema.String,
  backend_id: Schema.String,
  pid: Schema.Int,
  started_at: Schema.Int,
}).annotate({ identifier: "Rika.Cli.LocalBackend.BackendRecord" })

export interface BackendStatusReport extends Schema.Schema.Type<typeof BackendStatusReport> {}
export const BackendStatusReport = Schema.Struct({
  status: Remote.BackendStatus,
  workspace_root: Schema.String,
  data_dir: Schema.String,
  endpoint: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Cli.LocalBackend.BackendStatusReport" })

export interface ConnectInput {
  readonly workspace_root: string
  readonly data_dir: string
  readonly mode: Config.Mode
  readonly ephemeral?: boolean
}

export interface StatusInput {
  readonly workspace_root: string
  readonly data_dir: string
}

export interface LayerInput {
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly system?: System
  readonly adoptHealthyRecord?: boolean
}

export interface SpawnInput {
  readonly workspace_root: string
  readonly data_dir: string
  readonly backend_id: string
  readonly host: string
  readonly port: number
  readonly token: string
  readonly mode: Config.Mode
  readonly ephemeral: boolean
}

export interface SpawnedProcess {
  readonly pid: number
}

interface BackendOptions {
  readonly adoptHealthyRecord: boolean
}

export interface System {
  readonly readText: (path: string) => Effect.Effect<string, BackendError>
  readonly writePrivateText: (path: string, text: string) => Effect.Effect<void, BackendError>
  readonly remove: (path: string) => Effect.Effect<void, BackendError>
  readonly makeDir: (path: string) => Effect.Effect<void, BackendError>
  readonly tryAcquireLock: (path: string) => Effect.Effect<boolean, BackendError>
  readonly releaseLock: (path: string) => Effect.Effect<void, BackendError>
  readonly lockAgeMillis: (path: string) => Effect.Effect<number | undefined, BackendError>
  readonly randomToken: Effect.Effect<string, BackendError>
  readonly spawnServer: (input: SpawnInput) => Effect.Effect<SpawnedProcess, BackendError>
  readonly health: (url: string, token: string) => Effect.Effect<Remote.BackendHealth, BackendError>
  readonly sleep: (millis: number) => Effect.Effect<void>
}

export class BackendError extends Schema.TaggedErrorClass<BackendError>()("BackendError", {
  message: Schema.String,
  operation: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export interface Interface {
  readonly connectOrStart: (input: ConnectInput) => Effect.Effect<BackendEndpoint, BackendError>
  readonly status: (input: StatusInput) => Effect.Effect<BackendStatusReport, BackendError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/LocalBackend") {}

export const layerFromInput = (input: LayerInput) =>
  Layer.succeed(
    Service,
    Service.of(
      makeService(input.env, input.cwd, input.system ?? liveSystem(input.env, input.cwd), {
        adoptHealthyRecord: input.adoptHealthyRecord === true,
      }),
    ),
  )

export const connectOrStart = Effect.fn("Cli.LocalBackend.connectOrStart.call")(function* (input: ConnectInput) {
  const backend = yield* Service
  return yield* backend.connectOrStart(input)
})

export const status = Effect.fn("Cli.LocalBackend.status.call")(function* (input: StatusInput) {
  const backend = yield* Service
  return yield* backend.status(input)
})

export const recordPath = (dataDir: string) => join(dataDir, recordFile)
export const lockPath = (dataDir: string) => join(dataDir, lockDirectory)

export const redactEndpoint = (endpoint: BackendEndpoint | BackendRecord) => {
  if ("kind" in endpoint && endpoint.kind !== "local") return { kind: endpoint.kind, url: endpoint.url }
  return {
    kind: "local" as const,
    url: endpoint.url,
    workspace_root: endpoint.workspace_root,
    data_dir: endpoint.data_dir,
    pid: endpoint.pid,
  }
}

const makeService = (
  env: Record<string, string | undefined>,
  cwd: string,
  system: System,
  options: BackendOptions,
): Interface => {
  return {
    connectOrStart: Effect.fn("Cli.LocalBackend.connectOrStart")(function* (input: ConnectInput) {
      yield* system.makeDir(input.data_dir)
      return yield* connectAttempt({ env, cwd, input, system, options, attempt: 0 })
    }),
    status: Effect.fn("Cli.LocalBackend.status")(function* (input: StatusInput) {
      const remoteEndpoint = endpointFromEnv(env)
      const backend_id = backendId(env, cwd)
      if (remoteEndpoint !== undefined) {
        return {
          status: "remote",
          workspace_root: input.workspace_root,
          data_dir: input.data_dir,
          endpoint: remoteEndpoint.url,
        }
      }

      const record = yield* readRecord(system, input.data_dir).pipe(Effect.option)
      if (Option.isNone(record)) {
        return { status: "disconnected", workspace_root: input.workspace_root, data_dir: input.data_dir }
      }
      const healthy = yield* isHealthy(system, record.value, backend_id, options)
      return {
        status: healthy ? "healthy" : "stale",
        workspace_root: input.workspace_root,
        data_dir: input.data_dir,
        endpoint: record.value.url,
        pid: record.value.pid,
      }
    }),
  }
}

const connectAttempt = (input: {
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly input: ConnectInput
  readonly system: System
  readonly options: BackendOptions
  readonly attempt: number
}): Effect.Effect<BackendEndpoint, BackendError> =>
  Effect.gen(function* () {
    const backend_id = backendId(input.env, input.cwd)
    const current = yield* healthyRecord(input.system, input.input.data_dir, backend_id, input.options).pipe(
      Effect.option,
    )
    if (Option.isSome(current)) return current.value

    yield* removeStaleRecord(input.system, input.input.data_dir, backend_id, input.options)
    yield* removeStaleLock(input.system, input.input.data_dir)

    const locked = yield* input.system.tryAcquireLock(lockPath(input.input.data_dir))
    if (!locked) {
      if (input.attempt >= startupAttempts) {
        return yield* new BackendError({
          message: "Timed out waiting for another Rika process to start the shared backend",
          operation: "connectOrStart",
        })
      }
      yield* input.system.sleep(startupDelayMillis)
      return yield* connectAttempt({ ...input, attempt: input.attempt + 1 })
    }

    return yield* startUnderLock(input).pipe(
      Effect.ensuring(input.system.releaseLock(lockPath(input.input.data_dir)).pipe(Effect.catch(() => Effect.void))),
    )
  })

const startUnderLock = (input: {
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly input: ConnectInput
  readonly system: System
  readonly options: BackendOptions
}): Effect.Effect<BackendEndpoint, BackendError> =>
  Effect.gen(function* () {
    const backend_id = backendId(input.env, input.cwd)
    const current = yield* healthyRecord(input.system, input.input.data_dir, backend_id, input.options).pipe(
      Effect.option,
    )
    if (Option.isSome(current)) return current.value

    const token = yield* input.system.randomToken
    yield* registerBackendToken(token)
    const port = backendPort(input.env, input.input.workspace_root, input.input.data_dir, backend_id)
    const url = `http://${defaultHost}:${port}`
    const spawned = yield* input.system.spawnServer({
      workspace_root: input.input.workspace_root,
      data_dir: input.input.data_dir,
      backend_id,
      host: defaultHost,
      port,
      token,
      mode: input.input.mode,
      ephemeral: input.input.ephemeral === true,
    })
    const record: BackendRecord = {
      url,
      token,
      workspace_root: input.input.workspace_root,
      data_dir: input.input.data_dir,
      backend_id,
      pid: spawned.pid,
      started_at: Date.now(),
    }

    yield* waitForHealth(input.system, record, 0)
    yield* writeRecord(input.system, record)
    return endpointFromRecord(record)
  })

const waitForHealth = (system: System, record: BackendRecord, attempt: number): Effect.Effect<void, BackendError> =>
  system.health(record.url, record.token).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      attempt >= startupAttempts
        ? Effect.fail(error)
        : system.sleep(startupDelayMillis).pipe(Effect.flatMap(() => waitForHealth(system, record, attempt + 1))),
    ),
  )

const healthyRecord = (
  system: System,
  dataDir: string,
  backend_id: string,
  options: BackendOptions,
): Effect.Effect<BackendEndpoint, BackendError> =>
  Effect.gen(function* () {
    const record = yield* readRecord(system, dataDir)
    const healthy = yield* isHealthy(system, record, backend_id, options)
    if (!healthy) {
      return yield* new BackendError({ message: "Shared backend record is stale", operation: "healthyRecord" })
    }
    yield* registerBackendToken(record.token)
    return endpointFromRecord(record)
  })

const isHealthy = (
  system: System,
  record: BackendRecord,
  backend_id: string,
  options: BackendOptions,
): Effect.Effect<boolean, BackendError> => {
  const expectedBackendId =
    record.backend_id === backend_id || options.adoptHealthyRecord ? record.backend_id : undefined
  if (expectedBackendId === undefined) return Effect.succeed(false)
  return validateEndpointHealth(system, endpointFromRecord(record), expectedBackendId).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  )
}

const validateEndpointHealth = (
  system: System,
  endpoint: BackendEndpoint,
  backend_id: string,
): Effect.Effect<Remote.BackendHealth, BackendError> =>
  system
    .health(endpoint.url, endpoint.token)
    .pipe(
      Effect.flatMap((health) =>
        endpoint.kind !== "local" ||
        (health.workspace_root === endpoint.workspace_root &&
          health.data_dir === endpoint.data_dir &&
          health.backend_id === backend_id)
          ? Effect.succeed(health)
          : Effect.fail(new BackendError({ message: "Shared backend record is stale", operation: "health" })),
      ),
    )

const readRecord = (system: System, dataDir: string): Effect.Effect<BackendRecord, BackendError> =>
  system.readText(recordPath(dataDir)).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(BackendRecord)(JSON.parse(text) as unknown),
        catch: (cause) => toError(cause, "readRecord"),
      }),
    ),
  )

const writeRecord = (system: System, record: BackendRecord) =>
  system.writePrivateText(recordPath(record.data_dir), `${JSON.stringify(record, null, 2)}\n`)

const removeStaleRecord = (
  system: System,
  dataDir: string,
  backend_id: string,
  options: BackendOptions,
): Effect.Effect<void, BackendError> =>
  readRecord(system, dataDir).pipe(
    Effect.flatMap((record) =>
      isHealthy(system, record, backend_id, options).pipe(
        Effect.flatMap((healthy) => (healthy ? Effect.void : system.remove(recordPath(dataDir)))),
      ),
    ),
    Effect.catch(() => Effect.void),
  )

const removeStaleLock = (system: System, dataDir: string): Effect.Effect<void, BackendError> =>
  system
    .lockAgeMillis(lockPath(dataDir))
    .pipe(
      Effect.flatMap((age) =>
        age !== undefined && age > staleLockMillis ? system.releaseLock(lockPath(dataDir)) : Effect.void,
      ),
    )

const endpointFromRecord = (record: BackendRecord): BackendEndpoint => ({
  kind: "local",
  url: record.url,
  token: record.token,
  workspace_root: record.workspace_root,
  data_dir: record.data_dir,
  pid: record.pid,
})

const registerBackendToken = (token: string) =>
  Effect.gen(function* () {
    if (token.length === 0) return
    const redactor = Option.getOrUndefined(yield* Effect.serviceOption(SecretRedactor.Service))
    if (redactor !== undefined) yield* redactor.register([{ label: "RIKA_BACKEND_TOKEN", value: token }])
  })

const endpointFromEnv = (env: Record<string, string | undefined>): BackendEndpoint | undefined => {
  if (env.RIKA_BACKEND_URL === undefined || env.RIKA_BACKEND_URL.length === 0) return undefined
  return {
    kind: "env",
    url: env.RIKA_BACKEND_URL.replace(/\/$/, ""),
    token: env.RIKA_BACKEND_TOKEN ?? "",
  }
}

export const backendId = (env: Record<string, string | undefined>, cwd: string) => {
  const executable = env.RIKA_BACKEND_EXECUTABLE ?? process.execPath
  const script = env.RIKA_BACKEND_SCRIPT ?? defaultScriptArgument() ?? ""
  return JSON.stringify({ executable, script, cwd })
}

const backendPort = (
  env: Record<string, string | undefined>,
  workspaceRoot: string,
  dataDir: string,
  backend_id: string,
) => {
  const configured = env.RIKA_BACKEND_PORT
  if (configured !== undefined) {
    const parsed = Number.parseInt(configured, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 45_000 + (stableHash(`${workspaceRoot}\n${dataDir}\n${backend_id}`) % 10_000)
}

const stableHash = (value: string) => {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) hash = (hash * 33) ^ value.charCodeAt(index)
  return Math.abs(hash)
}

const liveSystem = (env: Record<string, string | undefined>, cwd: string): System => ({
  readText: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => toError(cause, "readText"),
    }),
  writePrivateText: (path, text) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text, { mode: 0o600 })
        await chmod(path, 0o600)
      },
      catch: (cause) => toError(cause, "writePrivateText"),
    }),
  remove: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { force: true, recursive: true }),
      catch: (cause) => toError(cause, "remove"),
    }),
  makeDir: (path) =>
    Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }).then(() => undefined),
      catch: (cause) => toError(cause, "makeDir"),
    }),
  tryAcquireLock: (path) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await mkdir(path)
          return true
        } catch (cause) {
          if (isCode(cause, "EEXIST")) return false
          throw cause
        }
      },
      catch: (cause) => toError(cause, "tryAcquireLock"),
    }),
  releaseLock: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { force: true, recursive: true }),
      catch: (cause) => toError(cause, "releaseLock"),
    }),
  lockAgeMillis: (path) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return Date.now() - (await stat(path)).mtimeMs
        } catch (cause) {
          if (isCode(cause, "ENOENT")) return undefined
          throw cause
        }
      },
      catch: (cause) => toError(cause, "lockAgeMillis"),
    }),
  randomToken: Effect.sync(() => crypto.randomUUID().replaceAll("-", "")),
  spawnServer: (input) =>
    Effect.try({
      try: () => {
        const subprocess = Bun.spawn({
          cmd: serverCommand(env, input),
          cwd,
          env: {
            ...env,
            RIKA_WORKSPACE_ROOT: input.workspace_root,
            RIKA_DATA_DIR: input.data_dir,
            RIKA_BACKEND_ID: input.backend_id,
            RIKA_MODE: input.mode,
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        })
        return { pid: subprocess.pid }
      },
      catch: (cause) => toError(cause, "spawnServer"),
    }),
  health: (url, token) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${url.replace(/\/$/, "")}/health`, {
          headers: token.length === 0 ? {} : { authorization: `Bearer ${token}` },
        })
        if (!response.ok) throw new Error(`Health check failed with status ${response.status}`)
        return Schema.decodeUnknownSync(Remote.BackendHealth)(await response.json())
      },
      catch: (cause) => toError(cause, "health"),
    }),
  sleep: (millis) => Effect.promise(() => Bun.sleep(millis)),
})

const serverCommand = (env: Record<string, string | undefined>, input: SpawnInput) => {
  const executable = env.RIKA_BACKEND_EXECUTABLE ?? process.execPath
  const script = env.RIKA_BACKEND_SCRIPT ?? defaultScriptArgument()
  return [
    executable,
    ...(script === undefined ? [] : [script]),
    "server",
    "--host",
    input.host,
    "--port",
    String(input.port),
    "--token",
    input.token,
    "--workspace",
    input.workspace_root,
    ...(input.ephemeral ? ["--ephemeral"] : []),
  ]
}

const defaultScriptArgument = () => {
  const script = Bun.argv[1]
  if (script === undefined) return undefined
  if (script.endsWith(".ts") || script.endsWith(".js")) return script
  return undefined
}

const isCode = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code

const toError = (cause: unknown, operation: string) => {
  if (cause instanceof BackendError) return cause
  return new BackendError({ message: cause instanceof Error ? cause.message : String(cause), operation })
}
