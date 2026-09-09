/* oxlint-disable effecttsgo/strict-effect-provide -- launch is the application composition boundary. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- Bun's DOM-compatible WebSocket global omits its headers overload. */
/* oxlint-disable complexity -- hosted composition validates credentials and wires owned transport services. */
/* oxlint-disable effecttsgo/global-fetch -- the owning Bun process supplies the Fetch primitive to this launch boundary. */
import { CliRenderEvents, createCliRenderer } from "@opentui/core"
import type { CliRendererErrorEvent, CliRendererHandlerErrorEvent } from "@opentui/core"
import { render } from "@opentui/solid"
import { Config, Console, Data, Deferred, Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ErrorBoundary } from "solid-js"
import {
  makeExecutionClient,
  makeGeneralistClient,
  type GeneralistTransportAuth,
} from "@rika/client-v2/generalist"
import { makeFileCredentialAuth } from "@rika/client-v2/credentials"
import { makeFetchTransport, makeProductClient, type ProductRequestHeaders } from "@rika/client-v2/product"
import { ThreadClientError } from "@rika/client-v2/thread"
import { App } from "./app"
import type { ScenarioId } from "./client/model"
import { createHostedClient } from "./client/hosted"
import { createClient } from "./client/runtime"
import { captureExitReceipt, renderExitReceipt, type ExitReceipt } from "./exit-receipt"

type BunWebSocketOptions = {
  protocols?: string | string[]
  headers?: Readonly<Record<string, string>>
}

type BunWebSocketConstructor = new (url: string, options?: BunWebSocketOptions) => globalThis.WebSocket

// SAFETY: the packaged TUI runs under Bun, whose WebSocket constructor accepts the options form below.
const bunWebSocket = globalThis.WebSocket as BunWebSocketConstructor

interface HostedProductOptions {
  readonly baseUrl: string
  readonly transport: ReturnType<typeof makeFetchTransport>
  requestHeaders?: ProductRequestHeaders
}

interface HostedGeneralistOptions {
  readonly baseUrl: string
  auth?: GeneralistTransportAuth
}

export interface LaunchOptions {
  readonly scenario: ScenarioId
  readonly animate: boolean
  readonly hosted?: {
    readonly apiUrl: string
    /** Hosted credentials are resolved by the owning application, never parsed from argv by TUI v2. */
    readonly auth?: GeneralistTransportAuth
    readonly threadId?: string
  }
}
class TerminalFailure extends Data.TaggedError("TerminalFailure")<{
  readonly message: string
}> {}

const runTui = Effect.fn("TuiV2.runTui")(function* (options: LaunchOptions) {
  const workspace = yield* Config.string("INIT_CWD").pipe(Config.withDefault(process.cwd()))
  let receipt: ExitReceipt | undefined
  const quit = yield* Deferred.make<void, TerminalFailure>()
  const onQuit = () => {
    receipt ??= captureExitReceipt(client.state, workspace)
    Deferred.doneUnsafe(quit, Effect.void)
  }
  const makeHosted = options.hosted === undefined
    ? Effect.sync(() => createClient({ scenario: options.scenario }))
    : Effect.gen(function* () {
        const hosted = options.hosted!
        const fetch = globalThis.fetch
        const auth =
          hosted.auth ??
          (yield* makeFileCredentialAuth({ origin: hosted.apiUrl, fetch }).pipe(
            Effect.mapError((error) => new TerminalFailure({ message: error.message })),
          ))
        if (auth.requestHeaders === undefined)
          return yield* new TerminalFailure({ message: "Hosted HTTP credentials were not provided by the owning application" })
        if (auth.webSocketHeaders === undefined)
          return yield* new TerminalFailure({ message: "Hosted WebSocket credentials were not provided by the owning application" })
        const productOptions: HostedProductOptions = {
          baseUrl: hosted.apiUrl,
          transport: makeFetchTransport((request) => fetch(request)),
        }
        if (auth.requestHeaders !== undefined) productOptions.requestHeaders = auth.requestHeaders
        const product = makeProductClient(productOptions)
        const page = yield* product.listThreads().pipe(
          Effect.mapError((error) => new TerminalFailure({ message: error.message })),
        )
        const threadId = hosted.threadId ?? page.threads[0]?.id
        if (threadId === undefined)
          return yield* new TerminalFailure({ message: "No hosted Thread is available for this account" })
        const runtimeUrl = (id: string) =>
          new URL(`/api/v2/threads/${encodeURIComponent(id)}/runtime`, hosted.apiUrl).toString()
        const buildExecution = (id: string) => {
          const generalistOptions: HostedGeneralistOptions = { baseUrl: runtimeUrl(id) }
          generalistOptions.auth = auth
          return makeGeneralistClient(generalistOptions).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.map(makeExecutionClient),
            Effect.mapError((error) => new TerminalFailure({ message: String(error) })),
          )
        }
        const execution = yield* buildExecution(threadId)
        const hostedOptions: Parameters<typeof createHostedClient>[0] = {
          product,
          execution,
          executionForThread: (thread) =>
            buildExecution(thread.id).pipe(
              Effect.mapError((error) =>
                ThreadClientError.make({ kind: "network", operation: "execution.create", message: error.message }),
              ),
            ),
          initialThreadId: threadId,
          webSocketConstructor: (url, protocols, headers) => {
            const socketOptions: BunWebSocketOptions = {}
            if (protocols !== undefined) socketOptions.protocols = protocols
            if (headers !== undefined) socketOptions.headers = headers
            return new bunWebSocket(url, socketOptions)
          },
        }
        Object.assign(hostedOptions, { webSocketHeaders: auth.webSocketHeaders })
        return createHostedClient(hostedOptions)
      })
  const client = yield* Effect.acquireRelease(
    makeHosted,
    (resource) => resource.dispose,
  )
  const viewClient = {
    ...client,
    archiveThread: () => {
      receipt = captureExitReceipt(client.state, workspace)
      client.archiveThread()
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
    (resource) => Effect.sync(() => resource.destroy()),
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
  return receipt ?? captureExitReceipt(client.state, workspace)
})

export const launch = Effect.fn("TuiV2.launch")(function* (options: LaunchOptions) {
  const receipt = yield* Effect.scoped(runTui(options))
  yield* Console.log(renderExitReceipt(receipt))
})
