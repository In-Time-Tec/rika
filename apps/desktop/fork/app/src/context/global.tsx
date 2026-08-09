import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, createRoot, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createServerProjects, RECENTLY_CLOSED_DISPLAY_LIMIT, ServerConnection, useServer } from "./server"
import { pathKey } from "@/utils/path-key"
import { createServerSdkContext } from "./server-sdk"
import { createServerSyncContext } from "./server-sync"
import { getOwner } from "solid-js/web"
import { QueryClient } from "@tanstack/solid-query"
import type { ServerScope } from "@/utils/server-scope"
import { Effect, Exit, Scope } from "effect"
import { connectRika } from "@/rika/connection"
import type { RikaConnectionOwner } from "./server-sdk"

export const { use: useGlobal, provider: GlobalProvider } = createSimpleContext({
  name: "Global",
  init: () => {
    const server = useServer()
    const [serverHealth, setServerHealth] = createStore<
      Record<ServerConnection.Key, { healthy: boolean; version?: string } | undefined>
    >({})
    const [store, setStore] = createStore({
      settings: {
        serverKey: undefined as ServerConnection.Key | undefined,
      },
    })

    const settingsServer = createMemo(() => {
      const list = server.list
      return list.find((conn) => ServerConnection.key(conn) === store.settings.serverKey) ?? list[0]
    })

    createEffect(() => {
      const conn = settingsServer()
      const key = conn ? ServerConnection.key(conn) : undefined
      if (store.settings.serverKey !== key) setStore("settings", "serverKey", key)
    })

    const serverCtxs = new Map<
      ServerConnection.Key,
      { dispose: () => void; serverCtx: ReturnType<typeof createServerCtx> }
    >()

    const owner = getOwner()

    const ensureServerCtx = (conn: ServerConnection.Any) => {
      const key = ServerConnection.key(conn)
      const existing = serverCtxs.get(key)
      if (existing) return existing.serverCtx
      const root = createRoot((dispose) => {
        const serverCtx = createServerCtx(conn, server.scope(key), server.projects.forServer(key))
        return { dispose, serverCtx }
      }, owner as any)
      serverCtxs.set(key, root)
      return root.serverCtx
    }

    createEffect(() => {
      const list = server.list
      let disposed = false
      const refresh = () => {
        for (const conn of list) {
          const key = ServerConnection.key(conn)
          void ensureServerCtx(conn)
            .rika.ready.then((value) => Effect.runPromise(value.connection.ping))
            .then(
              () => {
                if (!disposed) setServerHealth(key, { healthy: true, version: "rika" })
              },
              () => {
                if (!disposed) setServerHealth(key, { healthy: false })
              },
            )
        }
      }
      refresh()
      const timer = setInterval(refresh, 10_000)
      onCleanup(() => {
        disposed = true
        clearInterval(timer)
      })
    })

    createMemo(() => {
      for (const conn of server.list) {
        ensureServerCtx(conn)
      }
    })

    createEffect(() => {
      for (const [key] of serverCtxs) {
        if (!server.list.find((conn) => ServerConnection.key(conn) === key)) {
          const { dispose } = serverCtxs.get(key)!
          dispose()
          serverCtxs.delete(key)
        }
      }
    })

    return {
      servers: {
        list: () => server.list,
        health: serverHealth,
      },
      settings: {
        server: {
          get key() {
            return store.settings.serverKey
          },
          selected: settingsServer,
          set(key: ServerConnection.Key) {
            if (store.settings.serverKey !== key) setStore("settings", "serverKey", key)
          },
        },
      },
      ensureServerCtx(conn: ServerConnection.Any) {
        return ensureServerCtx(conn)
      },
    }
  },
})

function createServerCtx(
  conn: ServerConnection.Any,
  scope: ServerScope,
  projects: ReturnType<typeof createServerProjects>,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  const rika = createRikaConnectionOwner(conn)
  const sdk = createServerSdkContext(conn, scope, rika)
  const sync = createServerSyncContext(sdk)

  function enrich(project: { worktree: string; expanded: boolean }) {
    const [childStore] = sync.child(project.worktree, { bootstrap: false })
    const projectID = childStore.project
    const metadata = projectID
      ? sync.data.project.find((x) => x.id === projectID)
      : sync.data.project.find((x) => x.worktree === project.worktree)

    // Preserve local icon override from per-workspace localStorage cache (childStore.icon).
    // Without this, different subdirectories of the same git repo would share the same
    // icon from the database instead of using their individual overrides.
    const base = { ...metadata, ...project }
    if (childStore.icon) {
      return { ...base, icon: { ...base.icon, override: childStore.icon } }
    }
    return base
  }

  const projectsList = createMemo(() => projects.list().map(enrich))
  const recentlyClosedList = createMemo(() => {
    const known = new Set(sync.data.project.map((project) => pathKey(project.worktree)))
    return projects
      .recentlyClosed()
      .filter((worktree) => known.has(pathKey(worktree)))
      .slice(0, RECENTLY_CLOSED_DISPLAY_LIMIT)
      .map((worktree) => enrich({ worktree, expanded: false }))
  })

  const isLocal =
    (conn?.type === "rika") || (conn?.type === "http" && isLocalHost(conn.http.url))

  return {
    queryClient,
    rika,
    sdk,
    sync,
    isLocal,
    projects: {
      ...projects,
      list: projectsList,
      recentlyClosed: recentlyClosedList,
    },
  }
}

export type ServerCtx = ReturnType<typeof createServerCtx>

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

function createRikaConnectionOwner(conn: ServerConnection.Any): RikaConnectionOwner {
  const input = "rika" in conn ? conn.rika : undefined
  const scope = Effect.runPromise(Scope.make())
  const ready = scope.then((value) => {
    if (!input) throw new Error("This desktop build supports only the native Rika server connection")
    return Effect.runPromise(connectRika(input).pipe(Scope.provide(value)))
  })
  onCleanup(() => {
    void Promise.allSettled([
      ready.then((connection) => Effect.runPromise(connection.close)),
      scope.then((value) => Effect.runPromise(Scope.close(value, Exit.void))),
    ])
  })
  return { ready }
}
