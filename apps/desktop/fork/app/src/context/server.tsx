import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, createMemo } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"
import { ServerScope } from "@/utils/server-scope"
import type { RikaConnectionInput } from "@/rika/connection"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer =
  | string
  | ServerConnection.HttpBase
  | ServerConnection.Http
  | ServerConnection.Ssh
  | ServerConnection.Rika
type ServerProjectState = {
  projects: Record<string, StoredProject[]>
  lastProject: Record<string, string>
  recentlyClosed: Record<string, string[]>
}
// The store retains more history than is displayed. Consumers filter recently closed entries
// against the live project list (dropping deleted projects) and then cap the visible count via
// RECENTLY_CLOSED_DISPLAY_LIMIT. Retaining extra history ensures entries that are temporarily
// filtered out do not evict still-visible ones from the persisted store.
const RECENTLY_CLOSED_HISTORY_LIMIT = 16
export const RECENTLY_CLOSED_DISPLAY_LIMIT = 5

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function migrateCanonicalLocalServerState(value: unknown, canonicalLocalServer?: ServerConnection.Key) {
  if (!isRecord(value)) return value

  // The built-in server used `sidecar` before the native Rika transport. Keep that
  // bucket migration-only so existing local projects remain available after the
  // connection key changes to `rika`.
  const aliases = new Set<string>(["sidecar"])
  if (canonicalLocalServer && canonicalLocalServer !== "local") aliases.add(canonicalLocalServer)

  const projects = isRecord(value.projects) ? value.projects : undefined
  const lastProject = isRecord(value.lastProject) ? value.lastProject : undefined
  const projectAliases = projects
    ? [...aliases].filter((key) => Object.prototype.hasOwnProperty.call(projects, key))
    : []
  const lastProjectAliases = lastProject
    ? [...aliases].filter((key) => Object.prototype.hasOwnProperty.call(lastProject, key))
    : []
  if (projectAliases.length === 0 && lastProjectAliases.length === 0) return value

  const next = { ...value }
  if (projects && projectAliases.length > 0) {
    const local = Array.isArray(projects.local) ? projects.local : []
    const worktrees = new Set(
      local.flatMap((project) => (isRecord(project) && typeof project.worktree === "string" ? [project.worktree] : [])),
    )
    const migrated = projectAliases.flatMap((alias) => {
      const previous = projects[alias]
      if (!Array.isArray(previous)) return []
      return previous.filter((project) => {
        if (!isRecord(project) || typeof project.worktree !== "string") return true
        if (worktrees.has(project.worktree)) return false
        worktrees.add(project.worktree)
        return true
      })
    })
    const nextProjects: Record<string, unknown> = { ...projects, local: [...local, ...migrated] }
    for (const alias of projectAliases) delete nextProjects[alias]
    next.projects = nextProjects
  }
  if (lastProject && lastProjectAliases.length > 0) {
    const nextLastProject = { ...lastProject }
    if (typeof nextLastProject.local !== "string") {
      for (const alias of lastProjectAliases) {
        const previous = nextLastProject[alias]
        if (typeof previous === "string") {
          nextLastProject.local = previous
          break
        }
      }
    }
    for (const alias of lastProjectAliases) delete nextLastProject[alias]
    next.lastProject = nextLastProject
  }
  return next
}

/**
 * Migrate the persisted server bucket without carrying legacy connection records forward.
 *
 * HTTP/SSH entries are still accepted by the storage shape above so old data can be parsed,
 * but they must not remain in the active store (or retain their credentials at rest). Native
 * Rika descriptors are kept byte-for-byte so their transport URL, token, and identity survive
 * startup/persistence migration.
 */
export function migrateServerState(value: unknown, canonicalLocalServer?: ServerConnection.Key) {
  const migrated = migrateCanonicalLocalServerState(value, canonicalLocalServer)
  if (!isRecord(migrated)) return migrated

  const list = Array.isArray(migrated.list) ? migrated.list.filter(isRikaConnection) : []
  // Rika currently uses the canonical `rika` key. Keep that bucket even when the descriptor
  // came from startup props rather than persistence; it is the only native server scope.
  const serverKeys = new Set<ServerConnection.Key>([
    ServerConnection.Key.make("local"),
    ServerConnection.Key.make("rika"),
    ...list.map(ServerConnection.key),
  ])

  const filterScopes = (input: unknown) => {
    if (!isRecord(input)) return input
    return Object.fromEntries(Object.entries(input).filter(([key]) => serverKeys.has(ServerConnection.Key.make(key))))
  }

  const projects = filterScopes(migrated.projects)
  const lastProject = filterScopes(migrated.lastProject)
  const recentlyClosed = filterScopes(migrated.recentlyClosed)
  return {
    ...migrated,
    list,
    projects,
    lastProject,
    recentlyClosed,
  }
}

export function createServerProjects<T extends ServerProjectState>(input: {
  scope: Accessor<ServerScope>
  store: Store<T>
  setStore: SetStoreFunction<T>
}) {
  const setStore = input.setStore as unknown as SetStoreFunction<ServerProjectState>
  const current = () => input.store.projects[input.scope()] ?? []
  const currentClosed = () => input.store.recentlyClosed?.[input.scope()] ?? []
  const remove = (directory: string) => {
    setStore(
      "projects",
      input.scope(),
      current().filter((project) => project.worktree !== directory),
    )
  }
  return {
    list: current,
    recentlyClosed: currentClosed,
    remove,
    open(directory: string) {
      const scope = input.scope()
      const key = pathKey(directory)
      const closed = currentClosed()
      if (closed.some((worktree) => pathKey(worktree) === key)) {
        setStore(
          "recentlyClosed",
          scope,
          closed.filter((worktree) => pathKey(worktree) !== key),
        )
      }
      if (current().some((project) => project.worktree === directory)) return
      setStore("projects", scope, [{ worktree: directory, expanded: true }, ...current()])
    },
    // User-initiated close: removes the project and records it in recently closed.
    // Internal, non-user removals (e.g. sandbox/worktree normalization) should use remove().
    close(directory: string) {
      remove(directory)
      const key = pathKey(directory)
      const closed = [directory, ...currentClosed().filter((worktree) => pathKey(worktree) !== key)].slice(
        0,
        RECENTLY_CLOSED_HISTORY_LIMIT,
      )
      setStore("recentlyClosed", input.scope(), closed)
    },
    expand(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", true)
    },
    collapse(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", false)
    },
    move(directory: string, toIndex: number) {
      const fromIndex = current().findIndex((project) => project.worktree === directory)
      if (fromIndex === -1 || fromIndex === toIndex) return
      const next = [...current()]
      const [item] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, item)
      setStore("projects", input.scope(), next)
    },
    last() {
      return input.store.lastProject[input.scope()]
    },
    touch(directory: string) {
      setStore("lastProject", input.scope(), directory)
    },
  }
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: StoredServer[]
}): Array<ServerConnection.Rika> {
  const deduped = new Map<ServerConnection.Key, ServerConnection.Rika>()

  for (const conn of input.props ?? []) {
    if (conn.type !== "rika") continue
    deduped.set(ServerConnection.key(conn), conn)
  }

  for (const value of input.stored) {
    if (!isRikaConnection(value)) continue
    const key = ServerConnection.key(value)
    if (!deduped.has(key)) deduped.set(key, value)
  }

  return [...deduped.values()]
}

function isRikaConnection(value: unknown): value is ServerConnection.Rika {
  if (!isRecord(value) || value.type !== "rika") return false
  if (!isRecord(value.http) || typeof value.http.url !== "string") return false
  if (!isRecord(value.rika)) return false
  return (
    typeof value.rika.url === "string" &&
    typeof value.rika.token === "string" &&
    typeof value.rika.identity === "string"
  )
}

export namespace ServerConnection {
  type Base = { displayName?: string; label?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
    authToken?: boolean
  } & Base

  export type Rika = {
    type: "rika"
    // Native connections authenticate with their Rika token, never HTTP Basic auth.
    http: Pick<HttpBase, "url">
    rika: RikaConnectionInput
  } & Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Rika | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "rika":
        return Key.make("rika")
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }

  export const builtin = (conn: Any) => conn.type === "rika"
  export const local = (conn?: Any) =>
    !!conn && (builtin(conn) || (conn.type === "http" && isLocalHost(conn.http.url) === "local"))
}

export function nextServerAfterRemoval(
  servers: ServerConnection.Any[],
  removed: ServerConnection.Key,
  fallback: ServerConnection.Key,
) {
  const remaining = servers.filter((server) => ServerConnection.key(server) !== removed)
  const next = remaining.find((server) => ServerConnection.key(server) === fallback) ?? remaining[0]
  return next ? ServerConnection.key(next) : fallback
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  gate: true,
  init: (props: {
    defaultServer: ServerConnection.Key
    canonicalLocalServer?: ServerConnection.Key
    servers?: Array<ServerConnection.Any>
  }) => {
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("server", ["server.v3"]),
        migrate: (value) => migrateServerState(value, props.canonicalLocalServer),
      },
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
        recentlyClosed: {} as Record<string, string[]>,
      }),
    )

    const allServers = createMemo((): Array<ServerConnection.Rika> => {
      return resolveServerList({ stored: store.list, props: props.servers })
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
    })

    function setActive(input: ServerConnection.Key) {
      if (state.active !== input) setState("active", input)
    }

    const isReady = Object.assign(
      createMemo(() => ready() && !!state.active),
      { promise: ready.promise },
    )

    const scope = (key = state.active) => ServerScope.fromServerKey(key, props.canonicalLocalServer)
    const projects = createServerProjects({ scope, store, setStore })
    const projectStores = new Map<ServerConnection.Key, ReturnType<typeof createServerProjects>>()
    const projectsForServer = (key: ServerConnection.Key) => {
      const existing = projectStores.get(key)
      if (existing) return existing
      const next = createServerProjects({ scope: () => scope(key), store, setStore })
      projectStores.set(key, next)
      return next
    }
    const current: Accessor<ServerConnection.Rika | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )
    const isLocal = createMemo(() => ServerConnection.local(current()))

    return {
      ready: isReady,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      scope,
      projects: {
        ...projects,
        forServer: projectsForServer,
      },
    }
  },
})
