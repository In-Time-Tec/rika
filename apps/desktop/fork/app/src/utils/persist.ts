import { Platform, usePlatform } from "@/context/platform"
import { makePersisted, type AsyncStorage, type SyncStorage } from "@solid-primitives/storage"
import { checksum } from "@opencode-ai/core/util/encode"
import { createResource, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { pathKey } from "@/utils/path-key"
import { ScopedKey, ServerScope, type ServerScope as ServerScopeValue } from "@/utils/server-scope"

type InitType = Promise<string> | string | null
type PersistedWithReady<T> = [
  Store<T>,
  SetStoreFunction<T>,
  InitType,
  Accessor<boolean> & { promise: undefined | Promise<any> },
]

type PersistTarget = {
  draft?: boolean
  storage?: string
  scope?: "window"
  legacyStorageNames?: string[]
  key: string
  legacy?: string[]
  migrate?: (value: unknown) => unknown
}

const LEGACY_STORAGE = "default.dat"
const GLOBAL_STORAGE = "rika.global.dat"
const WINDOW_STORAGE = "rika.window"
const LOCAL_PREFIX = "rika."
const OPENCODE_PREFIX = "opencode."
const fallback = new Map<string, boolean>()

const CACHE_MAX_ENTRIES = 500
const CACHE_MAX_BYTES = 8 * 1024 * 1024

type CacheEntry = { value: string; bytes: number }
const cache = new Map<string, CacheEntry>()
const cacheTotal = { bytes: 0 }

function cacheDelete(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cacheTotal.bytes -= entry.bytes
  cache.delete(key)
}

function cachePrune() {
  for (;;) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheTotal.bytes <= CACHE_MAX_BYTES) return
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) return
    cacheDelete(oldest)
  }
}

function cacheSet(key: string, value: string) {
  const bytes = value.length * 2
  if (bytes > CACHE_MAX_BYTES) {
    cacheDelete(key)
    return
  }

  const entry = cache.get(key)
  if (entry) cacheTotal.bytes -= entry.bytes
  cache.delete(key)
  cache.set(key, { value, bytes })
  cacheTotal.bytes += bytes
  cachePrune()
}

function cacheGet(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function fallbackDisabled(scope: string) {
  return fallback.get(scope) === true
}

function fallbackSet(scope: string) {
  fallback.set(scope, true)
}

function quota(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") return true
    if (error.name === "NS_ERROR_DOM_QUOTA_REACHED") return true
    if (error.name === "QUOTA_EXCEEDED_ERR") return true
    if (error.code === 22 || error.code === 1014) return true
    return false
  }

  if (!error || typeof error !== "object") return false
  const name = (error as { name?: string }).name
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true
  if (name && /quota/i.test(name)) return true

  const code = (error as { code?: number }).code
  if (code === 22 || code === 1014) return true

  const message = (error as { message?: string }).message
  if (typeof message !== "string") return false
  if (/quota/i.test(message)) return true
  return false
}

type Evict = { key: string; size: number }

function evict(storage: Storage, keep: string, value: string) {
  const total = storage.length
  const indexes = Array.from({ length: total }, (_, index) => index)
  const items: Evict[] = []

  for (const index of indexes) {
    const name = storage.key(index)
    if (!name) continue
    if (!name.startsWith(LOCAL_PREFIX)) continue
    if (name === keep) continue
    const stored = storage.getItem(name)
    items.push({ key: name, size: stored?.length ?? 0 })
  }

  items.sort((a, b) => b.size - a.size)

  for (const item of items) {
    storage.removeItem(item.key)
    cacheDelete(item.key)

    try {
      storage.setItem(keep, value)
      cacheSet(keep, value)
      return true
    } catch (error) {
      if (!quota(error)) throw error
    }
  }

  return false
}

function write(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  try {
    storage.removeItem(key)
    cacheDelete(key)
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  const ok = evict(storage, key, value)
  return ok
}

function snapshot(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function merge(defaults: unknown, value: unknown): unknown {
  if (value === undefined) return defaults
  if (value === null) return value

  if (Array.isArray(defaults)) {
    if (Array.isArray(value)) return value
    return defaults
  }

  if (isRecord(defaults)) {
    if (!isRecord(value)) return defaults

    const result: Record<string, unknown> = { ...defaults }
    for (const key of Object.keys(value)) {
      if (key in defaults) {
        result[key] = merge((defaults as Record<string, unknown>)[key], (value as Record<string, unknown>)[key])
      } else {
        result[key] = (value as Record<string, unknown>)[key]
      }
    }
    return result
  }

  return value
}

function parse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function normalize(defaults: unknown, raw: string, migrate?: (value: unknown) => unknown) {
  const parsed = parse(raw)
  if (parsed === undefined) return
  const migrated = migrate ? migrate(parsed) : parsed
  const merged = merge(defaults, migrated)
  return JSON.stringify(merged)
}

function readCurrent(input: {
  storage: SyncStorage
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  const raw = input.storage.getItem(input.key)
  if (raw === null) return
  const next = normalize(input.defaults, raw, input.migrate)
  if (next === undefined) {
    input.storage.removeItem(input.key)
    return null
  }
  if (raw !== next) input.storage.setItem(input.key, next)
  return next
}

function migrateLegacy(input: {
  current: SyncStorage
  legacyStore?: SyncStorage
  stores: SyncStorage[]
  keys: string[]
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  for (const store of input.stores) {
    const raw = store.getItem(input.key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      store.removeItem(input.key)
      continue
    }
    input.current.setItem(input.key, next)
    store.removeItem(input.key)
    return next
  }

  if (!input.legacyStore) return null

  for (const key of input.keys) {
    const raw = input.legacyStore.getItem(key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      input.legacyStore.removeItem(key)
      continue
    }
    input.current.setItem(input.key, next)
    input.legacyStore.removeItem(key)
    return next
  }

  return null
}

async function readCurrentAsync(input: {
  storage: AsyncStorage
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  const raw = await input.storage.getItem(input.key)
  if (raw === null) return
  const next = normalize(input.defaults, raw, input.migrate)
  if (next === undefined) {
    await input.storage.removeItem(input.key).catch(() => undefined)
    return null
  }
  if (raw !== next) await input.storage.setItem(input.key, next)
  return next
}

async function removeAsync(storage: AsyncStorage, key: string) {
  try {
    await storage.removeItem(key)
  } catch {}
}

function toAsyncStorage(storage: SyncStorage | AsyncStorage): AsyncStorage {
  return {
    getItem: async (key) => storage.getItem(key),
    setItem: async (key, value) => storage.setItem(key, value),
    removeItem: async (key) => storage.removeItem(key),
  }
}

async function migrateLegacyAsync(input: {
  current: AsyncStorage
  legacyStore?: AsyncStorage
  stores: AsyncStorage[]
  keys: string[]
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  for (const store of input.stores) {
    const raw = await store.getItem(input.key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      await removeAsync(store, input.key)
      continue
    }
    await input.current.setItem(input.key, next)
    await store.removeItem(input.key)
    return next
  }

  if (!input.legacyStore) return null

  for (const key of input.keys) {
    const raw = await input.legacyStore.getItem(key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      await removeAsync(input.legacyStore, key)
      continue
    }
    await input.current.setItem(input.key, next)
    await input.legacyStore.removeItem(key)
    return next
  }

  return null
}

function workspaceStorage(dir: string) {
  const head = (dir.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(dir) ?? "0"
  return `rika.workspace.${head}.${sum}.dat`
}

function draftStorage(draftID: string) {
  const head = (draftID.slice(0, 12) || "draft").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(draftID) ?? "0"
  return `rika.draft.${head}.${sum}.dat`
}

function windowStorage(windowID: string) {
  const safe = (windowID || "browser").replace(/[^a-zA-Z0-9._-]/g, "-")
  return `${WINDOW_STORAGE}.${safe}.dat`
}

function legacyStorageName(storage: string) {
  if (!storage.startsWith(LOCAL_PREFIX)) return
  return `${OPENCODE_PREFIX}${storage.slice(LOCAL_PREFIX.length)}`
}

function withStorage(
  target: PersistTarget,
  storage: string,
  additionalLegacyStorageNames: string[] = [],
): PersistTarget {
  const legacyStorageNames = new Set<string>()
  const opencode = legacyStorageName(storage)
  if (opencode) legacyStorageNames.add(opencode)

  for (const name of [...(target.legacyStorageNames ?? []), ...additionalLegacyStorageNames]) {
    if (name !== storage) legacyStorageNames.add(name)
    const legacy = legacyStorageName(name)
    if (legacy && legacy !== storage) legacyStorageNames.add(legacy)
  }

  return { ...target, storage, legacyStorageNames: [...legacyStorageNames] }
}

function legacyWorkspaceStorage(dir: string) {
  const storage = workspaceStorage(pathKey(dir))
  const result = new Set<string>()
  const raw = workspaceStorage(dir)
  if (raw !== storage) result.add(raw)

  const key = pathKey(dir)
  const drive = key.length >= 3 && key[1] === ":" && key[2] === "/"
  if (drive) {
    const backslash = workspaceStorage(key.replaceAll("/", "\\"))
    if (backslash !== storage) result.add(backslash)
  }

  return [...result]
}

function serverWorkspaceTarget(scope: ServerScopeValue, dir: string, key: string, legacy?: string[]): PersistTarget {
  const storage = workspaceStorage(scope === ServerScope.local ? pathKey(dir) : ScopedKey.from(scope, pathKey(dir)))
  if (scope !== ServerScope.local) return withStorage({ key }, storage)
  return withStorage({ key, legacy }, storage, legacyWorkspaceStorage(dir))
}

function localStorageWithPrefix(prefix: string): SyncStorage {
  const base = `${prefix}:`
  const scope = `prefix:${prefix}`
  const item = (key: string) => base + key
  return {
    getItem: (key) => {
      const name = item(key)
      const cached = cacheGet(name)
      if (fallbackDisabled(scope)) return cached ?? null

      const stored = (() => {
        try {
          return localStorage.getItem(name)
        } catch {
          fallbackSet(scope)
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(name, stored)
      return stored
    },
    setItem: (key, value) => {
      const name = item(key)
      if (fallbackDisabled(scope)) return
      try {
        if (write(localStorage, name, value)) return
      } catch {
        fallbackSet(scope)
        return
      }
      fallbackSet(scope)
    },
    removeItem: (key) => {
      const name = item(key)
      cacheDelete(name)
      if (fallbackDisabled(scope)) return
      try {
        localStorage.removeItem(name)
      } catch {
        fallbackSet(scope)
      }
    },
  }
}

function localStorageDirect(): SyncStorage {
  const scope = "direct"
  return {
    getItem: (key) => {
      const cached = cacheGet(key)
      if (fallbackDisabled(scope)) return cached ?? null

      const stored = (() => {
        try {
          return localStorage.getItem(key)
        } catch {
          fallbackSet(scope)
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(key, stored)
      return stored
    },
    setItem: (key, value) => {
      if (fallbackDisabled(scope)) return
      try {
        if (write(localStorage, key, value)) return
      } catch {
        fallbackSet(scope)
        return
      }
      fallbackSet(scope)
    },
    removeItem: (key) => {
      cacheDelete(key)
      if (fallbackDisabled(scope)) return
      try {
        localStorage.removeItem(key)
      } catch {
        fallbackSet(scope)
      }
    },
  }
}

const DRAFT_PERSISTED_KEYS = ["prompt", "comments", "file-view", "layout"]

export function draftPersistedKeys() {
  return DRAFT_PERSISTED_KEYS
}

export const PersistTesting = {
  localStorageDirect,
  localStorageWithPrefix,
  migrateLegacy,
  normalize,
  resolveTarget,
  windowStorage,
  workspaceStorage,
}

export const Persist = {
  global(key: string, legacy?: string[]): PersistTarget {
    return withStorage({ key, legacy }, GLOBAL_STORAGE)
  },
  window(key: string, legacy?: string[]): PersistTarget {
    return { scope: "window", key, legacy }
  },
  draft(draftID: string, key: string, legacy?: string[]): PersistTarget {
    return withStorage({ key: `draft:${key}`, legacy }, draftStorage(draftID))
  },
  serverGlobal(scope: ServerScopeValue, key: string, legacy?: string[]): PersistTarget {
    if (scope === ServerScope.local) return Persist.global(key, legacy)
    return withStorage({ key: ScopedKey.from(scope, key) }, GLOBAL_STORAGE)
  },
  workspace(dir: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(ServerScope.local, dir, `workspace:${key}`, legacy)
  },
  serverWorkspace(scope: ServerScopeValue, dir: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(scope, dir, `workspace:${key}`, legacy)
  },
  session(dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(ServerScope.local, dir, `session:${session}:${key}`, legacy)
  },
  serverSession(scope: ServerScopeValue, dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(scope, dir, `session:${session}:${key}`, legacy)
  },
  scoped(dir: string, session: string | undefined, key: string, legacy?: string[]): PersistTarget {
    if (session) return Persist.session(dir, session, key, legacy)
    return Persist.workspace(dir, key, legacy)
  },
  serverScoped(scope: ServerScopeValue, dir: string, session: string | undefined, key: string, legacy?: string[]) {
    if (session) return Persist.serverSession(scope, dir, session, key, legacy)
    return Persist.serverWorkspace(scope, dir, key, legacy)
  },
  prompt(target: PersistTarget): PersistTarget {
    return { ...target, draft: true }
  },
}

function resolveTarget(target: PersistTarget, platform?: Platform): PersistTarget {
  if (target.scope !== "window") return target
  if (platform?.platform === "desktop" && !platform.windowID) return withStorage(target, GLOBAL_STORAGE)
  const windowID = platform?.platform === "desktop" ? (platform.windowID ?? "browser") : "browser"
  return withStorage(target, windowStorage(windowID))
}

export function removePersisted(target: PersistTarget, platform?: Platform) {
  const config = target.scope === "window" ? resolveTarget(target, platform) : target

  if (config.draft && platform?.draftStore) {
    void platform.draftStore.removeItem(`${config.storage ?? "default"}:${config.key}`)
  }
  const isDesktop = platform?.platform === "desktop" && !!platform.storage

  if (isDesktop) {
    void platform.storage?.(config.storage)?.removeItem(config.key)
    for (const storage of config.legacyStorageNames ?? []) {
      void platform.storage?.(storage)?.removeItem(config.key)
    }
    return
  }

  if (!config.storage) {
    localStorageDirect().removeItem(config.key)
    return
  }

  localStorageWithPrefix(config.storage).removeItem(config.key)
  for (const storage of config.legacyStorageNames ?? []) {
    localStorageWithPrefix(storage).removeItem(config.key)
  }
}

export function persisted<T>(
  target: string | PersistTarget,
  store: [Store<T>, SetStoreFunction<T>],
  platformOverride?: Platform,
): PersistedWithReady<T> {
  const platform = platformOverride ?? usePlatform()
  const config = resolveTarget(typeof target === "string" ? { key: target } : target, platform)

  const defaults = snapshot(store[0])
  const legacy = config.legacy ?? []

  const isDesktop = platform.platform === "desktop" && !!platform.storage
  const draft = config.draft ? platform.draftStore : undefined

  const currentStorage = (() => {
    if (draft) {
      const prefix = `${config.storage ?? "default"}:`
      return {
        getItem: (key: string) => draft.getItem(prefix + key),
        setItem: (key: string, value: string) => draft.setItem(prefix + key, value),
        removeItem: (key: string) => draft.removeItem(prefix + key),
      } satisfies AsyncStorage
    }
    if (isDesktop) return platform.storage?.(config.storage)
    if (!config.storage) return localStorageDirect()
    return localStorageWithPrefix(config.storage)
  })()

  const legacyStorage = (() => {
    if (!isDesktop) return localStorageDirect()
    if (!config.storage) return platform.storage?.()
    return platform.storage?.(LEGACY_STORAGE)
  })()

  const legacyStorageNames = config.legacyStorageNames ?? []

  const storage = (() => {
    if (!isDesktop && !draft) {
      const current = currentStorage as SyncStorage
      const legacyStore = legacyStorage as SyncStorage
      const legacyStores = legacyStorageNames.map(localStorageWithPrefix)

      const api: SyncStorage = {
        getItem: (key) => {
          const value = readCurrent({ storage: current, key, defaults, migrate: config.migrate })
          if (value !== undefined) return value
          return migrateLegacy({
            current,
            legacyStore,
            stores: legacyStores,
            keys: legacy,
            key,
            defaults,
            migrate: config.migrate,
          })
        },
        setItem: (key, value) => {
          current.setItem(key, value)
        },
        removeItem: (key) => {
          current.removeItem(key)
        },
      }

      return api
    }

    const current = currentStorage as AsyncStorage
    const legacyStore = legacyStorage as AsyncStorage | undefined
    const oldCurrent = draft
      ? isDesktop
        ? platform.storage?.(config.storage)
        : config.storage
          ? localStorageWithPrefix(config.storage)
          : localStorageDirect()
      : undefined
    const legacyStores = [
      oldCurrent,
      ...legacyStorageNames.map((name) => (isDesktop ? platform.storage?.(name) : localStorageWithPrefix(name))),
    ]
      .filter((x) => !!x)
      .map(toAsyncStorage)
    let draftLatest: string | undefined

    const api: AsyncStorage = {
      getItem: async (key) => {
        const value = await readCurrentAsync({ storage: current, key, defaults, migrate: config.migrate })
        if (value !== undefined) return value
        const migrated = await migrateLegacyAsync({
          current,
          legacyStore,
          stores: legacyStores,
          keys: legacy,
          key,
          defaults,
          migrate: config.migrate,
        })
        if (draftLatest === undefined) {
          if (draft && migrated !== null) return (await current.getItem(key)) ?? migrated
          return migrated
        }
        await current.setItem(key, draftLatest)
        return draftLatest
      },
      setItem: async (key, value) => {
        if (draft) draftLatest = value
        await current.setItem(key, value)
      },
      removeItem: async (key) => {
        await current.removeItem(key)
      },
    }

    return api
  })()

  const [state, setState, init] = makePersisted(store, { name: config.key, storage })

  const isAsync = init instanceof Promise
  const [ready] = createResource(
    () => init,
    async (initValue) => {
      if (initValue instanceof Promise) await initValue
      return true
    },
    { initialValue: !isAsync },
  )

  return [
    state,
    setState,
    init,
    Object.assign(() => (ready.loading ? false : ready.latest === true), {
      promise: init instanceof Promise ? init : undefined,
    }),
  ]
}
