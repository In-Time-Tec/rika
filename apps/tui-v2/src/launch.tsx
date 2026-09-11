/* oxlint-disable effecttsgo/strict-effect-provide -- launch is the application composition boundary. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- Bun's DOM-compatible WebSocket global omits its headers overload. */
/* oxlint-disable complexity -- client composition validates credentials and wires owned transport services. */
/* oxlint-disable effecttsgo/global-fetch -- the owning Bun process supplies the Fetch primitive to this launch boundary. */
import { CliRenderEvents, createCliRenderer } from "@opentui/core"
import type { CliRendererErrorEvent, CliRendererHandlerErrorEvent } from "@opentui/core"
import { render } from "@opentui/solid"
import { Config, Console, Crypto, Data, Deferred, Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ErrorBoundary } from "solid-js"
import { makeExecutionClient, makeGeneralistClient, type GeneralistTransportAuth } from "@rika/client/generalist"
import { makeFileCredentialAuth, type FileCredentialAuth } from "@rika/client/credentials"
import { makeFetchTransport, makeProductClient, type ProductClient } from "@rika/client/product"
import { makeRunnerClient, type RunnerClient } from "@rika/client/runner"
import { makeWorkspaceSeedClient, type WorkspaceSeedClient } from "@rika/client/workspace-seeds"
import { createArchive, encodeArchive } from "@rika/workspace-input/archive"
import { App } from "./app"
import {
  Installation,
  layer as installationLayer,
  type InstallationRequest,
  type PreparedInstallation,
} from "./client/installation"
import type { Client, ScenarioId } from "./client/model"
import { runnerSupervisor, type RunnerSupervisorOptions } from "./client/runners"
import { createThreadClient, type ThreadCreationOptions } from "./client/threads"
import { createClient } from "./client/runtime"
import { captureExitReceipt, captureOnlineExitReceipt, renderExitReceipt, type ExitReceipt } from "./exit-receipt"

type BunWebSocketOptions = {
  protocols?: string[]
  headers?: Readonly<Record<string, string>>
}

type BunWebSocketConstructor = new (url: string, options?: BunWebSocketOptions) => globalThis.WebSocket

// SAFETY: the packaged TUI runs under Bun, whose WebSocket constructor accepts the options form below.
const bunWebSocket = globalThis.WebSocket as BunWebSocketConstructor

interface GeneralistClientOptions {
  readonly baseUrl: string
  auth?: GeneralistTransportAuth
}

export interface LaunchOptions {
  readonly scenario: ScenarioId
  readonly animate: boolean
  readonly connection?: {
    readonly apiUrl: string
    readonly workspace: string
    readonly target: "runner" | "orb"
    /** Credentials are resolved by the owning application, never parsed from argv by the TUI. */
    readonly auth?: FileCredentialAuth
    readonly threadId?: string
    readonly creation?: ThreadCreationOptions
    readonly initialPrompt?: string
  }
}
class TerminalFailure extends Data.TaggedError("TerminalFailure")<{
  readonly message: string
}> {}

interface StartupThread {
  readonly id: string
  readonly target: "runner" | "orb"
}

export interface OnlineStartupOptions {
  readonly workspace: string
  readonly target: "runner" | "orb"
  readonly threadId?: string
  readonly callerId: string
  readonly deviceId: string
  readonly creation?: ThreadCreationOptions
  readonly product: Pick<ProductClient, "identity" | "createThread" | "thread">
  readonly runner: Pick<RunnerClient, "register">
  readonly workspaceSeeds?: Pick<WorkspaceSeedClient, "stage">
}

export interface OnlineStartup {
  readonly installation: PreparedInstallation
  readonly creation: ThreadCreationOptions
  readonly thread: StartupThread
}

const asTerminalFailure = (error: { readonly message: string }) => new TerminalFailure({ message: error.message })

export const prepareOnlineStartup = Effect.fn("TuiV2.prepareOnlineStartup")(function* (options: OnlineStartupOptions) {
  yield* options.product.identity.pipe(Effect.mapError(asTerminalFailure))
  const installations = yield* Installation
  const installationRequest: InstallationRequest = {
    deviceId: options.deviceId,
    workspace: options.workspace,
  }
  if (options.creation?.projectId !== undefined)
    Object.assign(installationRequest, { projectId: options.creation.projectId })
  const installation = yield* installations.prepare(installationRequest).pipe(Effect.mapError(asTerminalFailure))
  const actualRunnerTarget = {
    deviceId: installation.deviceId,
    checkoutFingerprint: installation.checkoutFingerprint,
  }
  const providedRunnerTarget = options.creation?.runnerTarget
  if (
    providedRunnerTarget !== undefined &&
    (providedRunnerTarget.deviceId !== actualRunnerTarget.deviceId ||
      providedRunnerTarget.checkoutFingerprint !== actualRunnerTarget.checkoutFingerprint)
  )
    return yield* new TerminalFailure({ message: "Thread creation targets a different local Runner installation" })
  const creation: ThreadCreationOptions = {
    owner: options.creation?.owner ?? { kind: "personal" },
    runnerTarget: actualRunnerTarget,
  }
  if (options.creation?.projectId !== undefined) Object.assign(creation, { projectId: options.creation.projectId })
  yield* options.runner
    .register({ checkoutFingerprint: installation.checkoutFingerprint, profile: installation.profile })
    .pipe(Effect.mapError(asTerminalFailure))
  if (options.threadId !== undefined) {
    const thread = yield* options.product.thread(options.threadId).pipe(Effect.mapError(asTerminalFailure))
    return { installation, creation, thread }
  }
  let request: Parameters<ProductClient["createThread"]>[0]
  if (options.target === "runner")
    request = { owner: creation.owner, threadId: options.callerId, target: "runner", runnerTarget: actualRunnerTarget }
  else {
    const workspaceSeeds = options.workspaceSeeds
    if (workspaceSeeds === undefined)
      return yield* new TerminalFailure({
        message: "A Box Thread requires staging the local checkout as a Workspace seed",
      })
    const archive = yield* createArchive(installation.workspacePath).pipe(Effect.mapError(asTerminalFailure))
    const seed: Parameters<WorkspaceSeedClient["stage"]>[0] = {
      owner: creation.owner,
      archive: encodeArchive(archive),
    }
    if (creation.projectId !== undefined) Object.assign(seed, { projectId: creation.projectId })
    const staged = yield* workspaceSeeds.stage(seed).pipe(Effect.mapError(asTerminalFailure))
    request = {
      owner: creation.owner,
      threadId: options.callerId,
      target: "orb",
      workspaceSeedId: staged.workspaceSeedId,
    }
  }
  if (creation.projectId !== undefined) Object.assign(request, { projectId: creation.projectId })
  const receipt = yield* options.product.createThread(request).pipe(Effect.mapError(asTerminalFailure))
  if (receipt.threadId !== options.callerId)
    return yield* new TerminalFailure({ message: "Thread creation returned a different caller identity" })
  return { installation, creation, thread: { id: receipt.threadId, target: options.target } }
})

interface ClientResource {
  readonly client: Client
  readonly workspace: string
  readonly apiUrl?: string
  readonly dispose: Effect.Effect<void>
}

const makeSocket = (url: string, protocols?: string | string[], headers?: Readonly<Record<string, string>>) => {
  const socketOptions: BunWebSocketOptions = {}
  if (protocols !== undefined) socketOptions.protocols = Array.isArray(protocols) ? protocols : [protocols]
  if (headers !== undefined) socketOptions.headers = headers
  return new bunWebSocket(url, socketOptions)
}

const makeOnlineResource = Effect.fn("TuiV2.makeOnlineResource")(function* (
  connection: NonNullable<LaunchOptions["connection"]>,
) {
  const fetch = globalThis.fetch
  const auth =
    connection.auth ??
    (yield* makeFileCredentialAuth({ origin: connection.apiUrl, fetch }).pipe(Effect.mapError(asTerminalFailure)))
  const requestHeaders = auth.requestHeaders
  if (requestHeaders === undefined)
    return yield* new TerminalFailure({ message: "HTTP credentials were not provided by the owning application" })
  const webSocketHeaders = auth.webSocketHeaders
  if (webSocketHeaders === undefined)
    return yield* new TerminalFailure({ message: "WebSocket credentials were not provided by the owning application" })
  const transport = makeFetchTransport((request) => fetch(request))
  const product = makeProductClient({ baseUrl: connection.apiUrl, transport, requestHeaders })
  const runner = makeRunnerClient({ baseUrl: connection.apiUrl, transport, requestHeaders })
  const workspaceSeeds = makeWorkspaceSeedClient({ baseUrl: connection.apiUrl, transport, requestHeaders })
  const crypto = yield* Crypto.Crypto
  const callerId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(asTerminalFailure))
  const startupOptions: OnlineStartupOptions = {
    workspace: connection.workspace,
    target: connection.target,
    callerId,
    deviceId: auth.deviceId,
    product,
    runner,
    workspaceSeeds,
  }
  if (connection.threadId !== undefined) Object.assign(startupOptions, { threadId: connection.threadId })
  if (connection.creation !== undefined) Object.assign(startupOptions, { creation: connection.creation })
  const startup = yield* prepareOnlineStartup(startupOptions)
  const runtimeUrl = (id: string) =>
    new URL(`/api/v2/threads/${encodeURIComponent(id)}/runtime`, connection.apiUrl).toString()
  const buildExecution = (id: string) => {
    const generalistOptions: GeneralistClientOptions = { baseUrl: runtimeUrl(id), auth }
    return makeGeneralistClient(generalistOptions).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.map(makeExecutionClient),
    )
  }
  const connect = (request: Parameters<RunnerSupervisorOptions["connect"]>[0]) =>
    makeSocket(request.url, [...request.protocols], request.headers)
  const runners = yield* runnerSupervisor({ installation: startup.installation, client: runner, connect })
  const clientOptions: Parameters<typeof createThreadClient>[0] = {
    product,
    executionForThread: (thread) => runners.ensure(thread).pipe(Effect.andThen(buildExecution(thread.id))),
    webSocketConstructor: makeSocket,
    webSocketHeaders,
    initialThreadId: startup.thread.id,
    creation: startup.creation,
    workspaceSeeds,
    workspace: startup.installation.workspacePath,
  }
  if (connection.initialPrompt !== undefined) Object.assign(clientOptions, { initialPrompt: connection.initialPrompt })
  return {
    client: createThreadClient(clientOptions),
    workspace: startup.installation.workspacePath,
    apiUrl: connection.apiUrl,
    dispose: runners.dispose,
  }
})

const runTui = Effect.fn("TuiV2.runTui")(function* (options: LaunchOptions) {
  const offlineWorkspace = yield* Config.string("INIT_CWD").pipe(Config.withDefault(process.cwd()))
  let receipt: ExitReceipt | undefined
  const quit = yield* Deferred.make<void, TerminalFailure>()
  const makeResource =
    options.connection === undefined
      ? Effect.sync<ClientResource>(() => ({
          client: createClient({ scenario: options.scenario }),
          workspace: offlineWorkspace,
          dispose: Effect.void,
        }))
      : makeOnlineResource(options.connection)
  const resource = yield* Effect.acquireRelease(makeResource, (current) =>
    current.client.dispose.pipe(Effect.andThen(current.dispose)),
  )
  const client = resource.client
  const captureReceipt = () =>
    resource.apiUrl === undefined
      ? captureExitReceipt(client.state, resource.workspace)
      : captureOnlineExitReceipt(client.state, resource.workspace, resource.apiUrl)
  const captureArchivedReceipt = () => {
    const current = captureReceipt()
    return resource.apiUrl === undefined ? current : { ...current, online: { apiUrl: resource.apiUrl } }
  }
  const onQuit = () => {
    receipt ??= captureReceipt()
    Deferred.doneUnsafe(quit, Effect.void)
  }
  const viewClient: Client = {
    ...client,
    archiveThread: (onArchived) => {
      if (onArchived === undefined) return client.archiveThread()
      client.archiveThread(() => {
        receipt = captureArchivedReceipt()
        onArchived()
      })
    },
    archiveAndNewThread: (onCreated) => {
      receipt = undefined
      client.archiveAndNewThread(onCreated)
    },
    newThread: (target?: "runner" | "orb") => {
      receipt = undefined
      client.newThread(target)
    },
  }
  const renderer = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        createCliRenderer({
          backgroundColor: "transparent",
          screenMode: "alternate-screen",
          exitOnCtrlC: false,
          exitSignals: [],
          useMouse: true,
          enableMouseMovement: true,
          openConsoleOnError: false,
          onDestroy: onQuit,
        }),
      catch: (cause) => new TerminalFailure({ message: String(cause) }),
    }),
    (current) => Effect.sync(() => current.destroy()),
  )
  const fail = (event: CliRendererErrorEvent | CliRendererHandlerErrorEvent) => {
    Deferred.doneUnsafe(quit, Effect.fail(new TerminalFailure({ message: String(event.error) })))
  }
  renderer.on(CliRenderEvents.RENDER_ERROR, fail)
  renderer.on(CliRenderEvents.HANDLER_ERROR, fail)
  yield* Effect.tryPromise({
    try: () =>
      render(
        () => (
          <ErrorBoundary
            fallback={(error: Error) => {
              Deferred.doneUnsafe(quit, Effect.fail(new TerminalFailure({ message: String(error) })))
              return <text>Unable to render the interface.</text>
            }}
          >
            <App client={viewClient} onQuit={onQuit} animate={options.animate} />
          </ErrorBoundary>
        ),
        renderer,
      ),
    catch: (cause) => new TerminalFailure({ message: String(cause) }),
  })
  yield* Deferred.await(quit)
  return receipt ?? captureReceipt()
})

export const launch = Effect.fn("TuiV2.launch")(function* (options: LaunchOptions) {
  const home = yield* Config.string("HOME").pipe(Config.withDefault(process.cwd()))
  const receipt = yield* Effect.scoped(runTui(options).pipe(Effect.provide(installationLayer({ home }))))
  yield* Console.log(renderExitReceipt(receipt))
})
