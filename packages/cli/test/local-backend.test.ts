import { describe, expect, test } from "bun:test"
import { SecretRedactor } from "@rika/core"
import { Ids, Remote } from "@rika/schema"
import { Effect, Layer } from "effect"
import { LocalBackend, Runtime } from "../src/index"

const workspaceRoot = "/workspace/rika-local-backend"
const dataDir = `${workspaceRoot}/.rika`
const defaultBackendId = LocalBackend.backendId({}, workspaceRoot)

describe("CLI local backend", () => {
  test("reuses a healthy connection record without spawning", async () => {
    const system = fakeSystem()
    const record: LocalBackend.BackendRecord = {
      url: "http://127.0.0.1:45555",
      token: "secret-token",
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      backend_id: defaultBackendId,
      pid: 123,
      started_at: 1,
    }
    system.files.set(LocalBackend.recordPath(dataDir), JSON.stringify(record))
    system.healthy.set(healthKey(record.url, record.token), health(record))

    const endpoint = await Effect.runPromise(
      LocalBackend.connectOrStart({ workspace_root: workspaceRoot, data_dir: dataDir, mode: "smart" }).pipe(
        Effect.provide(LocalBackend.layerFromInput({ env: {}, cwd: workspaceRoot, system })),
      ),
    )

    expect(endpoint).toEqual({
      kind: "local",
      url: record.url,
      token: record.token,
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      pid: 123,
    })
    expect(system.healthCalls).toEqual([{ url: record.url, token: record.token }])
    expect(system.spawns).toHaveLength(0)
  })

  test("does not reuse a healthy backend launched by a different frontend", async () => {
    const system = fakeSystem()
    const env = { RIKA_BACKEND_EXECUTABLE: "/workspace/rika-local-backend/bin/source-rika" }
    const record: LocalBackend.BackendRecord = {
      url: "http://127.0.0.1:65000",
      token: "installed-token",
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      backend_id: "installed-rika",
      pid: 321,
      started_at: 1,
    }
    system.files.set(LocalBackend.recordPath(dataDir), JSON.stringify(record))
    system.healthy.set(healthKey(record.url, record.token), health(record))

    const endpoint = await Effect.runPromise(
      LocalBackend.connectOrStart({ workspace_root: workspaceRoot, data_dir: dataDir, mode: "smart" }).pipe(
        Effect.provide(LocalBackend.layerFromInput({ env, cwd: workspaceRoot, system })),
      ),
    )

    expect(endpoint.url).not.toBe(record.url)
    expect(system.spawns).toHaveLength(1)
    expect(system.spawns[0]?.backend_id).toBe(LocalBackend.backendId(env, workspaceRoot))
  })

  test("adopts a healthy backend from a different frontend when explicitly enabled", async () => {
    const system = fakeSystem()
    const record: LocalBackend.BackendRecord = {
      url: "http://127.0.0.1:65001",
      token: "installed-token",
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      backend_id: "installed-rika",
      pid: 322,
      started_at: 1,
    }
    system.files.set(LocalBackend.recordPath(dataDir), JSON.stringify(record))
    system.healthy.set(healthKey(record.url, record.token), health(record))

    const endpoint = await Effect.runPromise(
      LocalBackend.connectOrStart({ workspace_root: workspaceRoot, data_dir: dataDir, mode: "smart" }).pipe(
        Effect.provide(LocalBackend.layerFromInput({ env: {}, cwd: workspaceRoot, system, adoptHealthyRecord: true })),
      ),
    )

    expect(endpoint).toEqual({
      kind: "local",
      url: record.url,
      token: record.token,
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      pid: 322,
    })
    expect(system.spawns).toHaveLength(0)
  })

  test("starts one backend for concurrent callers and hides tokens from redaction", async () => {
    const system = fakeSystem()
    const layer = LocalBackend.layerFromInput({ env: { RIKA_BACKEND_PORT: "45678" }, cwd: workspaceRoot, system })
    const run = () =>
      Effect.runPromise(
        LocalBackend.connectOrStart({ workspace_root: workspaceRoot, data_dir: dataDir, mode: "smart" }).pipe(
          Effect.provide(layer),
        ),
      )

    const [first, second, third] = await Promise.all([run(), run(), run()])

    expect(first).toEqual(second)
    expect(second).toEqual(third)
    expect(system.spawns).toHaveLength(1)
    expect(first.url).toBe("http://127.0.0.1:45678")
    expect(LocalBackend.redactEndpoint(first)).not.toHaveProperty("token")
  })

  test("registers generated backend tokens with the secret redactor", async () => {
    const system = fakeSystem()
    const layer = Layer.mergeAll(
      SecretRedactor.layer,
      LocalBackend.layerFromInput({ env: { RIKA_BACKEND_PORT: "45681" }, cwd: workspaceRoot, system }),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* LocalBackend.connectOrStart({
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
        })
        const redacted = yield* SecretRedactor.redact(`token ${endpoint.token}`)
        return { endpoint, redacted }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.endpoint.token).toBe("generated-token-1")
    expect(result.redacted).toBe("token [REDACTED:RIKA_BACKEND_TOKEN]")
  })

  test("replaces stale records and reports backend status", async () => {
    const system = fakeSystem()
    const stale: LocalBackend.BackendRecord = {
      url: "http://127.0.0.1:45001",
      token: "dead-token",
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      backend_id: defaultBackendId,
      pid: 111,
      started_at: 1,
    }
    system.files.set(LocalBackend.recordPath(dataDir), JSON.stringify(stale))
    const layer = LocalBackend.layerFromInput({ env: { RIKA_BACKEND_PORT: "45679" }, cwd: workspaceRoot, system })

    const before = await Effect.runPromise(
      LocalBackend.status({ workspace_root: workspaceRoot, data_dir: dataDir }).pipe(Effect.provide(layer)),
    )
    const endpoint = await Effect.runPromise(
      LocalBackend.connectOrStart({ workspace_root: workspaceRoot, data_dir: dataDir, mode: "deep3" }).pipe(
        Effect.provide(layer),
      ),
    )
    const after = await Effect.runPromise(
      LocalBackend.status({ workspace_root: workspaceRoot, data_dir: dataDir }).pipe(Effect.provide(layer)),
    )

    expect(before).toMatchObject({ status: "stale", endpoint: stale.url, pid: 111 })
    expect(endpoint.kind).toBe("local")
    if (endpoint.kind !== "local") throw new Error("expected local endpoint")
    expect(endpoint.url).toBe("http://127.0.0.1:45679")
    expect(after).toMatchObject({ status: "healthy", endpoint: endpoint.url, pid: endpoint.pid })
  })

  test("reconnecting client replaces a backend that dies after startup", async () => {
    const system = fakeSystem()
    const stale: LocalBackend.BackendRecord = {
      url: "http://127.0.0.1:45002",
      token: "dead-token",
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      backend_id: defaultBackendId,
      pid: 222,
      started_at: 1,
    }
    const thread = Ids.ThreadId.make("thread_reconnecting_client")
    const summary: Remote.ThreadSummary = {
      thread_id: thread,
      workspace_id: Ids.WorkspaceId.make(workspaceRoot),
      diff: { additions: 0, modifications: 0, deletions: 0 },
      archived: false,
      visibility: "private",
      created_at: 1,
      updated_at: 2,
    }
    const urls: Array<string> = []
    system.files.set(LocalBackend.recordPath(dataDir), JSON.stringify(stale))
    system.healthy.set(healthKey(stale.url, stale.token), health(stale))
    const layer = LocalBackend.layerFromInput({ env: { RIKA_BACKEND_PORT: "45680" }, cwd: workspaceRoot, system })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const backend = yield* LocalBackend.Service
        const client = Runtime.reconnectingClient({
          resolveEndpoint: () =>
            backend.connectOrStart({
              workspace_root: workspaceRoot,
              data_dir: dataDir,
              mode: "smart",
            }),
          fetch: async (input) => {
            const url = input instanceof Request ? input.url : String(input)
            urls.push(url)
            if (url.startsWith(stale.url)) {
              system.healthy.delete(healthKey(stale.url, stale.token))
              throw new Error("Unable to connect. Is the computer able to access the url?")
            }
            return new Response(JSON.stringify([summary]), { status: 200 })
          },
        })
        return yield* client.listThreads({ workspace_id: Ids.WorkspaceId.make(workspaceRoot) })
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toEqual([summary])
    expect(system.spawns).toHaveLength(1)
    expect(urls).toHaveLength(2)
    expect(urls[0]).toStartWith(stale.url)
    expect(urls[1]).toStartWith("http://127.0.0.1:45680")
  })
})

interface FakeSystem extends LocalBackend.System {
  readonly files: Map<string, string>
  readonly healthy: Map<string, Remote.BackendHealth>
  readonly healthCalls: Array<{ readonly url: string; readonly token: string }>
  readonly spawns: Array<LocalBackend.SpawnInput>
}

const fakeSystem = (): FakeSystem => {
  const files = new Map<string, string>()
  const locks = new Set<string>()
  const healthy = new Map<string, Remote.BackendHealth>()
  const healthCalls: Array<{ readonly url: string; readonly token: string }> = []
  const spawns: Array<LocalBackend.SpawnInput> = []
  return {
    files,
    healthy,
    healthCalls,
    spawns,
    readText: (path) =>
      Effect.suspend(() => {
        const value = files.get(path)
        if (value === undefined)
          return Effect.fail(new LocalBackend.BackendError({ message: `Missing ${path}`, operation: "readText" }))
        return Effect.succeed(value)
      }),
    writePrivateText: (path, text) => Effect.sync(() => void files.set(path, text)),
    remove: (path) =>
      Effect.sync(() => {
        files.delete(path)
        locks.delete(path)
      }),
    makeDir: () => Effect.void,
    tryAcquireLock: (path) =>
      Effect.sync(() => {
        if (locks.has(path)) return false
        locks.add(path)
        return true
      }),
    releaseLock: (path) => Effect.sync(() => void locks.delete(path)),
    lockAgeMillis: (path) => Effect.sync(() => (locks.has(path) ? 0 : undefined)),
    randomToken: Effect.sync(() => `generated-token-${spawns.length + 1}`),
    spawnServer: (input) =>
      Effect.sync(() => {
        spawns.push(input)
        const spawned = { ...input, url: `http://${input.host}:${input.port}`, pid: 9000 + spawns.length }
        healthy.set(healthKey(spawned.url, input.token), health(spawned))
        return { pid: spawned.pid }
      }),
    health: (url, token) =>
      Effect.suspend(() => {
        healthCalls.push({ url, token })
        const value = healthy.get(healthKey(url, token))
        if (value === undefined)
          return Effect.fail(new LocalBackend.BackendError({ message: "unhealthy", operation: "health" }))
        return Effect.succeed(value)
      }),
    sleep: () => Effect.promise(() => Bun.sleep(0)),
  }
}

const healthKey = (url: string, token: string) => `${url}\n${token}`

const health = (input: {
  readonly url: string
  readonly workspace_root: string
  readonly data_dir: string
  readonly backend_id: string
  readonly pid: number
}): Remote.BackendHealth => ({
  status: "healthy",
  url: input.url,
  workspace_root: input.workspace_root,
  data_dir: input.data_dir,
  backend_id: input.backend_id,
  pid: input.pid,
  version: "0.0.0",
})
