import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import {
  createServerProjects,
  migrateCanonicalLocalServerState,
  migrateServerState,
  nextServerAfterRemoval,
  resolveServerList,
  ServerConnection,
} from "./server"
import { ServerScope } from "@/utils/server-scope"

describe("resolveServerList", () => {
  test("ignores persisted and startup HTTP connections", () => {
    const native = {
      type: "rika",
      displayName: "Rika",
      http: { url: "http://127.0.0.1:4096" },
      rika: { url: "ws://127.0.0.1:4096/server", token: "token", identity: "desktop" },
    } as const

    const list = resolveServerList({
      stored: [
        { url: "https://server.example.test", username: "legacy", password: "secret" },
        native,
      ],
      props: [
        {
          type: "http",
          authToken: true,
          http: {
            url: "https://server.example.test",
            username: "legacy",
            password: "secret",
          },
        },
        native,
      ],
    })

    expect(list).toEqual([native])
  })

  test("preserves the native Rika descriptor from startup", () => {
    const startup = {
      type: "rika",
      http: { url: "http://127.0.0.1:4096" },
      rika: { url: "ws://127.0.0.1:4096/server", token: "fresh", identity: "desktop" },
    } as const
    const stored = {
      type: "rika",
      http: { url: "http://127.0.0.1:4096" },
      rika: { url: "ws://127.0.0.1:4096/server", token: "stale", identity: "desktop" },
    } as const

    expect(resolveServerList({ stored: [stored], props: [startup] })).toEqual([startup])
  })
})

test("migrates away legacy server records and scopes", () => {
  const native = {
    type: "rika",
    http: { url: "http://127.0.0.1:4096" },
    rika: { url: "ws://127.0.0.1:4096/server", token: "token", identity: "desktop" },
  } as const
  const result = migrateServerState({
    list: [
      { url: "https://legacy.example.test", username: "legacy", password: "secret" },
      { type: "ssh", host: "legacy", http: { url: "http://127.0.0.1:4097" } },
      native,
    ],
    projects: {
      "https://legacy.example.test": [{ worktree: "/legacy", expanded: true }],
      rika: [{ worktree: "/native", expanded: true }],
    },
    lastProject: { "https://legacy.example.test": "/legacy", rika: "/native" },
    recentlyClosed: { "https://legacy.example.test": ["/legacy"], rika: ["/native"] },
  }) as Record<string, unknown>

  expect(result.list).toEqual([native])
  expect(result.projects).toEqual({ rika: [{ worktree: "/native", expanded: true }] })
  expect(result.lastProject).toEqual({ rika: "/native" })
  expect(result.recentlyClosed).toEqual({ rika: ["/native"] })
})

test("treats the native Rika server as local", () => {
  expect(
    ServerConnection.local({
      type: "rika",
      http: { url: "http://127.0.0.1:4096" },
      rika: { url: "ws://127.0.0.1:4096/server", token: "token", identity: "desktop" },
    }),
  ).toBe(true)
  expect(ServerConnection.local({ type: "http", http: { url: "http://localhost:4096" } })).toBe(true)
  expect(ServerConnection.local({ type: "http", http: { url: "https://server.example.test" } })).toBe(false)
})

test("active server removal falls back across built-in and persisted servers", () => {
  const local = {
    type: "rika",
    http: { url: "http://127.0.0.1:4096" },
    rika: { url: "ws://127.0.0.1:4096/server", token: "token", identity: "desktop" },
  } as const
  const remote = { type: "http", http: { url: "https://server.example.test" } } as const

  expect(
    nextServerAfterRemoval(
      [local, remote],
      ServerConnection.Key.make("https://server.example.test"),
      ServerConnection.Key.make("rika"),
    ),
  ).toBe(ServerConnection.Key.make("rika"))
})

describe("createServerProjects", () => {
  test("keeps active and explicit server buckets in one reactive store", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const active = createServerProjects({ scope, store, setStore })
      const remote = createServerProjects({ scope: () => "https://debian.example" as ServerScope, store, setStore })

      remote.open("/repo")
      expect(remote.list()).toEqual([{ worktree: "/repo", expanded: true }])
      expect(active.list()).toEqual([])

      const adopted = createServerProjects({ scope: () => "https://debian.example" as ServerScope, store, setStore })
      expect(adopted.list()).toEqual([{ worktree: "/repo", expanded: true }])

      adopted.close("/repo")
      expect(remote.list()).toEqual([])
      dispose()
    })
  })

  test("tracks recently closed projects and drops them when reopened", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.open("/a")
      projects.open("/b")
      projects.close("/a")
      expect(projects.recentlyClosed()).toEqual(["/a"])

      projects.close("/b")
      expect(projects.recentlyClosed()).toEqual(["/b", "/a"])

      projects.open("/a")
      expect(projects.recentlyClosed()).toEqual(["/b"])
      expect(projects.list()).toEqual([{ worktree: "/a", expanded: true }])
      dispose()
    })
  })

  test("remove drops a project without recording it as recently closed", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.open("/repo/subdir")
      projects.remove("/repo/subdir")
      expect(projects.list()).toEqual([])
      expect(projects.recentlyClosed()).toEqual([])
      dispose()
    })
  })

  test("retains recently closed history beyond the visible display limit", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      // Closing 6 projects keeps all 6 in the store even though only 5 are displayed;
      // this prevents display-filtered entries from evicting still-visible ones.
      for (const dir of ["/1", "/2", "/3", "/4", "/5", "/6"]) {
        projects.open(dir)
        projects.close(dir)
      }
      expect(projects.recentlyClosed()).toEqual(["/6", "/5", "/4", "/3", "/2", "/1"])
      dispose()
    })
  })

  test("caps recently closed history at the store limit", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      for (let i = 1; i <= 20; i++) {
        projects.open(`/p${i}`)
        projects.close(`/p${i}`)
      }
      expect(projects.recentlyClosed()).toHaveLength(16)
      expect(projects.recentlyClosed()[0]).toBe("/p20")
      expect(projects.recentlyClosed().at(-1)).toBe("/p5")
      dispose()
    })
  })

  test("dedupes recently closed entries by normalized path", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.close("/repo")
      projects.close("/repo/")
      expect(projects.recentlyClosed()).toEqual(["/repo/"])
      dispose()
    })
  })
})

describe("migrateCanonicalLocalServerState", () => {
  test("moves the legacy sidecar bucket into local scope", () => {
    expect(
      migrateCanonicalLocalServerState({
        projects: { sidecar: [{ worktree: "/repo", expanded: true }] },
        lastProject: { sidecar: "/repo" },
      }),
    ).toEqual({
      projects: { local: [{ worktree: "/repo", expanded: true }] },
      lastProject: { local: "/repo" },
    })
  })
  test("moves an existing canonical web bucket into local scope", () => {
    expect(
      migrateCanonicalLocalServerState(
        {
          list: [],
          projects: { "https://opencode.example.com": [{ worktree: "/remote", expanded: true }] },
          lastProject: { "https://opencode.example.com": "/remote" },
        },
        ServerConnection.Key.make("https://opencode.example.com"),
      ),
    ).toEqual({
      list: [],
      projects: { local: [{ worktree: "/remote", expanded: true }] },
      lastProject: { local: "/remote" },
    })
  })

  test("preserves existing local state while merging a canonical web bucket", () => {
    expect(
      migrateCanonicalLocalServerState(
        {
          projects: {
            local: [{ worktree: "/local", expanded: false }],
            "https://opencode.example.com": [
              { worktree: "/local", expanded: true },
              { worktree: "/remote", expanded: true },
            ],
          },
          lastProject: { local: "/local", "https://opencode.example.com": "/remote" },
        },
        ServerConnection.Key.make("https://opencode.example.com"),
      ),
    ).toEqual({
      projects: {
        local: [
          { worktree: "/local", expanded: false },
          { worktree: "/remote", expanded: true },
        ],
      },
      lastProject: { local: "/local" },
    })
  })
})
