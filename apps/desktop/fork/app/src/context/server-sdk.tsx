import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { type Accessor, createMemo, onCleanup } from "solid-js"
import { Effect } from "effect"
import type { RikaConnection } from "@/rika/connection"
import { makeRikaAdapter, type RikaAdapter } from "@/rika/adapter"
import { useLanguage } from "./language"
import { ServerConnection, useServer } from "./server"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import type { ServerScope } from "@/utils/server-scope"
import type { ServerProtocol } from "@/utils/server-protocol"
import type { CompatibleApi } from "@/utils/server-compat"
import type { ServerApi } from "@/utils/server"
import { createApiFacade, createLegacyFacade, type LegacyClient, type RuntimePromise } from "@/rika/sdk-facade"

export type ServerEvent = Event
type ServerEventEmitter = ReturnType<typeof createGlobalEmitter<{ [key: string]: ServerEvent }>>
export type RikaConnectionOwner = { readonly ready: Promise<RikaConnection> }

type ServerSDKBase = {
  server: ServerConnection.Any
  scope: ServerScope
  protocol: Promise<ServerProtocol>
  protocolKind: Accessor<ServerProtocol | undefined>
  url: string
  client: LegacyClient
  api: CompatibleApi
  currentApi: ServerApi
  event: {
    on: ServerEventEmitter["on"]
    listen: ServerEventEmitter["listen"]
    start: () => Promise<void> | undefined
  }
  createClient: (opts: { readonly directory?: string; readonly throwOnError?: boolean }) => LegacyClient
  directoryRuntime: (directory: string) => RuntimePromise
  adapter: Promise<RikaAdapter>
}

function createServerSdkContextBase(
  server: ServerConnection.Any,
  scope: ServerScope,
  owner: RikaConnectionOwner,
): ServerSDKBase {
  const emitter = createGlobalEmitter<{ [key: string]: ServerEvent }>()
  const adapter = owner.ready.then(({ connection }) =>
    Effect.runPromise(
      makeRikaAdapter(connection, (workspace, events) => {
        for (const event of events) emitter.emit(workspace, event)
      }),
    ),
  )
  let disposed = false
  onCleanup(() => {
    disposed = true
    void adapter.then((value) => Effect.runPromise(value.dispose)).catch(() => undefined)
  })
  const directoryRuntime = (directory: string) => adapter.then((value) => Effect.runPromise(value.directory(directory)))
  const createClient = (opts: { readonly directory?: string }) =>
    createLegacyFacade(adapter, opts.directory === undefined ? undefined : directoryRuntime(opts.directory))
  const api = createApiFacade(adapter)
  const protocol = Promise.resolve("rika" as const)
  return {
    server,
    scope,
    protocol,
    protocolKind: () => "rika",
    url: "rika" in server && server.rika ? server.rika.url : server.http.url,
    client: createClient({}),
    api,
    currentApi: api as unknown as ServerApi,
    event: {
      on: emitter.on.bind(emitter),
      listen: emitter.listen.bind(emitter),
      start: () => (disposed ? undefined : adapter.then(() => undefined)),
    },
    createClient,
    directoryRuntime,
    adapter,
  }
}

export type ServerSDK = ServerSDKBase & {
  ensureDirSdkContext: (directory: string) => ReturnType<typeof createDirSdkContext>
}

export function createServerSdkContext(
  server: ServerConnection.Any,
  scope: ServerScope,
  owner: RikaConnectionOwner,
): ServerSDK {
  const sdk = createServerSdkContextBase(server, scope, owner)
  return Object.assign(sdk, {
    ensureDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, sdk)),
  })
}

export const { use: useServerSDK, provider: ServerSDKProvider } = createSimpleContext({
  name: "ServerSDK",
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()
    const conn = props.server?.() ?? server.current
    if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
    const value = global.ensureServerCtx(conn).sdk
    return () => value
  },
})

export function useServerProtocol() {
  const serverSDK = useServerSDK()
  return createMemo(() => serverSDK().protocolKind())
}

type SDKEventMap = {
  [key in Event["type"]]: Extract<ServerEvent, { type: key }>
}

function createDirSdkContext(directory: string, serverSDK: ServerSDKBase) {
  const runtime = serverSDK.directoryRuntime(directory)
  const emitter = createGlobalEmitter<SDKEventMap>()
  const unsub = serverSDK.event.on(directory, (event) => emitter.emit(event.type, event))
  onCleanup(unsub)
  const api = createApiFacade(serverSDK.adapter, runtime)
  return {
    scope: serverSDK.scope,
    protocol: serverSDK.protocol,
    directory,
    client: createLegacyFacade(serverSDK.adapter, runtime),
    api,
    event: emitter,
    get url() {
      return serverSDK.url
    },
    createClient(opts: { readonly directory?: string; readonly throwOnError?: boolean }) {
      return serverSDK.createClient(opts)
    },
  }
}
