import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentLoop, ContextResolver, SkillRegistry, ThreadService, ToolExecutor, WorkspaceAccess } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { Provider, Router } from "@rika/llm"
import { OrbManager, SandboxClientFake } from "@rika/orb"
import {
  ArtifactStore,
  Database,
  Migration,
  OrbStore,
  ProjectStore,
  ThreadEventLog,
  ThreadProjection,
  WorkspaceStore,
} from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Codec, Common, Event, Ids } from "@rika/schema"
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { HttpServer, RemoteControl } from "@rika/server"
import { Args, OrbExecute, Output } from "../src/index"

const now = Common.TimestampMillis.make(1_990_000_000_000)
const workspaceRoot = "/workspace/rika-orb-execute-test"
const dataRoot = "/workspace/rika-orb-execute-test/.rika"
const projectId = Ids.ProjectId.make("project_1")

describe("CLI orb execute", () => {
  test("provisions an orb and streams the remote turn as Event NDJSON", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-execute-workspace-"))
    const dataDir = join(workspace, ".rika")
    const repoOrigin = "https://github.com/example/rika.git"
    const threadId = Ids.ThreadId.make("thread_2")
    await configureGitOrigin(workspace, repoOrigin)
    const remoteRuntime = ManagedRuntime.make(makeRemoteLayer())
    const handle = await remoteRuntime.runPromise(
      HttpServer.serve({ host: "127.0.0.1", port: 0, token: "server-token" }),
    )
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const sandbox = SandboxClientFake.makeState({
      execResults: [
        [{ type: "exit", exitCode: 0 }],
        [
          { type: "stdout", data: "abc123\n" },
          { type: "exit", exitCode: 0 },
        ],
        [{ type: "exit", exitCode: 0 }],
        [{ type: "started", pid: 4587 }],
      ],
    })

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* ProjectStore.create({
            name: "demo",
            repo_origin: repoOrigin,
            template_id: "project-template",
          })
          const command = yield* Args.parse(["-ox", "--workspace", workspace, "hello"])
          if (command.type !== "execute") throw new Error("expected execute command")
          const exitCode = yield* OrbExecute.executeCommand(command)
          const stored = yield* OrbStore.getByThread(threadId)
          return { exitCode, stored }
        }).pipe(
          Effect.provide(
            makeOrbLayer({
              output,
              dataDir,
              workspaceRoot: workspace,
              sandbox,
              fetch: rewriteFetch("https://sandbox_1-4587.fake.rika.local", handle.url),
            }),
          ),
        ),
      )

      const events = output.stdout.map((line) => Schema.decodeUnknownSync(Event.Event)(JSON.parse(line)))

      expect(result.exitCode).toBe(0)
      expect(output.stderr).toEqual([
        "provisioning orb...",
        "running .agents/setup...",
        "orb ready: https://sandbox_1-4587.fake.rika.local",
      ])
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "turn.started",
        "message.added",
        "context.resolved",
        "model.stream.chunk",
        "message.added",
        "turn.completed",
      ])
      expect(events.at(-1)).toMatchObject({ type: "turn.completed" })
      expect(events.every((event) => event.thread_id === threadId)).toBe(true)
      expect(result.stored).toMatchObject({
        thread_id: threadId,
        project_id: projectId,
        endpoint_url: "https://sandbox_1-4587.fake.rika.local",
        status: "running",
      })
      expect(sandbox.calls.create[0]).toMatchObject({
        templateId: "project-template",
        metadata: { thread_id: threadId, project_id: projectId },
      })
      expect(sandbox.calls.exec).toHaveLength(4)
    } finally {
      await Effect.runPromise(handle.close())
      await remoteRuntime.dispose()
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("returns non-zero when the remote turn fails", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const terminal: Event.TurnFailed = {
      id: Ids.EventId.make("event_failed"),
      thread_id: Ids.ThreadId.make("thread_orb_failed"),
      turn_id: Ids.TurnId.make("turn_orb_failed"),
      sequence: 1,
      version: 1,
      created_at: now,
      type: "turn.failed",
      data: { error: { kind: "unknown", message: "remote failed", code: "remote_failed" } },
    }
    const command = await Effect.runPromise(
      Args.parse(["-ox", "--project", "demo", "--thread", terminal.thread_id, "fail"]),
    )
    if (command.type !== "execute") throw new Error("expected execute command")

    const exitCode = await Effect.runPromise(
      OrbExecute.executeCommand(command).pipe(
        Effect.provide(
          OrbExecute.layerWithClientFactory((threadId) =>
            Client.make({
              requestJson: (input) =>
                input.path === "/v1/turns"
                  ? Effect.succeed({ thread_id: threadId, accepted: true })
                  : Effect.succeed({
                      thread_id: threadId,
                      workspace_id: Ids.WorkspaceId.make("project:project_1"),
                      diff: { additions: 0, modifications: 0, deletions: 0 },
                      archived: false,
                      created_at: now,
                      updated_at: now,
                    }),
              streamJson: () => Stream.make(Codec.encode(Event.Event)(terminal)),
            }),
          ).pipe(
            Layer.provideMerge(Output.memoryLayer(output)),
            Layer.provideMerge(
              Config.layerFromValues({ workspace_root: workspaceRoot, data_dir: dataRoot, default_mode: "smart" }),
            ),
            Layer.provideMerge(IdGenerator.sequenceLayer(1)),
            Layer.provideMerge(projectStoreFakeLayer()),
            Layer.provideMerge(orbStoreFakeLayer()),
            Layer.provideMerge(
              Layer.succeed(
                OrbManager.Service,
                OrbManager.Service.of({
                  provisionForThread: (input) =>
                    Effect.succeed({
                      orb_id: Ids.OrbId.make("orb_failed"),
                      thread_id: input.thread_id,
                      project_id: input.project_id,
                      sandbox_id: "sandbox_failed",
                      status: "running",
                      base_commit: "abc123",
                      endpoint_url: "https://sandbox_failed-4587.fake.rika.local",
                      created_at: now,
                      last_active_at: now,
                    }),
                  pause: () => Effect.never,
                  resume: () => Effect.never,
                  kill: () => Effect.never,
                }),
              ),
            ),
          ),
        ),
      ),
    )

    expect(exitCode).toBe(1)
    expect(output.stdout.map((line) => Schema.decodeUnknownSync(Event.Event)(JSON.parse(line)))).toEqual([terminal])
  })

  test("fails when the remote event stream ends before a terminal turn event", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const exitCode = await Effect.runPromise(
      OrbExecute.execute(["-ox", "--project", "demo", "--thread", "thread_orb_empty", "hello"]).pipe(
        Effect.provide(
          OrbExecute.layerWithClientFactory((threadId) =>
            Client.make({
              requestJson: (input) =>
                input.path === "/v1/turns"
                  ? Effect.succeed({ thread_id: threadId, accepted: true })
                  : Effect.succeed({
                      thread_id: threadId,
                      workspace_id: Ids.WorkspaceId.make("project:project_1"),
                      diff: { additions: 0, modifications: 0, deletions: 0 },
                      archived: false,
                      created_at: now,
                      updated_at: now,
                    }),
              streamJson: () => Stream.empty,
            }),
          ).pipe(
            Layer.provideMerge(Output.memoryLayer(output)),
            Layer.provideMerge(
              Config.layerFromValues({ workspace_root: workspaceRoot, data_dir: dataRoot, default_mode: "smart" }),
            ),
            Layer.provideMerge(IdGenerator.sequenceLayer(1)),
            Layer.provideMerge(projectStoreFakeLayer()),
            Layer.provideMerge(orbStoreFakeLayer()),
            Layer.provideMerge(
              Layer.succeed(
                OrbManager.Service,
                OrbManager.Service.of({
                  provisionForThread: (input) =>
                    Effect.succeed({
                      orb_id: Ids.OrbId.make("orb_empty"),
                      thread_id: input.thread_id,
                      project_id: input.project_id,
                      sandbox_id: "sandbox_empty",
                      status: "running",
                      base_commit: "abc123",
                      endpoint_url: "https://sandbox_empty-4587.fake.rika.local",
                      created_at: now,
                      last_active_at: now,
                    }),
                  pause: () => Effect.never,
                  resume: () => Effect.never,
                  kill: () => Effect.never,
                }),
              ),
            ),
          ),
        ),
      ),
    )

    expect(exitCode).toBe(1)
    expect(output.stdout).toEqual([])
    expect(output.stderr.at(-1)).toBe("Orb event stream ended before turn completed")
  })
})

const makeOrbLayer = (input: {
  readonly output: Output.MemoryOutput
  readonly dataDir: string
  readonly workspaceRoot?: string
  readonly sandbox: SandboxClientFake.State
  readonly fetch: Client.FetchTransportInput["fetch"]
}) => {
  const configLayer = Config.layerFromValues({
    workspace_root: input.workspaceRoot ?? workspaceRoot,
    data_dir: input.dataDir,
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const timeLayer = Time.fixedLayer(now)
  const idLayer = IdGenerator.sequenceLayer(1)
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const orbStoreLayer = OrbStore.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const managerLayer = OrbManager.layerWithSystem(makeSystem()).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(projectStoreLayer),
    Layer.provideMerge(orbStoreLayer),
    Layer.provideMerge(SandboxClientFake.layer(input.sandbox)),
    Layer.provideMerge(Diagnostics.memoryLayer([])),
  )
  return OrbExecute.layerWithFetch(input.fetch).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(Output.memoryLayer(input.output)),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(Migration.layer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
    Layer.provideMerge(projectStoreLayer),
    Layer.provideMerge(orbStoreLayer),
    Layer.provideMerge(managerLayer),
  )
}

const projectStoreFakeLayer = () =>
  Layer.succeed(
    ProjectStore.Service,
    ProjectStore.Service.of({
      create: () => Effect.never,
      get: () => Effect.never,
      getByName: (name) =>
        name === "demo"
          ? Effect.succeed({
              project_id: projectId,
              name: "demo",
              repo_origin: "https://github.com/example/rika.git",
              default_branch: "main",
              template_id: "project-template",
              env: {},
              secret_names: [],
              created_at: now,
              updated_at: now,
            })
          : Effect.succeed(undefined),
      getByRepoOrigin: () => Effect.never,
      list: () => Effect.never,
      setEnv: () => Effect.never,
      unsetEnv: () => Effect.never,
      setSecret: () => Effect.never,
      unsetSecret: () => Effect.never,
      secretsForProvision: () => Effect.never,
    }),
  )

const orbStoreFakeLayer = () =>
  Layer.succeed(
    OrbStore.Service,
    OrbStore.Service.of({
      create: () => Effect.never,
      get: () => Effect.never,
      getByThread: () => Effect.never,
      list: () => Effect.never,
      setStatus: () => Effect.never,
      setSandbox: () => Effect.never,
      setBaseCommit: () => Effect.never,
      setEndpoint: () => Effect.never,
      endpointCredentials: () =>
        Effect.succeed({
          endpoint_url: "https://sandbox_failed-4587.fake.rika.local",
          token: "server-token",
        }),
      touch: () => Effect.never,
    }),
  )

const makeRemoteLayer = () => {
  const configLayer = Config.layerFromValues({
    workspace_root: "/workspace/rika-orb-remote",
    data_dir: "/workspace/rika-orb-remote/.rika",
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    workspaceStoreLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const threadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(
      Provider.fakeRegistryLayer([
        { name: "anthropic", responses: ["remote hello"] },
        { name: "openai", responses: ["remote hello"] },
      ]),
    ),
  )
  const agentBase = Layer.mergeAll(
    migratedStorageLayer,
    threadLayer,
    workspaceAccessLayer,
    ContextResolver.fakeLayer({ entries: [], rendered: "", total_chars: 0 }),
    SkillRegistry.emptyLayer,
    ToolExecutor.emptyLayer,
    Diagnostics.memoryLayer([]),
    llmLayer,
    IdeBridge.layer,
  )
  const agentLayer = AgentLoop.layer.pipe(Layer.provideMerge(agentBase))
  const remoteLayer = RemoteControl.layer.pipe(Layer.provideMerge(AgentLoop.layer.pipe(Layer.provideMerge(agentBase))))
  const httpLayer = HttpServer.layer.pipe(Layer.provideMerge(remoteLayer))
  return Layer.mergeAll(agentBase, agentLayer, remoteLayer, httpLayer)
}

const makeSystem = (): OrbManager.System => ({
  makeTempPath: Effect.succeed("/tmp/rika-orb-execute-test.bundle"),
  createGitBundle: () => Effect.succeed(new TextEncoder().encode("bundle-bytes")),
  currentBranch: () => Effect.succeed("main"),
  randomToken: Effect.succeed("server-token"),
  health: () => Effect.void,
  sleep: () => Effect.void,
})

const rewriteFetch =
  (fromOrigin: string, toOrigin: string): Client.FetchTransportInput["fetch"] =>
  (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const target = new URL(toOrigin)
    if (url.origin === fromOrigin) {
      url.protocol = target.protocol
      url.host = target.host
    }
    return fetch(url, init)
  }

const configureGitOrigin = async (workspace: string, origin: string) => {
  await runGit(workspace, ["init"])
  await runGit(workspace, ["remote", "add", "origin", origin])
}

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
}
