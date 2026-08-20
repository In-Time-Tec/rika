import {
  ALL_TRAFFIC,
  Sandbox,
  Template,
  type SandboxConnectOpts,
  type SandboxInfo,
  type SandboxListOpts,
  type SandboxOpts,
  type SandboxPauseOpts,
} from "e2b"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import type { ExecutorBootstrapIdentity } from "@rika/remote-execution/protocol"

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
  readonly trafficAccessToken?: string
}

export interface Paginator {
  readonly hasNext: boolean
  readonly nextItems: () => Promise<ReadonlyArray<SandboxInfo>>
}

export interface Sdk {
  readonly templateTags: (
    templateId: string,
    options: SandboxConnectOpts,
  ) => Promise<ReadonlyArray<{ readonly tag: string; readonly buildId: string }>>
  readonly buildStatus: (
    templateId: string,
    buildId: string,
    options: SandboxConnectOpts,
  ) => Promise<{
    readonly templateId: string
    readonly buildId: string
    readonly status: "building" | "waiting" | "ready" | "error"
  }>
  readonly create: (templateId: string, options: SandboxOpts) => Promise<SdkHandle>
  readonly getInfo: (sandboxId: string, options: SandboxConnectOpts) => Promise<SandboxInfo>
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

interface BootstrapTransport {
  readonly connect: (sandboxId: string, options: SandboxConnectOpts) => Promise<SdkHandle>
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly now: () => number
}

const liveBootstrapTransport: BootstrapTransport = {
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  fetch: (input, init) => Bun.fetch(input, init),
  sleep: (milliseconds) => Bun.sleep(milliseconds),
  now: () => performance.now(),
}

const bootstrapSandbox = (
  { sandboxId, body, connection, url }: Parameters<Sdk["bootstrap"]>[0],
  transport: BootstrapTransport = liveBootstrapTransport,
) => {
  const timeoutMillis = connection.requestTimeoutMs ?? 30_000
  const deadline = transport.now() + timeoutMillis
  const delay = <A>(remaining: number, next: () => Promise<A>): Promise<A> =>
    transport.sleep(Math.min(250, remaining)).then(next)
  const connect = (): Promise<SdkHandle> => {
    const remaining = deadline - transport.now()
    if (remaining <= 0) return Promise.reject(new Error("secure sandbox traffic access did not become ready"))
    return transport
      .connect(sandboxId, {
        ...connection,
        requestTimeoutMs: Math.max(1, Math.min(2_000, remaining)),
      })
      .then(
        (sandbox) => (sandbox.trafficAccessToken === undefined ? delay(remaining, connect) : sandbox),
        () => delay(remaining, connect),
      )
  }
  return connect().then((sandbox) => {
    if (sandbox.trafficAccessToken === undefined)
      throw new Error("secure sandbox did not provide a traffic access token")
    const headers = bootstrapHeaders(sandbox.trafficAccessToken)
    const retry = (): Promise<void> => {
      const remaining = deadline - transport.now()
      if (remaining <= 0) return Promise.reject(new Error("bootstrap endpoint did not become ready"))
      return transport
        .fetch(new URL("/health", url), {
          headers,
          signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, remaining))),
        })
        .then(
          (response) => (response.ok ? undefined : response.text().then(() => delay(remaining, retry))),
          () => delay(remaining, retry),
        )
    }
    return retry()
      .then(() =>
        transport.fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(Math.max(1, deadline - transport.now())),
        }),
      )
      .then((response) => {
        if (!response.ok) throw new Error(`bootstrap endpoint returned ${response.status}`)
      })
  })
}

const liveSdk: Sdk = {
  templateTags: (templateId, options) => Template.getTags(templateId, options),
  buildStatus: (templateId, buildId, options) =>
    Template.getBuildStatus({ templateId, buildId }, options).then((status) => ({
      templateId: status.templateID,
      buildId: status.buildID,
      status: status.status,
    })),
  create: (templateId, options) => Sandbox.create(templateId, options),
  getInfo: (sandboxId, options) => Sandbox.getInfo(sandboxId, options),
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  pause: (sandboxId, options) => Sandbox.pause(sandboxId, options),
  kill: (sandboxId, options) => Sandbox.kill(sandboxId, options),
  setTimeout: (sandboxId, timeoutMillis, options) => Sandbox.setTimeout(sandboxId, timeoutMillis, options),
  list: (options) => Sandbox.list(options),
  bootstrap: (request) => bootstrapSandbox(request),
}

const managedMetadata = { "rika.managed": "e2b-executor" } as const
const bootstrapUrl = (sandboxId: string, domain = "e2b.app") => `https://7070-${sandboxId}.${domain}/.rika/bootstrap`

export const testing = { bootstrapHeaders, bootstrapSandbox, bootstrapUrl } as const

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

  const attestTemplateBuild = Effect.fn("Provider.attestTemplateBuild")(function* (request: {
    readonly operation: "create" | "inventory"
    readonly templateId: string
    readonly templateBuildId: string
  }) {
    const [tags, status] = yield* Effect.all(
      [
        attempt(request.operation, () => sdk.templateTags(request.templateId, connection)),
        attempt(request.operation, () => sdk.buildStatus(request.templateId, request.templateBuildId, connection)),
      ],
      { concurrency: 2 },
    )
    const defaultTag = tags.find((tag) => tag.tag === "default")
    if (
      defaultTag?.buildId !== request.templateBuildId ||
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
        body: JSON.stringify({ credential, identity: request.identity }),
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

  return Provider.of({ create, bootstrap, connect, pauseFilesystem, kill, touch, inventory })
}

export const make = (options: Options): Interface => makeProvider(options, liveSdk)

export const makeWithSdk = (input: { readonly options: Options; readonly sdk: Sdk }): Interface =>
  makeProvider(input.options, input.sdk)

export const layer = (options: Options): Layer.Layer<Provider> => Layer.succeed(Provider, make(options))
