import {
  ALL_TRAFFIC,
  Sandbox,
  Template,
  type SandboxConnectOpts,
  type SandboxInfo,
  type SandboxListOpts,
  type SandboxOpts,
  type SandboxPauseOpts,
  type SandboxNetworkUpdate,
} from "e2b"
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect"
import type { CheckpointRestore, ExecutorBootstrapIdentity } from "@rika/remote-execution/protocol"

export interface CreateRequest {
  readonly appId: string
  readonly deploymentId: string
  readonly templateId: string
  readonly templateBuildId: string
  readonly assignmentId: string
  readonly threadId: string
  readonly generation: number
  readonly idleTimeoutMillis: number
  readonly allowedEgress: ReadonlyArray<string>
  readonly environment: Readonly<Record<string, string>>
}

export interface BootstrapRequest {
  readonly sandboxId: string
  readonly credential: Redacted.Redacted<string>
  readonly identity: ExecutorBootstrapIdentity
  readonly restore: CheckpointRestore | null
}

export interface Handle {
  readonly sandboxId: string
  readonly state: "running" | "paused"
}

export interface InventoryEntry extends Handle {
  readonly templateId: string
  readonly templateBuildId: string
  readonly metadata: Readonly<Record<string, string>>
}

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  operation: Schema.Literals([
    "bootstrap",
    "create",
    "connect",
    "host",
    "network",
    "pause",
    "kill",
    "touch",
    "inventory",
  ]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly create: (request: CreateRequest) => Effect.Effect<Handle, ProviderError>
  readonly bootstrap: (request: BootstrapRequest) => Effect.Effect<void, ProviderError>
  readonly connect: (sandboxId: string, idleTimeoutMillis: number) => Effect.Effect<Handle, ProviderError>
  readonly host: (sandboxId: string, port: number) => Effect.Effect<string, ProviderError>
  readonly updateNetwork: (
    sandboxId: string,
    allowedEgress: ReadonlyArray<string>,
  ) => Effect.Effect<void, ProviderError>
  readonly pauseFilesystem: (sandboxId: string) => Effect.Effect<boolean, ProviderError>
  readonly kill: (sandboxId: string) => Effect.Effect<boolean, ProviderError>
  readonly touch: (sandboxId: string, idleTimeoutMillis: number) => Effect.Effect<void, ProviderError>
  readonly inventory: Effect.Effect<ReadonlyArray<InventoryEntry>, ProviderError>
}

export class Provider extends Context.Service<Provider, Interface>()("@rika/e2b-executor/provider") {}

export interface SdkHandle {
  readonly sandboxId: string
  readonly trafficAccessToken?: string
}

export class SdkError extends Schema.TaggedError<SdkError>()("SdkError", {
  message: Schema.String,
}) {}

class BootstrapError extends Schema.TaggedError<BootstrapError>()("BootstrapError", {
  message: Schema.String,
}) {}

export interface Paginator {
  readonly hasNext: boolean
  readonly nextItems: Effect.Effect<ReadonlyArray<SandboxInfo>, SdkError>
}

export interface Sdk {
  readonly buildStatus: (
    templateId: string,
    buildId: string,
    options: SandboxConnectOpts,
  ) => Effect.Effect<
    {
      readonly templateId: string
      readonly buildId: string
      readonly status: "building" | "waiting" | "ready" | "error"
    },
    SdkError
  >
  readonly create: (templateId: string, options: SandboxOpts) => Effect.Effect<SdkHandle, SdkError>
  readonly getInfo: (sandboxId: string, options: SandboxConnectOpts) => Effect.Effect<SandboxInfo, SdkError>
  readonly connect: (sandboxId: string, options: SandboxConnectOpts) => Effect.Effect<SdkHandle, SdkError>
  readonly host: (sandboxId: string, port: number, options: SandboxConnectOpts) => Effect.Effect<string, SdkError>
  readonly updateNetwork: (
    sandboxId: string,
    network: SandboxNetworkUpdate,
    options: SandboxConnectOpts,
  ) => Effect.Effect<void, SdkError>
  readonly pause: (sandboxId: string, options: SandboxPauseOpts) => Effect.Effect<boolean, SdkError>
  readonly kill: (sandboxId: string, options: SandboxConnectOpts) => Effect.Effect<boolean, SdkError>
  readonly setTimeout: (
    sandboxId: string,
    timeoutMillis: number,
    options: SandboxConnectOpts,
  ) => Effect.Effect<void, SdkError>
  readonly list: (options: SandboxListOpts) => Paginator
  readonly bootstrap: (request: {
    readonly sandboxId: string
    readonly body: string
    readonly connection: SandboxConnectOpts
    readonly url: string
  }) => Effect.Effect<void, SdkError | BootstrapError>
}

export interface Options {
  readonly apiKey: Redacted.Redacted<string>
  readonly domain?: string
  readonly requestTimeoutMillis?: number
}

const bootstrapHeaders = (trafficAccessToken: string) => ({
  "content-type": "application/json",
  "e2b-traffic-access-token": trafficAccessToken,
})

interface BootstrapTransport {
  readonly connect: (sandboxId: string, options: SandboxConnectOpts) => Effect.Effect<SdkHandle, SdkError>
  readonly fetch: (input: string | URL, init?: RequestInit) => Effect.Effect<Response, BootstrapError>
  readonly sleep: (milliseconds: number) => Effect.Effect<void>
  readonly now: Effect.Effect<number>
}

const liveBootstrapTransport: BootstrapTransport = {
  connect: (sandboxId, options) =>
    Effect.tryPromise({
      try: () => Sandbox.connect(sandboxId, options),
      catch: () => SdkError.make({ message: "E2B sandbox connection failed" }),
    }),
  fetch: (input, init) =>
    Effect.tryPromise({
      try: () => Bun.fetch(input, init),
      catch: () => BootstrapError.make({ message: "E2B bootstrap request failed" }),
    }),
  sleep: (milliseconds) => Effect.sleep(milliseconds),
  now: Clock.currentTimeMillis,
}

const bootstrapSandbox = (
  { sandboxId, body, connection, url }: Parameters<Sdk["bootstrap"]>[0],
  transport: BootstrapTransport = liveBootstrapTransport,
) =>
  Effect.gen(function* () {
    const deadline = (yield* transport.now) + (connection.requestTimeoutMs ?? 30_000)
    const delay = <A, E>(remaining: number, next: Effect.Effect<A, E>) =>
      transport.sleep(Math.min(250, remaining)).pipe(Effect.andThen(next))
    const connect = (): Effect.Effect<SdkHandle, SdkError | BootstrapError> =>
      Effect.gen(function* () {
        const remaining = deadline - (yield* transport.now)
        if (remaining <= 0)
          return yield* BootstrapError.make({ message: "secure sandbox traffic access did not become ready" })
        return yield* transport
          .connect(sandboxId, {
            ...connection,
            requestTimeoutMs: Math.max(1, Math.min(2_000, remaining)),
          })
          .pipe(
            Effect.flatMap((sandbox) =>
              sandbox.trafficAccessToken === undefined ? delay(remaining, connect()) : Effect.succeed(sandbox),
            ),
            Effect.catch(() => delay(remaining, connect())),
          )
      })
    const sandbox = yield* connect()
    if (sandbox.trafficAccessToken === undefined)
      return yield* BootstrapError.make({ message: "secure sandbox did not provide a traffic access token" })
    const headers = bootstrapHeaders(sandbox.trafficAccessToken)
    const retry = (): Effect.Effect<void, BootstrapError> =>
      Effect.gen(function* () {
        const remaining = deadline - (yield* transport.now)
        if (remaining <= 0) return yield* BootstrapError.make({ message: "bootstrap endpoint did not become ready" })
        const response = yield* transport
          .fetch(new URL("/health", url), {
            headers,
            signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, remaining))),
          })
          .pipe(Effect.catch(() => delay(remaining, retry()).pipe(Effect.as(new Response(null, { status: 200 })))))
        if (!response.ok) {
          yield* Effect.tryPromise({
            try: () => response.text(),
            catch: () => BootstrapError.make({ message: "E2B bootstrap response could not be read" }),
          }).pipe(Effect.ignore)
          yield* delay(remaining, retry())
        }
      })
    yield* retry()
    const response = yield* transport.fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(Math.max(1, deadline - (yield* transport.now))),
    })
    if (!response.ok) return yield* BootstrapError.make({ message: `bootstrap endpoint returned ${response.status}` })
  })

const liveSdk: Sdk = {
  buildStatus: (templateId, buildId, options) =>
    Effect.tryPromise({
      try: () => Template.getBuildStatus({ templateId, buildId }, options),
      catch: () => SdkError.make({ message: "E2B template build status failed" }),
    }).pipe(
      Effect.map((status) => ({
        templateId: status.templateID,
        buildId: status.buildID,
        status: status.status,
      })),
    ),
  create: (templateId, options) =>
    Effect.tryPromise({
      try: () => Sandbox.create(templateId, options),
      catch: () => SdkError.make({ message: "E2B sandbox creation failed" }),
    }),
  getInfo: (sandboxId, options) =>
    Effect.tryPromise({
      try: () => Sandbox.getInfo(sandboxId, options),
      catch: () => SdkError.make({ message: "E2B sandbox info failed" }),
    }),
  connect: (sandboxId, options) =>
    Effect.tryPromise({
      try: () => Sandbox.connect(sandboxId, options),
      catch: () => SdkError.make({ message: "E2B sandbox connection failed" }),
    }),
  host: (sandboxId, port, options) =>
    Effect.tryPromise({
      try: () => Sandbox.connect(sandboxId, options),
      catch: () => SdkError.make({ message: "E2B sandbox connection failed" }),
    }).pipe(Effect.map((sandbox) => sandbox.getHost(port))),
  updateNetwork: (sandboxId, network, options) =>
    Effect.tryPromise({
      try: () => Sandbox.connect(sandboxId, options),
      catch: () => SdkError.make({ message: "E2B sandbox connection failed" }),
    }).pipe(
      Effect.flatMap((sandbox) =>
        Effect.tryPromise({
          try: () => sandbox.updateNetwork(network, options),
          catch: () => SdkError.make({ message: "E2B sandbox network update failed" }),
        }),
      ),
    ),
  pause: (sandboxId, options) =>
    Effect.tryPromise({
      try: () => Sandbox.pause(sandboxId, options),
      catch: () => SdkError.make({ message: "E2B sandbox pause failed" }),
    }),
  kill: (sandboxId, options) =>
    Effect.tryPromise({
      try: () => Sandbox.kill(sandboxId, options),
      catch: () => SdkError.make({ message: "E2B sandbox kill failed" }),
    }),
  setTimeout: (sandboxId, timeoutMillis, options) =>
    Effect.tryPromise({
      try: () => Sandbox.setTimeout(sandboxId, timeoutMillis, options),
      catch: () => SdkError.make({ message: "E2B sandbox timeout update failed" }),
    }),
  list: (options) => {
    const paginator = Sandbox.list(options)
    return {
      get hasNext() {
        return paginator.hasNext
      },
      nextItems: Effect.tryPromise({
        try: () => paginator.nextItems(),
        catch: () => SdkError.make({ message: "E2B sandbox inventory page failed" }),
      }),
    }
  },
  bootstrap: (request) => bootstrapSandbox(request),
}

const managedMetadata = { "rika.managed": "e2b-executor" } as const
const bootstrapUrl = (sandboxId: string, domain = "e2b.app") => `https://7070-${sandboxId}.${domain}/.rika/bootstrap`
const protectedNetworks = [ALL_TRAFFIC] as const
const networkPolicy = (allowedEgress: ReadonlyArray<string>): SandboxNetworkUpdate => ({
  allowInternetAccess: true,
  allowOut: [...allowedEgress],
  denyOut: [...protectedNetworks],
})

export const testing = { bootstrapHeaders, bootstrapSandbox, bootstrapUrl, networkPolicy, protectedNetworks } as const

const makeProvider = (options: Options, sdk: Sdk): Interface => {
  const apiKey = Redacted.value(options.apiKey)
  const connection = {
    apiKey,
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(options.requestTimeoutMillis === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMillis }),
  }
  const attempt = <A, E>(operation: ProviderError["operation"], evaluate: () => Effect.Effect<A, E>) =>
    Effect.suspend(evaluate).pipe(
      Effect.mapError(() => ProviderError.make({ operation, message: `E2B ${operation} failed` })),
    )

  const attestTemplateBuild = Effect.fn("Provider.attestTemplateBuild")(function* (request: {
    readonly operation: "create" | "inventory"
    readonly templateId: string
    readonly templateBuildId: string
  }) {
    const status = yield* attempt(request.operation, () =>
      sdk.buildStatus(request.templateId, request.templateBuildId, connection),
    )
    if (
      status.templateId !== request.templateId ||
      status.buildId !== request.templateBuildId ||
      status.status !== "ready"
    )
      return yield* ProviderError.make({
        operation: request.operation,
        message: "E2B template build attestation failed",
      })
  })

  const create = Effect.fn("Provider.create")(function* (request: CreateRequest) {
    yield* attestTemplateBuild({ ...request, operation: "create" })
    const sandbox = yield* attempt("create", () =>
      sdk.create(`${request.templateId}:${request.templateBuildId}`, {
        ...connection,
        timeoutMs: request.idleTimeoutMillis,
        secure: true,
        allowInternetAccess: true,
        lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
        network: { allowPublicTraffic: false, ...networkPolicy(request.allowedEgress) },
        metadata: {
          ...managedMetadata,
          "rika.app-id": request.appId,
          "rika.deployment-id": request.deploymentId,
          "rika.assignment-id": request.assignmentId,
          "rika.thread-id": request.threadId,
          "rika.generation": String(request.generation),
          "rika.template-build-id": request.templateBuildId,
        },
        envs: request.environment,
      }),
    )
    yield* Effect.all([
      attestTemplateBuild({ ...request, operation: "create" }),
      attempt("create", () => sdk.getInfo(sandbox.sandboxId, connection)).pipe(
        Effect.flatMap((info) =>
          info.templateId === request.templateId
            ? Effect.void
            : Effect.fail(
                ProviderError.make({ operation: "create", message: "E2B sandbox template attestation failed" }),
              ),
        ),
      ),
    ]).pipe(Effect.tapError(() => attempt("kill", () => sdk.kill(sandbox.sandboxId, connection)).pipe(Effect.ignore)))
    return { sandboxId: sandbox.sandboxId, state: "running" as const }
  })

  const bootstrap = (request: BootstrapRequest) => {
    const credential = Redacted.value(request.credential)
    return attempt("bootstrap", () =>
      sdk.bootstrap({
        sandboxId: request.sandboxId,
        connection,
        body: JSON.stringify({ credential, identity: request.identity, restore: request.restore }),
        url: bootstrapUrl(request.sandboxId, options.domain),
      }),
    )
  }

  const connect = (sandboxId: string, idleTimeoutMillis: number) =>
    attempt("connect", () => sdk.connect(sandboxId, { ...connection, timeoutMs: idleTimeoutMillis })).pipe(
      Effect.map((sandbox) => ({ sandboxId: sandbox.sandboxId, state: "running" as const })),
    )

  const host = (sandboxId: string, port: number) => attempt("host", () => sdk.host(sandboxId, port, connection))

  const updateNetwork = (sandboxId: string, allowedEgress: ReadonlyArray<string>) =>
    attempt("network", () => sdk.updateNetwork(sandboxId, networkPolicy(allowedEgress), connection))

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
    while (paginator.hasNext) entries.push(...(yield* attempt("inventory", () => paginator.nextItems)))
    const managed = entries.flatMap((entry) => {
      const templateBuildId = entry.metadata["rika.template-build-id"]
      return templateBuildId === undefined
        ? []
        : [
            {
              sandboxId: entry.sandboxId,
              state: entry.state,
              templateId: entry.templateId,
              templateBuildId,
              metadata: entry.metadata,
            },
          ]
    })
    const selections = Array.from(
      new Map(managed.map((entry) => [`${entry.templateId}:${entry.templateBuildId}`, entry])).values(),
    )
    yield* Effect.forEach(selections, (entry) => attestTemplateBuild({ ...entry, operation: "inventory" }), {
      concurrency: 4,
      discard: true,
    })
    return managed
  })

  return Provider.of({ create, bootstrap, connect, host, updateNetwork, pauseFilesystem, kill, touch, inventory })
}

export const make = (options: Options): Interface => makeProvider(options, liveSdk)

export const makeWithSdk = (input: { readonly options: Options; readonly sdk: Sdk }): Interface =>
  makeProvider(input.options, input.sdk)

export const layer = (options: Options): Layer.Layer<Provider> => Layer.succeed(Provider, make(options))
