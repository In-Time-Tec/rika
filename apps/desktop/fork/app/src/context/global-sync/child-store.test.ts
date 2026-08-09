import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot, getOwner, type Owner } from "solid-js"
import { createStore } from "solid-js/store"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import type { State } from "./types"
import type { QueryOptionsApi } from "../server-sync"
import { ServerScope } from "@/utils/server-scope"

let createChildStoreManager: typeof import("./child-store").createChildStoreManager
const querySingles: Array<() => { queryKey?: unknown[]; enabled?: boolean }> = []
const persist: typeof import("@/utils/persist").persisted = (_target, store) => [
  store[0],
  store[1],
  null,
  Object.assign(() => true, { promise: undefined }),
]

const child = () => createStore({} as State)
const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

const queryOptionsApi = {
  globalConfig: () => ({ queryKey: ["globalConfig"], queryFn: async () => ({}) }),
  projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }),
  providers: (directory: string | null) => ({ queryKey: [directory, "providers"], queryFn: async () => provider }),
  path: (directory: string | null) => ({
    queryKey: [directory, "path"],
    queryFn: async () => ({
      state: "",
      config: "",
      worktree: "",
      directory: directory ?? "",
      home: "",
    }),
  }),
  agents: (directory: string) => ({ queryKey: [directory, "agents"], queryFn: async () => [] }),
  references: (directory: string) => ({ queryKey: [directory, "references"], queryFn: async () => [] }),
  sessions: (directory: string) => ({ queryKey: [directory, "loadSessions"] as const }),
} as unknown as QueryOptionsApi

function createOwner(callback: (owner: Owner) => void) {
  return createRoot((dispose) => {
    const owner = getOwner()
    if (!owner) throw new Error("owner required")
    callback(owner)

    return dispose
  })
}

beforeAll(async () => {
  mock.module("@tanstack/solid-query", () => ({
    useQuery: (options: () => { queryKey?: unknown[]; enabled?: boolean }) => {
      querySingles.push(options)
      return {
        get isLoading() {
          return options().queryKey?.[1] === "path"
        },
        get data() {
          if (options().queryKey?.[1] === "path") throw new Error("pending path data read")
          if (options().queryKey?.[1] === "providers") return provider
          return undefined
        },
      }
    },
  }))

  createChildStoreManager = (await import("./child-store")).createChildStoreManager
})

describe("createChildStoreManager", () => {
  test("does not evict the active directory during mark", () => {
    const owner = createRoot((dispose) => {
      const current = getOwner()
      dispose()
      return current
    })
    if (!owner) throw new Error("owner required")

    const manager = createChildStoreManager({
      owner,
      scope: ServerScope.local,
      persist,
      isBooting: () => false,
      isLoadingSessions: () => false,
      onBootstrap() {},
      onDispose() {},
      translate: (key) => key,
      queryOptions: queryOptionsApi,
      global: { provider },
    })

    Array.from({ length: 30 }, (_, index) => `/pinned-${index}`).forEach((directory) => {
      manager.children[directory] = child()
      manager.pin(directory)
    })

    const directory = "/active"
    manager.children[directory] = child()
    manager.mark(directory)

    expect(manager.children[directory]).toBeDefined()
  })

  test("starts new child stores as loading and bootstraps them on first access", () => {
    const bootstraps: string[] = []
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps.push(directory)
        },
         onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project")

      expect(store.status).toBe("loading")
      expect(store.limit).toBe(5)
      expect(bootstraps).toEqual(["/project"])
    } finally {
      dispose()
    }
  })

  test("provides the requested directory while the path query is pending", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
         onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project", { bootstrap: false })

      expect(store.path.directory).toBe("/project")
      expect(store.path.worktree).toBe("")
    } finally {
      dispose()
    }
  })

  test("keeps non-bootstrapping children passive until a real directory access", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const offset = querySingles.length
    const bootstraps: string[] = []

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps.push(directory)
        },
         onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const [store] = manager.child("/project", { bootstrap: false })
      const queries = querySingles.slice(offset)

      expect(queries).toHaveLength(3)
      expect(queries[0]?.().enabled).toBe(false)
      expect(queries[1]?.().enabled).toBe(false)
      expect(queries[2]?.().enabled).toBe(false)
      expect(store.path.directory).toBe("/project")
      expect(store.provider_ready).toBe(false)

      expect(bootstraps).toEqual([])

      manager.child("/project")
      expect(queries[0]?.().enabled).toBe(true)
      expect(queries[1]?.().enabled).toBe(true)
      expect(queries[2]?.().enabled).toBe(true)

      expect(bootstraps).toEqual(["/project"])

      manager.child("/project", { bootstrap: false })
      expect(queries[0]?.().enabled).toBe(true)
    } finally {
      dispose()
    }
  })
})
