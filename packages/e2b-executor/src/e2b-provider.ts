import {
  ALL_TRAFFIC,
  Sandbox,
  type SandboxConnectOpts,
  type SandboxInfo,
  type SandboxListOpts,
  type SandboxOpts,
  type SandboxPauseOpts,
} from "e2b"
import { Effect, Layer, Redacted } from "effect"
import { E2BSandboxProvider, SandboxProviderError, type Interface, type SandboxCreateRequest } from "./provider"

export interface E2BSandbox {
  readonly sandboxId: string
}

export interface E2BPaginator {
  readonly hasNext: boolean
  readonly nextItems: () => Promise<ReadonlyArray<SandboxInfo>>
}

export interface E2BSdk {
  readonly create: (templateBuildId: string, options: SandboxOpts) => Promise<E2BSandbox>
  readonly connect: (sandboxId: string, options: SandboxConnectOpts) => Promise<E2BSandbox>
  readonly pause: (sandboxId: string, options: SandboxPauseOpts) => Promise<boolean>
  readonly kill: (sandboxId: string, options: SandboxConnectOpts) => Promise<boolean>
  readonly setTimeout: (sandboxId: string, timeoutMillis: number, options: SandboxConnectOpts) => Promise<void>
  readonly list: (options: SandboxListOpts) => E2BPaginator
}

export interface E2BOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly domain?: string
  readonly requestTimeoutMillis?: number
}

const liveSdk: E2BSdk = {
  create: (templateBuildId, options) => Sandbox.create(templateBuildId, options),
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  pause: (sandboxId, options) => Sandbox.pause(sandboxId, options),
  kill: (sandboxId, options) => Sandbox.kill(sandboxId, options),
  setTimeout: (sandboxId, timeoutMillis, options) => Sandbox.setTimeout(sandboxId, timeoutMillis, options),
  list: (options) => Sandbox.list(options),
}

const managedMetadata = { "rika.managed": "e2b-executor" } as const

const messageWithout = (cause: unknown, secrets: ReadonlyArray<string>) => {
  let message = String(cause)
  for (const secret of secrets) message = message.replaceAll(secret, "<redacted>")
  return message
}

const makeProvider = (options: E2BOptions, sdk: E2BSdk): Interface => {
  const apiKey = Redacted.value(options.apiKey)
  const connection = {
    apiKey,
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(options.requestTimeoutMillis === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMillis }),
  }
  const attempt = <A>(
    operation: SandboxProviderError["operation"],
    evaluate: () => Promise<A>,
    secrets: ReadonlyArray<string> = [],
  ) =>
    Effect.tryPromise({
      try: evaluate,
      catch: (cause) => SandboxProviderError.make({ operation, message: messageWithout(cause, [apiKey, ...secrets]) }),
    })

  const create = Effect.fn("E2BSandboxProvider.create")(function* (request: SandboxCreateRequest) {
    const secretValues = Object.values(request.secrets).map(Redacted.value)
    const envs = {
      ...request.environment,
      ...Object.fromEntries(Object.entries(request.secrets).map(([name, secret]) => [name, Redacted.value(secret)])),
    }
    const sandbox = yield* attempt(
      "create",
      () =>
        sdk.create(request.templateBuildId, {
          ...connection,
          timeoutMs: request.idleTimeoutMillis,
          secure: true,
          allowInternetAccess: true,
          lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
          network: {
            allowPublicTraffic: false,
            allowOut: [...request.allowedEgress],
            denyOut: [ALL_TRAFFIC],
          },
          metadata: {
            ...managedMetadata,
            "rika.assignment-id": request.assignmentId,
            "rika.workspace-id": request.workspaceId,
            "rika.generation": String(request.generation),
            "rika.template-build-id": request.templateBuildId,
          },
          envs,
        }),
      secretValues,
    )
    return { sandboxId: sandbox.sandboxId, state: "running" as const }
  })

  const connect = (sandboxId: string, idleTimeoutMillis: number) =>
    attempt("connect", () => sdk.connect(sandboxId, { ...connection, timeoutMs: idleTimeoutMillis })).pipe(
      Effect.map((sandbox) => ({ sandboxId: sandbox.sandboxId, state: "running" as const })),
    )

  const pauseFilesystem = (sandboxId: string) =>
    attempt("pause", () => sdk.pause(sandboxId, { ...connection, keepMemory: false }))

  const kill = (sandboxId: string) => attempt("kill", () => sdk.kill(sandboxId, connection))

  const touch = (sandboxId: string, idleTimeoutMillis: number) =>
    attempt("touch", () => sdk.setTimeout(sandboxId, idleTimeoutMillis, connection))

  const inventory = Effect.gen(function* () {
    const paginator = sdk.list({
      ...connection,
      query: { metadata: managedMetadata, state: ["running", "paused"] },
    })
    const entries: Array<SandboxInfo> = []
    while (paginator.hasNext) entries.push(...(yield* attempt("inventory", () => paginator.nextItems())))
    return entries.map((entry) => ({
      sandboxId: entry.sandboxId,
      state: entry.state,
      templateBuildId: entry.metadata["rika.template-build-id"] ?? entry.templateId,
      metadata: entry.metadata,
    }))
  })

  return E2BSandboxProvider.of({ create, connect, pauseFilesystem, kill, touch, inventory })
}

export const make = (options: E2BOptions): Interface => makeProvider(options, liveSdk)

export const makeWithSdk = (input: { readonly options: E2BOptions; readonly sdk: E2BSdk }): Interface =>
  makeProvider(input.options, input.sdk)

export const layer = (options: E2BOptions): Layer.Layer<E2BSandboxProvider> =>
  Layer.succeed(E2BSandboxProvider, make(options))
