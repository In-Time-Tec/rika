import { createEffect, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import type { ServerSDK } from "@/context/server-sdk"
import type { ServerSync } from "./server-sync"
import { useParams, useSearchParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { type DraftTab, useTabs } from "./tabs"
import { useSettings } from "./settings"
import { requireServerKey } from "@/utils/session-route"
import type { ServerScope } from "@/utils/server-scope"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "reject"
  directory?: string
}) => void

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasPermissionPromptRules(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  return Object.values(config).some(isNonAllowRule)
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  gate: false,
  init: () => {
    const params = useParams<{ serverKey?: string; dir?: string; id?: string }>()
    const [search] = useSearchParams<{ draftId?: string }>()
    const global = useGlobal()
    const server = useServer()
    const tabs = useTabs()
    const settings = useSettings()
    const owner = getOwner()
    const states = new Map<ServerScope, { key: ServerConnection.Key; dispose: () => void; state: PermissionState }>()

    const activeDraft = createMemo(() => {
      if (!search.draftId) return
      return tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)
    })

    const activeServer = createMemo(() => {
      if (params.serverKey && settings.general.newLayoutDesigns()) return requireServerKey(params.serverKey)
      return activeDraft()?.server ?? server.key
    })

    const ensure = (key: ServerConnection.Key) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      if (!conn) throw new Error(`Permission server not found: ${key}`)
      const ctx = global.ensureServerCtx(conn)
      const existing = states.get(ctx.sdk.scope)
      if (existing && global.servers.list().some((item) => ServerConnection.key(item) === existing.key)) {
        return existing.state
      }
      if (existing) {
        existing.dispose()
        states.delete(ctx.sdk.scope)
      }
      const root = createRoot(
        (dispose) => ({
          key,
          dispose,
          state: createServerPermissionState({ sdk: ctx.sdk, sync: ctx.sync }),
        }),
        owner ?? undefined,
      )
      states.set(ctx.sdk.scope, root)
      return root.state
    }

    createEffect(() => {
      global.servers.list().forEach((conn) => ensure(ServerConnection.key(conn)))
    })

    createEffect(() => {
      const list = global.servers.list()
      const keys = new Set(list.map(ServerConnection.key))
      states.forEach((value, scope) => {
        if (keys.has(value.key)) return
        value.dispose()
        states.delete(scope)
        const replacement = list.find((conn) => server.scope(ServerConnection.key(conn)) === scope)
        if (replacement) ensure(ServerConnection.key(replacement))
      })
    })

    onCleanup(() => states.forEach((value) => value.dispose()))

    let lastSelected: PermissionState | undefined
    const selected = () => {
      const key = activeServer()
      if (global.servers.list().some((conn) => ServerConnection.key(conn) === key)) {
        lastSelected = ensure(key)
      }
      if (lastSelected) return lastSelected
      return ensure(server.key)
    }
    const activeDirectory = createMemo(() => {
      const directory = decode64(params.dir)
      if (directory) return directory
      const draft = activeDraft()
      if (draft) return draft.directory
      if (!params.id) return
      if (!global.servers.list().some((conn) => ServerConnection.key(conn) === activeServer())) return
      return selected().sync.session.lineage.peek(params.id)?.session.directory
    })

    const permissionsEnabled = createMemo(() => {
      const directory = activeDirectory()
      if (!directory) return false
      return selected().permissionsEnabled(directory)
    })

    return {
      ready: () => selected().ready(),
      ensureServerState: (key: ServerConnection.Key) => ensure(key).api,
      currentServerState: () => selected().api,
      respond(input: Parameters<PermissionRespondFn>[0]) {
        selected().respond(input)
      },
      permissionsEnabled,
    }
  },
})

type PermissionState = ReturnType<typeof createServerPermissionState>

function createServerPermissionState(input: { sdk: ServerSDK; sync: ServerSync }) {
  const meta = { disposed: false }

  const respond: PermissionRespondFn = (request) => {
    if (meta.disposed) return
    void input.sdk.api.permission
      .reply({
        sessionID: request.sessionID,
        requestID: request.permissionID,
        reply: request.response,
        location: request.directory ? { directory: request.directory } : undefined,
      })
      .catch(() => undefined)
  }

  onCleanup(() => {
    meta.disposed = true
  })

  const api = {
    ready: () => !meta.disposed,
    respond,
  }

  return {
    ...api,
    api,
    sync: input.sync,
    permissionsEnabled(directory: string) {
      if (meta.disposed) return false
      const [childStore] = input.sync.child(directory)
      return hasPermissionPromptRules(childStore.config.permission)
    },
  }
}
