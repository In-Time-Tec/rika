import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, IdGenerator, Time } from "@rika/core"
import { OrbActivity, OrbManager } from "@rika/orb"
import { Database, Migration, OrbStore } from "@rika/persistence"
import { Common, Event, Ids } from "@rika/schema"
import { Effect, Layer } from "effect"
import { BackendEndpoint, LocalBackend, Runtime } from "../src/index"

const workspaceRoot = "/workspace/rika-backend-endpoint"
const dataDir = `${workspaceRoot}/.rika`
const threadId = Ids.ThreadId.make("thread_backend_endpoint")
const projectId = Ids.ProjectId.make("project_backend_endpoint")
const now = Common.TimestampMillis.make(2_020_000_000_000)

describe("CLI backend endpoint resolver", () => {
  test("prefers a running orb endpoint over the local backend", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth()
    const endpoint = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createRunningOrb()
        return yield* BackendEndpoint.resolveEndpoint({
          thread_id: threadId,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {},
        })
      }).pipe(Effect.provide(makeLayer(local.service, health.service))),
    )

    expect(endpoint).toMatchObject({
      kind: "orb",
      url: "https://orb-endpoint.rika.test",
      token: "orb-token",
    })
    expect(endpoint).not.toHaveProperty("pid")
    expect(local.connects).toBe(0)
    expect(health.calls).toEqual([{ url: "https://orb-endpoint.rika.test", token: "orb-token" }])
  })

  test("resumes a paused orb and resolves the refreshed endpoint instead of falling back", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth()
    const resumer = fakeOrbResumer({
      endpoint_url: "https://fresh-orb-endpoint.rika.test/",
      token: "fresh-orb-token",
    })
    const endpoint = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const paused = yield* createPausedOrb()
        const resolved = yield* BackendEndpoint.resolveEndpoint({
          thread_id: threadId,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {
            RIKA_BACKEND_URL: "https://env.rika.test",
            RIKA_BACKEND_TOKEN: "env-token",
          },
        })
        return { paused, resolved }
      }).pipe(Effect.provide(makeLayer(local.service, health.service, resumer.layer))),
    )

    expect(endpoint.resolved).toMatchObject({
      kind: "orb",
      url: "https://fresh-orb-endpoint.rika.test",
      token: "fresh-orb-token",
      orb_id: endpoint.paused.orb_id,
      thread_id: threadId,
    })
    expect(resumer.calls).toEqual([endpoint.paused.orb_id])
    expect(local.connects).toBe(0)
    expect(health.calls).toEqual([{ url: "https://fresh-orb-endpoint.rika.test/", token: "fresh-orb-token" }])
  })

  test("does not fall back when paused orb resume fails", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth()
    const resumer = failingOrbResumer()
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createPausedOrb()
        return yield* BackendEndpoint.resolveEndpoint({
          thread_id: threadId,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {
            RIKA_BACKEND_URL: "https://env.rika.test",
            RIKA_BACKEND_TOKEN: "env-token",
          },
        }).pipe(Effect.flip)
      }).pipe(Effect.provide(makeLayer(local.service, health.service, resumer.layer))),
    )

    expect(error).toBeInstanceOf(OrbManager.OrbProvisionError)
    expect(error.message).toContain("resume failed")
    expect(resumer.calls).toEqual([Ids.OrbId.make("orb_1")])
    expect(local.connects).toBe(0)
    expect(health.calls).toEqual([])
  })

  test("errors for a running orb with missing endpoint credentials", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth()
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createRunningOrbWithoutEndpoint()
        return yield* BackendEndpoint.resolveEndpoint({
          thread_id: threadId,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {
            RIKA_BACKEND_URL: "https://env.rika.test",
            RIKA_BACKEND_TOKEN: "env-token",
          },
        }).pipe(Effect.flip)
      }).pipe(Effect.provide(makeLayer(local.service, health.service))),
    )

    expect(error).toBeInstanceOf(BackendEndpoint.BackendEndpointError)
    expect(error.message).toContain("has no endpoint")
    expect(local.connects).toBe(0)
    expect(health.calls).toEqual([])
  })

  test("does not fall back when orb health validation fails", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth({ fail: true })
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createRunningOrb()
        return yield* BackendEndpoint.resolveEndpoint({
          thread_id: threadId,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {
            RIKA_BACKEND_URL: "https://env.rika.test",
            RIKA_BACKEND_TOKEN: "env-token",
          },
        }).pipe(Effect.flip)
      }).pipe(Effect.provide(makeLayer(local.service, health.service))),
    )

    expect(error).toBeInstanceOf(BackendEndpoint.BackendEndpointError)
    expect(local.connects).toBe(0)
    expect(health.calls).toEqual([{ url: "https://orb-endpoint.rika.test", token: "orb-token" }])
  })

  test("uses env endpoint before local backend when no orb is registered", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth()
    const endpoint = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* BackendEndpoint.resolveEndpoint({
          thread_id: threadId,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {
            RIKA_BACKEND_URL: "https://env.rika.test/",
            RIKA_BACKEND_TOKEN: "env-token",
          },
        })
      }).pipe(Effect.provide(makeLayer(local.service, health.service))),
    )

    expect(endpoint).toEqual({
      kind: "env",
      url: "https://env.rika.test",
      token: "env-token",
    })
    expect(local.connects).toBe(0)
    expect(health.calls).toEqual([{ url: "https://env.rika.test", token: "env-token" }])
  })

  test("falls back to the local backend when no orb or env endpoint exists", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth()
    const endpoint = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* BackendEndpoint.resolveEndpoint({
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {},
        })
      }).pipe(Effect.provide(makeLayer(local.service, health.service))),
    )

    expect(endpoint).toMatchObject({
      kind: "local",
      url: "http://127.0.0.1:45555",
      token: "local-token",
      pid: 123,
    })
    expect(local.connects).toBe(1)
    expect(health.calls).toEqual([])
  })

  test("uses workspace settings mode when starting the local backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-backend-settings-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(join(workspace, ".rika", "settings.json"), JSON.stringify({ "mode.default": "deep3" }))
    const local = fakeLocalBackend()
    const health = fakeHealth()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          return yield* BackendEndpoint.resolveEndpoint({
            workspace_root: workspace,
            env: { HOME: home },
          })
        }).pipe(Effect.provide(makeLayer(local.service, health.service))),
      )

      expect(local.starts).toEqual([
        {
          workspace_root: workspace,
          data_dir: `${home}/.rika`,
          mode: "deep3",
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reconnecting client resolves endpoints by request thread id", async () => {
    const urls: Array<string> = []
    const resolved: Array<Ids.ThreadId | undefined> = []
    const touched: Array<Ids.OrbId> = []
    const client = Runtime.reconnectingClient({
      resolveEndpoint: (input) =>
        Effect.sync(() => {
          resolved.push(input.thread_id)
          if (input.thread_id === threadId) {
            return {
              kind: "orb" as const,
              url: "https://orb-endpoint.rika.test",
              token: "orb-token",
              orb_id: Ids.OrbId.make("orb_backend_endpoint"),
              thread_id: threadId,
            }
          }
          return {
            kind: "local" as const,
            url: "http://127.0.0.1:45555",
            token: "local-token",
            workspace_root: workspaceRoot,
            data_dir: dataDir,
            pid: 123,
          }
        }),
      touchOrb: (orbId) =>
        Effect.sync(() => {
          touched.push(orbId)
        }),
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        urls.push(url)
        if (url.startsWith("https://orb-endpoint.rika.test")) {
          return new Response(
            JSON.stringify({
              summary: threadSummary(threadId),
              events: [],
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify([threadSummary(Ids.ThreadId.make("thread_local_backend_endpoint"))]), {
          status: 200,
        })
      },
    })

    const listed = await Effect.runPromise(client.listThreads())
    const opened = await Effect.runPromise(client.openThread(threadId))

    expect(listed.map((summary) => summary.thread_id)).toEqual([Ids.ThreadId.make("thread_local_backend_endpoint")])
    expect(opened.summary.thread_id).toBe(threadId)
    expect(urls[0]).toStartWith("http://127.0.0.1:45555")
    expect(urls[1]).toStartWith("https://orb-endpoint.rika.test")
    expect(resolved).toEqual([undefined, threadId])
    expect(touched).toEqual([Ids.OrbId.make("orb_backend_endpoint")])
  })

  test("reconnecting client forwards default user identity for manual compaction", async () => {
    const userId = Ids.UserId.make("user_backend_endpoint")
    const event: Event.ContextCompacted = {
      id: Ids.EventId.make("event_backend_endpoint_compacted"),
      thread_id: threadId,
      sequence: 2,
      version: 1,
      created_at: now,
      type: "context.compacted",
      data: {
        summary: "Goal\n- compact through reconnecting client",
        tail_start_sequence: 1,
        trigger: "manual",
        tokens_before: 100,
        model: "gpt-5.5",
      },
    }
    const urls: Array<string> = []
    const client = Runtime.reconnectingClient({
      resolveEndpoint: () =>
        Effect.succeed({
          kind: "local" as const,
          url: "http://127.0.0.1:45555",
          token: "local-token",
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          pid: 123,
        }),
      user_id: userId,
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        urls.push(url)
        return new Response(JSON.stringify(event), { status: 200 })
      },
    })

    const compacted = await Effect.runPromise(client.compactThread(threadId))

    expect(compacted).toEqual(event)
    expect(urls).toEqual([
      "http://127.0.0.1:45555/v1/threads/thread_backend_endpoint/compact?user_id=user_backend_endpoint",
    ])
  })

  test("reconnecting client refreshes stale cached orb endpoints when touch reports a pause", async () => {
    const urls: Array<string> = []
    const resolved: Array<Ids.ThreadId | undefined> = []
    let running = true
    let resolveCount = 0
    const client = Runtime.reconnectingClient({
      resolveEndpoint: (input) =>
        Effect.sync(() => {
          resolved.push(input.thread_id)
          resolveCount += 1
          const endpoint =
            resolveCount === 1 ? "https://orb-endpoint.rika.test" : "https://resumed-orb-endpoint.rika.test"
          if (resolveCount > 1) running = true
          return {
            kind: "orb" as const,
            url: endpoint,
            token: "orb-token",
            orb_id: Ids.OrbId.make("orb_backend_endpoint"),
            thread_id: threadId,
          }
        }),
      touchOrb: (orbId) =>
        running
          ? Effect.void
          : Effect.fail(
              new OrbActivity.OrbActivityError({
                message: `Orb ${orbId} is paused`,
                operation: "touch",
                orb_id: orbId,
              }),
            ),
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        urls.push(url)
        return new Response(
          JSON.stringify({
            summary: threadSummary(threadId),
            events: [],
          }),
          { status: 200 },
        )
      },
    })

    await Effect.runPromise(client.openThread(threadId))
    running = false
    const second = await Effect.runPromise(client.openThread(threadId))
    const resolvedAfterSecond = Array.from(resolved)
    const urlsAfterSecond = Array.from(urls)
    const third = await Effect.runPromise(client.openThread(threadId))

    expect(second.summary.thread_id).toBe(threadId)
    expect(third.summary.thread_id).toBe(threadId)
    expect(resolvedAfterSecond).toEqual([threadId, threadId])
    expect(urlsAfterSecond.map((url) => new URL(url).origin)).toEqual([
      "https://orb-endpoint.rika.test",
      "https://resumed-orb-endpoint.rika.test",
    ])
    expect(resolved).toEqual([threadId, threadId])
    expect(urls.map((url) => new URL(url).origin)).toEqual([
      "https://orb-endpoint.rika.test",
      "https://resumed-orb-endpoint.rika.test",
      "https://resumed-orb-endpoint.rika.test",
    ])
  })
})

const createRunningOrb = () =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({ thread_id: threadId, project_id: projectId })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_backend_endpoint")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://orb-endpoint.rika.test",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
  })

const createPausedOrb = () =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({ thread_id: threadId, project_id: projectId })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_backend_endpoint")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://orb-endpoint.rika.test",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
    return yield* OrbStore.setStatus(created.orb_id, "paused")
  })

const createRunningOrbWithoutEndpoint = () =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({ thread_id: threadId, project_id: projectId })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_backend_endpoint")
    yield* OrbStore.setStatus(created.orb_id, "running")
  })

const makeLayer = (
  localBackend: LocalBackend.Interface,
  health: BackendEndpoint.HealthInterface,
  resumerLayer: Layer.Layer<BackendEndpoint.OrbResumer, never, OrbStore.Service> = fakeOrbResumer().layer,
) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: dataDir,
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
    OrbStore.layer.pipe(
      Layer.provideMerge(databaseLayer),
      Layer.provideMerge(Time.fixedLayer(now)),
      Layer.provideMerge(IdGenerator.sequenceLayer(1)),
    ),
  )
  return Layer.mergeAll(
    storageLayer,
    resumerLayer.pipe(Layer.provideMerge(storageLayer)),
    Layer.succeed(LocalBackend.Service, localBackend),
    Layer.succeed(BackendEndpoint.Health, BackendEndpoint.Health.of(health)),
  )
}

const fakeOrbResumer = (
  endpoint: { readonly endpoint_url: string; readonly token: string } = {
    endpoint_url: "https://resumed-orb-endpoint.rika.test",
    token: "resumed-orb-token",
  },
) => {
  const calls: Array<Ids.OrbId> = []
  const layer = Layer.effect(
    BackendEndpoint.OrbResumer,
    Effect.map(OrbStore.Service, (orbs) =>
      BackendEndpoint.OrbResumer.of({
        resume: (orbId) =>
          Effect.gen(function* () {
            calls.push(orbId)
            yield* backendEndpointStoreStep("resume_endpoint", orbId, orbs.setEndpoint(orbId, endpoint))
            return yield* backendEndpointStoreStep("resume", orbId, orbs.setStatus(orbId, "running"))
          }),
      }),
    ),
  )
  return { calls, layer }
}

const backendEndpointStoreStep = <A>(
  step: string,
  orbId: Ids.OrbId,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, OrbManager.OrbProvisionError> =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new OrbManager.OrbProvisionError({
          message: error instanceof Error ? error.message : String(error),
          step,
          orb_id: orbId,
        }),
    ),
  )

const failingOrbResumer = () => {
  const calls: Array<Ids.OrbId> = []
  const layer = Layer.succeed(
    BackendEndpoint.OrbResumer,
    BackendEndpoint.OrbResumer.of({
      resume: (orbId) =>
        Effect.sync(() => {
          calls.push(orbId)
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new OrbManager.OrbProvisionError({
                message: "resume failed",
                step: "resume",
                orb_id: orbId,
              }),
            ),
          ),
        ),
    }),
  )
  return { calls, layer }
}

const fakeLocalBackend = () => {
  const state = {
    connects: 0,
    starts: [] as Array<{ readonly workspace_root: string; readonly data_dir: string; readonly mode: Config.Mode }>,
    service: LocalBackend.Service.of({
      connectOrStart: (input) =>
        Effect.sync(() => {
          state.connects += 1
          state.starts.push(input)
          return {
            kind: "local" as const,
            url: "http://127.0.0.1:45555",
            token: "local-token",
            workspace_root: input.workspace_root,
            data_dir: input.data_dir,
            pid: 123,
          }
        }),
      status: () =>
        Effect.succeed({
          status: "healthy" as const,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          endpoint: "http://127.0.0.1:45555",
          pid: 123,
        }),
    }),
  }
  return state
}

const fakeHealth = (input: { readonly fail?: boolean } = {}) => {
  const state = {
    calls: [] as Array<{ readonly url: string; readonly token: string }>,
    service: {
      health: (url: string, token: string) =>
        Effect.suspend(() => {
          state.calls.push({ url, token })
          if (input.fail === true) {
            return Effect.fail(
              new BackendEndpoint.BackendEndpointError({
                message: "health failed",
                operation: "health",
              }),
            )
          }
          return Effect.succeed({
            status: "healthy" as const,
            url,
            workspace_root: "/home/user/repo",
            data_dir: "/home/user/repo/.rika",
            backend_id: "orb-backend",
            version: "0.0.0",
          })
        }),
    },
  }
  return state
}

const threadSummary = (summaryThreadId: Ids.ThreadId) => ({
  thread_id: summaryThreadId,
  workspace_id: Ids.WorkspaceId.make(workspaceRoot),
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  visibility: "private",
  created_at: now,
  updated_at: now,
})
