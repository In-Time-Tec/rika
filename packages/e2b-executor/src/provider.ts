import {
  ALL_TRAFFIC,
  Sandbox,
  type SandboxConnectOpts,
  type SandboxInfo,
  type SandboxListOpts,
  type SandboxOpts,
  type SandboxPauseOpts,
} from "e2b"
import { Context, Effect, Layer, Redacted, Schema } from "effect"

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
}

export interface Handle {
  readonly sandboxId: string
  readonly state: "running" | "paused"
}

export interface InventoryEntry extends Handle {
  readonly templateBuildId: string
  readonly metadata: Readonly<Record<string, string>>
}

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  operation: Schema.Literals(["bootstrap", "create", "connect", "pause", "kill", "touch", "inventory"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly create: (request: CreateRequest) => Effect.Effect<Handle, ProviderError>
  readonly bootstrap: (request: BootstrapRequest) => Effect.Effect<void, ProviderError>
  readonly connect: (sandboxId: string, idleTimeoutMillis: number) => Effect.Effect<Handle, ProviderError>
  readonly pauseFilesystem: (sandboxId: string) => Effect.Effect<boolean, ProviderError>
  readonly kill: (sandboxId: string) => Effect.Effect<boolean, ProviderError>
  readonly touch: (sandboxId: string, idleTimeoutMillis: number) => Effect.Effect<void, ProviderError>
  readonly inventory: Effect.Effect<ReadonlyArray<InventoryEntry>, ProviderError>
}

export class Provider extends Context.Service<Provider, Interface>()("@rika/e2b-executor/provider") {}

export interface SdkHandle {
  readonly sandboxId: string
}

export interface Paginator {
  readonly hasNext: boolean
  readonly nextItems: () => Promise<ReadonlyArray<SandboxInfo>>
}

export interface Sdk {
  readonly create: (templateId: string, options: SandboxOpts) => Promise<SdkHandle>
  readonly connect: (sandboxId: string, options: SandboxConnectOpts) => Promise<SdkHandle>
  readonly pause: (sandboxId: string, options: SandboxPauseOpts) => Promise<boolean>
  readonly kill: (sandboxId: string, options: SandboxConnectOpts) => Promise<boolean>
  readonly setTimeout: (sandboxId: string, timeoutMillis: number, options: SandboxConnectOpts) => Promise<void>
  readonly list: (options: SandboxListOpts) => Paginator
  readonly bootstrap: (request: {
    readonly sandboxId: string
    readonly body: string
    readonly connection: SandboxConnectOpts
    readonly url: string
  }) => Promise<void>
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

const liveSdk: Sdk = {
  create: (templateId, options) => Sandbox.create(templateId, options),
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  pause: (sandboxId, options) => Sandbox.pause(sandboxId, options),
  kill: (sandboxId, options) => Sandbox.kill(sandboxId, options),
  setTimeout: (sandboxId, timeoutMillis, options) => Sandbox.setTimeout(sandboxId, timeoutMillis, options),
  list: (options) => Sandbox.list(options),
  bootstrap: ({ sandboxId, body, connection, url }) =>
    Sandbox.connect(sandboxId, connection)
      .then((sandbox) => {
        if (sandbox.trafficAccessToken === undefined)
          throw new Error("secure sandbox did not provide a traffic access token")
        return Bun.fetch(url, {
          method: "POST",
          headers: bootstrapHeaders(sandbox.trafficAccessToken),
          body,
        })
      })
      .then((response) => {
        if (!response.ok) throw new Error(`bootstrap endpoint returned ${response.status}`)
      }),
}

const managedMetadata = { "rika.managed": "e2b-executor" } as const
const bootstrapUrl = (sandboxId: string, domain = "e2b.app") =>
  `https://7070-${sandboxId}.${domain}/.rika/bootstrap`

export const testing = { bootstrapHeaders, bootstrapUrl } as const

const makeProvider = (options: Options, sdk: Sdk): Interface => {
  const apiKey = Redacted.value(options.apiKey)
  const connection = {
    apiKey,
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(options.requestTimeoutMillis === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMillis }),
  }
  const attempt = <A>(operation: ProviderError["operation"], evaluate: () => Promise<A>) =>
    Effect.tryPromise({
      try: evaluate,
      catch: () => ProviderError.make({ operation, message: `E2B ${operation} failed` }),
    })

  const create = Effect.fn("Provider.create")(function* (request: CreateRequest) {
    const sandbox = yield* attempt("create", () =>
      sdk.create(request.templateId, {
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
    return { sandboxId: sandbox.sandboxId, state: "running" as const }
  })

  const bootstrap = (request: BootstrapRequest) => {
    const credential = Redacted.value(request.credential)
    return attempt("bootstrap", () =>
      sdk.bootstrap({
        sandboxId: request.sandboxId,
        connection,
        body: JSON.stringify({ credential }),
        url: bootstrapUrl(request.sandboxId, options.domain),
      }),
    )
  }

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
    return entries.flatMap((entry) => {
      const templateBuildId = entry.metadata["rika.template-build-id"]
      return templateBuildId === undefined
        ? []
        : [{ sandboxId: entry.sandboxId, state: entry.state, templateBuildId, metadata: entry.metadata }]
    })
  })

  return Provider.of({ create, bootstrap, connect, pauseFilesystem, kill, touch, inventory })
}

export const make = (options: Options): Interface => makeProvider(options, liveSdk)

export const makeWithSdk = (input: { readonly options: Options; readonly sdk: Sdk }): Interface =>
  makeProvider(input.options, input.sdk)

export const layer = (options: Options): Layer.Layer<Provider> => Layer.succeed(Provider, make(options))
