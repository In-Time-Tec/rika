import { Effect, Layer, Stream } from "effect"
import * as SandboxClient from "./sandbox-client"

export interface Calls {
  readonly create: Array<SandboxClient.CreateInput>
  readonly exec: Array<{
    readonly sandboxId: string
    readonly cmd: ReadonlyArray<string>
    readonly opts: SandboxClient.ExecOptions
  }>
  readonly execKill: Array<{
    readonly sandboxId: string
    readonly cmd: ReadonlyArray<string>
    readonly opts: SandboxClient.ExecOptions
  }>
  readonly writeFile: Array<{
    readonly sandboxId: string
    readonly path: string
    readonly bytes: Uint8Array
  }>
  readonly readFile: Array<{
    readonly sandboxId: string
    readonly path: string
  }>
  readonly hostUrl: Array<{
    readonly sandboxId: string
    readonly port: number
  }>
  readonly pause: Array<string>
  readonly resume: Array<string>
  readonly kill: Array<string>
  readonly setTimeout: Array<{
    readonly sandboxId: string
    readonly timeoutMs: number
  }>
  readonly list: Array<SandboxClient.ListFilter | undefined>
  readonly templateExists: Array<string>
}

export interface State {
  readonly calls: Calls
  readonly execResults: Array<ExecResult>
  readonly killFailureMessage?: string
  readonly sandboxes: Map<string, SandboxClient.SandboxSummary>
  readonly templates: Set<string>
  readonly files: Map<string, Uint8Array>
  nextSandbox: number
}

export interface StateInput {
  readonly execResults?: ReadonlyArray<ExecResult>
  readonly killFailureMessage?: string
  readonly templates?: ReadonlyArray<string>
}

export type ExecResult =
  | ReadonlyArray<SandboxClient.ExecChunk>
  | {
      readonly interruptible: true
      readonly chunks?: ReadonlyArray<SandboxClient.ExecChunk>
    }

export const makeState = (input: StateInput = {}): State => ({
  calls: {
    create: [],
    exec: [],
    execKill: [],
    writeFile: [],
    readFile: [],
    hostUrl: [],
    pause: [],
    resume: [],
    kill: [],
    setTimeout: [],
    list: [],
    templateExists: [],
  },
  execResults: Array.from(input.execResults ?? []),
  ...(input.killFailureMessage === undefined ? {} : { killFailureMessage: input.killFailureMessage }),
  sandboxes: new Map(),
  templates: new Set(input.templates ?? []),
  files: new Map(),
  nextSandbox: 1,
})

export const layer = (state: State = makeState()): Layer.Layer<SandboxClient.Service> =>
  Layer.succeed(SandboxClient.Service, SandboxClient.Service.of(makeService(state)))

const makeService = (state: State): SandboxClient.Interface => ({
  create: Effect.fn("SandboxClientFake.create")(function* (input: SandboxClient.CreateInput) {
    yield* SandboxClient.validateCreateInput(input)
    const sandboxId = `sandbox_${state.nextSandbox}`
    state.nextSandbox += 1
    state.calls.create.push(cloneCreateInput(input))
    state.sandboxes.set(sandboxId, {
      sandboxId,
      templateId: input.templateId,
      metadata: { ...input.metadata },
      state: "running",
    })
    return { sandboxId }
  }),
  exec: (sandboxId: string, cmd: ReadonlyArray<string>, opts: SandboxClient.ExecOptions) => {
    state.calls.exec.push({
      sandboxId,
      cmd: Array.from(cmd),
      opts: cloneExecOptions(opts),
    })
    const chunks = state.execResults.shift() ?? [{ type: "exit", exitCode: 0 }]
    if (isExecChunks(chunks)) return Stream.fromIterable(chunks)
    return Stream.fromIterable(chunks.chunks ?? []).pipe(
      Stream.concat(Stream.never),
      Stream.ensuring(
        Effect.sync(() => {
          state.calls.execKill.push({
            sandboxId,
            cmd: Array.from(cmd),
            opts: cloneExecOptions(opts),
          })
        }),
      ),
    )
  },
  writeFile: Effect.fn("SandboxClientFake.writeFile")(function* (sandboxId: string, path: string, bytes: Uint8Array) {
    state.calls.writeFile.push({ sandboxId, path, bytes })
    state.files.set(fileKey(sandboxId, path), new Uint8Array(bytes))
  }),
  readFile: Effect.fn("SandboxClientFake.readFile")(function* (sandboxId: string, path: string) {
    state.calls.readFile.push({ sandboxId, path })
    const bytes = state.files.get(fileKey(sandboxId, path))
    if (bytes === undefined) {
      return yield* new SandboxClient.SandboxClientError({
        message: `Missing sandbox file ${path}`,
        operation: "readFile",
        sandboxId,
      })
    }
    return new Uint8Array(bytes)
  }),
  hostUrl: Effect.fn("SandboxClientFake.hostUrl")(function* (sandboxId: string, port: number) {
    state.calls.hostUrl.push({ sandboxId, port })
    return `https://${sandboxId}-${port}.fake.rika.local`
  }),
  pause: Effect.fn("SandboxClientFake.pause")(function* (sandboxId: string) {
    state.calls.pause.push(sandboxId)
    updateState(state, sandboxId, "paused")
  }),
  resume: Effect.fn("SandboxClientFake.resume")(function* (sandboxId: string) {
    state.calls.resume.push(sandboxId)
    updateState(state, sandboxId, "running")
  }),
  kill: Effect.fn("SandboxClientFake.kill")(function* (sandboxId: string) {
    state.calls.kill.push(sandboxId)
    if (state.killFailureMessage !== undefined) {
      return yield* new SandboxClient.SandboxClientError({
        message: state.killFailureMessage,
        operation: "kill",
        sandboxId,
      })
    }
    state.sandboxes.delete(sandboxId)
    return yield* Effect.void
  }),
  setTimeout: Effect.fn("SandboxClientFake.setTimeout")(function* (sandboxId: string, timeoutMs: number) {
    state.calls.setTimeout.push({ sandboxId, timeoutMs })
  }),
  list: Effect.fn("SandboxClientFake.list")(function* (filter?: SandboxClient.ListFilter) {
    state.calls.list.push(filter === undefined ? undefined : { metadata: { ...filter.metadata } })
    return Array.from(state.sandboxes.values()).filter((sandbox) => matchesFilter(sandbox, filter))
  }),
  templateExists: Effect.fn("SandboxClientFake.templateExists")(function* (templateId: string) {
    state.calls.templateExists.push(templateId)
    return state.templates.has(templateId)
  }),
})

const cloneCreateInput = (input: SandboxClient.CreateInput): SandboxClient.CreateInput => ({
  templateId: input.templateId,
  envs: { ...input.envs },
  metadata: { ...input.metadata },
  timeoutMs: input.timeoutMs,
  ...cloneLifecycle(input.lifecycle),
})

const isExecChunks = (result: ExecResult): result is ReadonlyArray<SandboxClient.ExecChunk> => Array.isArray(result)

const cloneLifecycle = (lifecycle: SandboxClient.CreateInput["lifecycle"]) =>
  lifecycle === undefined
    ? {}
    : {
        lifecycle: {
          ...lifecycle,
        },
      }

const cloneExecOptions = (opts: SandboxClient.ExecOptions): SandboxClient.ExecOptions => ({
  ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  ...(opts.envs === undefined ? {} : { envs: { ...opts.envs } }),
  ...(opts.background === undefined ? {} : { background: opts.background }),
})

const matchesFilter = (sandbox: SandboxClient.SandboxSummary, filter: SandboxClient.ListFilter | undefined) => {
  if (filter === undefined) return true
  return Object.entries(filter.metadata).every(([key, value]) => sandbox.metadata[key] === value)
}

const updateState = (state: State, sandboxId: string, next: SandboxClient.SandboxSummary["state"]) => {
  const sandbox = state.sandboxes.get(sandboxId)
  if (sandbox === undefined) return
  state.sandboxes.set(sandboxId, { ...sandbox, state: next })
}

const fileKey = (sandboxId: string, path: string) => `${sandboxId}\0${path}`
