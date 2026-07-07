import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Settings, Time } from "@rika/core"
import { Database, McpApprovalStore, Migration, OrbStore, ProjectStore } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { OrbActivity, OrbManager, SandboxClient, SandboxClientFake } from "../src/index"

const now = Common.TimestampMillis.make(1_980_000_003_000)
const workspaceRoot = "/workspace/rika-orb-manager-test"
const threadId = Ids.ThreadId.make("thread_orb_manager")
const projectId = Ids.ProjectId.make("project_1")
const orbId = Ids.OrbId.make("orb_2")
const expectedServerLaunchCommand = (token = "server-token", baseCommit = "abc123") => [
  "bash",
  "-lc",
  `: > /tmp/rika-orb-server.log && exec rika server --host 0.0.0.0 --port 4587 --token ${token} --workspace /home/user/repo --orb --base-commit ${baseCommit} >> /tmp/rika-orb-server.log 2>&1`,
]
const resumeHookCommand =
  'if [ -e .agents/resume ] && [ ! -x .agents/resume ]; then echo \'Lifecycle hook file must be executable\' >&2; exit 126; fi; if [ ! -x .agents/resume ]; then echo \'Lifecycle hook skipped\' >&2; exit 0; fi; status_dir=$(mktemp -d); status_file="$status_dir/status"; (.agents/resume; code=$?; if [ -d "$status_dir" ]; then printf \'%s\' "$code" > "$status_file"; fi) & pid=$!; for _ in $(seq 1 100); do if [ -f "$status_file" ]; then code=$(cat "$status_file"); rm -rf "$status_dir"; wait "$pid" 2>/dev/null || true; exit "$code"; fi; sleep 0.1; done; echo \'Lifecycle hook detached after 10 seconds\' >&2; rm -rf "$status_dir"; disown "$pid" 2>/dev/null || true; exit 0'

describe("OrbManager", () => {
  test("provisions a sandboxed thread through bundle clone, setup, server start, health, and running status", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState({
      execResults: [
        [{ type: "exit", exitCode: 0 }],
        [
          { type: "stdout", data: "abc123\n" },
          { type: "exit", exitCode: 0 },
        ],
        [
          { type: "stdout", data: "setup ok\n" },
          { type: "exit", exitCode: 0 },
        ],
        [{ type: "started", pid: 4587 }],
      ],
    })
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
          template_id: "project-template",
          env: { RIKA_ENV: "test" },
        })
        yield* ProjectStore.setSecret(projectId, "OPENAI_API_KEY", "secret-openai")
        const record = yield* OrbManager.provisionForThread({
          thread_id: threadId,
          project_id: projectId,
          workspace_root: workspaceRoot,
        })
        const credentials = yield* OrbStore.endpointCredentials(record.orb_id)
        return { record, credentials }
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(result.record).toMatchObject({
      orb_id: orbId,
      thread_id: threadId,
      project_id: projectId,
      sandbox_id: "sandbox_1",
      status: "running",
      base_commit: "abc123",
      endpoint_url: "https://sandbox_1-4587.fake.rika.local",
    })
    expect(result.credentials).toEqual({
      endpoint_url: "https://sandbox_1-4587.fake.rika.local",
      token: "server-token",
    })
    expect(system.calls.bundle).toEqual([{ workspaceRoot, path: "/tmp/rika-orb-manager-test.bundle" }])
    expect(system.calls.currentBranch).toEqual([workspaceRoot])
    expect(system.calls.health).toEqual([{ url: "https://sandbox_1-4587.fake.rika.local", token: "server-token" }])
    expect(sandbox.calls.create).toEqual([
      {
        templateId: "project-template",
        envs: {},
        metadata: { app: "rika", thread_id: threadId, project_id: projectId },
        timeoutMs: 300_000,
        lifecycle: { onTimeout: "pause", autoResume: false },
      },
    ])
    expect(sandbox.calls.writeFile).toHaveLength(1)
    expect(sandbox.calls.writeFile[0]).toMatchObject({
      sandboxId: "sandbox_1",
      path: "/tmp/repo.bundle",
    })
    expect(new TextDecoder().decode(sandbox.calls.writeFile[0]?.bytes ?? new Uint8Array())).toBe("bundle-bytes")
    expect(sandbox.calls.exec).toHaveLength(4)
    expect(sandbox.calls.exec[0]).toEqual({
      sandboxId: "sandbox_1",
      cmd: [
        "bash",
        "-lc",
        "git clone /tmp/repo.bundle /home/user/repo && git -C /home/user/repo checkout -B feature/orb HEAD",
      ],
      opts: {},
    })
    expect(sandbox.calls.exec[1]).toEqual({
      sandboxId: "sandbox_1",
      cmd: ["git", "-C", "/home/user/repo", "rev-parse", "HEAD"],
      opts: {},
    })
    expect(sandbox.calls.exec[2]).toEqual({
      sandboxId: "sandbox_1",
      cmd: [
        "bash",
        "-lc",
        "if [ -e .agents/setup ] && [ ! -x .agents/setup ]; then echo 'Lifecycle hook file must be executable' >&2; exit 126; fi; if [ -x .agents/setup ]; then .agents/setup; fi",
      ],
      opts: {
        cwd: "/home/user/repo",
        envs: { OPENAI_API_KEY: "secret-openai", RIKA_ENV: "test" },
      },
    })
    expect(sandbox.calls.exec[3]).toEqual({
      sandboxId: "sandbox_1",
      cmd: expectedServerLaunchCommand(),
      opts: {
        background: true,
        cwd: "/home/user/repo",
        envs: { OPENAI_API_KEY: "secret-openai", RIKA_ENV: "test", RIKA_SUBAGENT_TOOLS: "full" },
      },
    })
    expect(sandbox.calls.kill).toEqual([])
    expect(JSON.stringify(sandbox.calls.exec.map((call) => call.cmd))).not.toContain("secret-openai")
    expect(diagnostics.some((entry) => entry.message === "orb.setup.stdout")).toBe(true)
    expect(diagnostics.find((entry) => entry.message === "orb.provision success")?.data).toMatchObject({
      thread_id: threadId,
      project_id: projectId,
      orb_id: orbId,
      sandbox_id: "sandbox_1",
      status: "running",
    })
    await rm(dataDir, { force: true, recursive: true })
  })

  test("uses settings template and idle timeout when env and project do not override", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-manager-settings-workspace-"))
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-settings-data-"))
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(
      join(workspace, ".rika", "settings.json"),
      JSON.stringify({
        "orb.template": "settings-template",
        "orb.idleTimeoutSeconds": 123,
      }),
    )
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
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* ProjectStore.create({
            name: "settings-demo",
            repo_origin: "https://github.com/example/settings-demo.git",
          })
          return yield* OrbManager.provisionForThread({
            thread_id: threadId,
            project_id: projectId,
            workspace_root: workspace,
          })
        }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir, workspaceRoot: workspace }))),
      )

      expect(sandbox.calls.create[0]).toMatchObject({
        templateId: "settings-template",
        timeoutMs: 123_000,
      })
    } finally {
      await rm(dataDir, { force: true, recursive: true })
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("redacts project secrets from setup diagnostics before the orb server starts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState({
      execResults: [
        [{ type: "exit", exitCode: 0 }],
        [
          { type: "stdout", data: "abc123\n" },
          { type: "exit", exitCode: 0 },
        ],
        [
          { type: "stdout", data: "setup saw secret-openai\n" },
          { type: "exit", exitCode: 0 },
        ],
        [{ type: "started", pid: 4587 }],
      ],
    })
    const diagnostics: Array<Diagnostics.Entry> = []

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
          template_id: "project-template",
          env: { RIKA_ENV: "test" },
        })
        yield* ProjectStore.setSecret(projectId, "OPENAI_API_KEY", "secret-openai")
        yield* OrbManager.provisionForThread({
          thread_id: threadId,
          project_id: projectId,
          workspace_root: workspaceRoot,
        })
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system: makeSystem(), dataDir }))),
    )

    expect(JSON.stringify(diagnostics)).toContain("[REDACTED:OPENAI_API_KEY]")
    expect(JSON.stringify(diagnostics)).not.toContain("secret-openai")
    await rm(dataDir, { force: true, recursive: true })
  })

  test("propagates approved workspace MCP servers without writing resolved secrets to sandbox settings", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-manager-mcp-workspace-"))
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-mcp-data-"))
    await mkdir(join(workspace, ".rika"), { recursive: true })
    const approvedConfig = { command: "node", args: ["approved.js"], env: { API_TOKEN: "${MCP_VALUE}" } }
    await writeFile(
      join(workspace, ".rika", "settings.json"),
      JSON.stringify({
        "mode.default": "deep3",
        "rika.mcpServers": {
          approved: approvedConfig,
          blocked: { command: "node", args: ["blocked.js"] },
          missingEnv: { url: "https://missing.example/mcp", headers: { authorization: "Bearer ${MISSING_TOKEN}" } },
          remote: { url: "https://remote.example/mcp", headers: { authorization: "Bearer ${REMOTE_VALUE}" } },
        },
      }),
    )
    const sandbox = SandboxClientFake.makeState({
      execResults: [
        [{ type: "exit", exitCode: 0 }],
        [
          { type: "stdout", data: "abc123\n" },
          { type: "exit", exitCode: 0 },
        ],
        [{ type: "exit", exitCode: 0 }],
        [{ type: "exit", exitCode: 0 }],
        [{ type: "exit", exitCode: 0 }],
        [{ type: "started", pid: 4587 }],
      ],
    })
    sandbox.files.set(
      "sandbox_1\0/home/user/repo/.rika/settings.json",
      new TextEncoder().encode(
        JSON.stringify({
          "mode.default": "rush",
          "rika.mcpServers": {
            old: { url: "https://old.example/mcp" },
          },
        }),
      ),
    )
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* ProjectStore.create({
            name: "demo",
            repo_origin: "https://github.com/example/rika.git",
            template_id: "project-template",
            env: { MCP_VALUE: "project-token-secret", REMOTE_VALUE: "remote-token-secret" },
          })
          yield* McpApprovalStore.approve({
            workspace_root: workspace,
            server_name: "approved",
            fingerprint: mcpFingerprint(approvedConfig, workspace),
          })
          yield* OrbManager.provisionForThread({
            thread_id: threadId,
            project_id: projectId,
            workspace_root: workspace,
          })
          yield* Diagnostics.emit({
            level: "info",
            message: "orb.mcp.redaction.probe",
            data: { approved: "project-token-secret", remote: "remote-token-secret" },
          })
        }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir, workspaceRoot: workspace }))),
      )

      const settingsWrite = sandbox.calls.writeFile.find((call) => call.path === "/home/user/repo/.rika/settings.json")
      if (settingsWrite === undefined) throw new Error("missing sandbox settings write")
      const settings = expectRecord(JSON.parse(new TextDecoder().decode(settingsWrite.bytes)), "sandbox settings")
      const settingsText = JSON.stringify(settings)
      expect(settings["mode.default"]).toBe("rush")
      expect(expectRecord(settings["rika.mcpServers"], "sandbox MCP servers")).toEqual({
        approved: { command: "node", args: ["approved.js"], env: { API_TOKEN: "${MCP_VALUE}" } },
        remote: { url: "https://remote.example/mcp", headers: { authorization: "Bearer ${REMOTE_VALUE}" } },
      })
      expect(settingsText).toContain("${MCP_VALUE}")
      expect(settingsText).toContain("${REMOTE_VALUE}")
      expect(settingsText).not.toContain("project-token-secret")
      expect(settingsText).not.toContain("remote-token-secret")
      expect(JSON.stringify(diagnostics)).toContain("[REDACTED:MCP_VALUE]")
      expect(JSON.stringify(diagnostics)).toContain("[REDACTED:REMOTE_VALUE]")
      expect(JSON.stringify(diagnostics)).not.toContain("project-token-secret")
      expect(JSON.stringify(diagnostics)).not.toContain("remote-token-secret")
      expect(sandbox.calls.exec).toContainEqual({
        sandboxId: "sandbox_1",
        cmd: ["rika", "mcp", "approve", "approved"],
        opts: {
          cwd: "/home/user/repo",
          envs: {
            RIKA_DATA_DIR: "/home/user/repo/.rika",
            RIKA_WORKSPACE_ROOT: "/home/user/repo",
          },
        },
      })
      const approvalIndex = sandbox.calls.exec.findIndex((call) => call.cmd.join(" ") === "rika mcp approve approved")
      const setupIndex = sandbox.calls.exec.findIndex((call) => call.cmd.join(" ").includes(".agents/setup"))
      const serverIndex = sandbox.calls.exec.findIndex((call) => call.cmd.join(" ").includes("exec rika server"))
      expect(approvalIndex).toBeGreaterThan(0)
      expect(approvalIndex).toBeLessThan(setupIndex)
      expect(setupIndex).toBeLessThan(serverIndex)
      expect(diagnostics).toContainEqual({
        level: "warn",
        message: "orb.mcp.warning",
        data: {
          sandbox_id: "sandbox_1",
          server_name: "missingEnv",
          reason: "Unresolved MCP config variable MISSING_TOKEN",
        },
      })
    } finally {
      await rm(dataDir, { force: true, recursive: true })
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("rejects approved workspace MCP launch identity placeholders before writing sandbox settings", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-manager-mcp-workspace-"))
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-mcp-data-"))
    await mkdir(join(workspace, ".rika"), { recursive: true })
    const approvedConfig = { command: "${MCP_CMD}", args: ["approved.js"], env: { API_TOKEN: "${MCP_VALUE}" } }
    await writeFile(
      join(workspace, ".rika", "settings.json"),
      JSON.stringify({
        "rika.mcpServers": {
          approved: approvedConfig,
        },
      }),
    )
    const sandbox = SandboxClientFake.makeState({
      execResults: [
        [{ type: "exit", exitCode: 0 }],
        [
          { type: "stdout", data: "abc123\n" },
          { type: "exit", exitCode: 0 },
        ],
      ],
    })
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* ProjectStore.create({
            name: "demo",
            repo_origin: "https://github.com/example/rika.git",
            template_id: "project-template",
            env: { MCP_CMD: "node", MCP_VALUE: "project-token-secret" },
          })
          yield* McpApprovalStore.approve({
            workspace_root: workspace,
            server_name: "approved",
            fingerprint: mcpFingerprint(approvedConfig, workspace),
          })
          const provision = yield* Effect.result(
            OrbManager.provisionForThread({
              thread_id: threadId,
              project_id: projectId,
              workspace_root: workspace,
            }),
          )
          const stored = yield* OrbStore.get(orbId)
          return { provision, stored }
        }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir, workspaceRoot: workspace }))),
      )

      expect(result.provision._tag).toBe("Failure")
      if (result.provision._tag !== "Failure") throw new Error("expected provision failure")
      expect(result.provision.failure).toBeInstanceOf(OrbManager.OrbProvisionError)
      if (!(result.provision.failure instanceof OrbManager.OrbProvisionError))
        throw new Error("expected OrbProvisionError")
      expect(result.provision.failure.step).toBe("mcp")
      expect(result.stored).toMatchObject({ orb_id: orbId, status: "killed", sandbox_id: "sandbox_1" })
      expect(sandbox.calls.writeFile.some((call) => call.path === "/home/user/repo/.rika/settings.json")).toBe(false)
      expect(sandbox.calls.kill).toEqual(["sandbox_1"])
    } finally {
      await rm(dataDir, { force: true, recursive: true })
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("interrupting provisioning after sandbox creation kills the sandbox and marks the orb terminal", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState()
    const diagnostics: Array<Diagnostics.Entry> = []
    const entered = Effect.runSync(Deferred.make<void>())
    const baseSystem = makeSystem()
    const system = {
      ...baseSystem,
      makeTempPath: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    }

    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
          template_id: "project-template",
          env: { RIKA_ENV: "test" },
        })
        const fiber = yield* OrbManager.provisionForThread({
          thread_id: threadId,
          project_id: projectId,
          workspace_root: workspaceRoot,
        }).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        return yield* OrbStore.get(orbId)
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(sandbox.calls.kill).toEqual(["sandbox_1"])
    expect(stored).toMatchObject({ orb_id: orbId, status: "killed", sandbox_id: "sandbox_1" })
    await rm(dataDir, { force: true, recursive: true })
  })

  test("marks the staged orb terminal when sandbox creation fails so the same thread can retry", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState()
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
          template_id: "project-template",
          env: { RIKA_ENV: "test" },
        })
        const first = yield* Effect.result(
          OrbManager.provisionForThread({
            thread_id: threadId,
            project_id: projectId,
            workspace_root: workspaceRoot,
          }),
        )
        const firstStored = yield* OrbStore.get(orbId)
        const second = yield* Effect.result(
          OrbManager.provisionForThread({
            thread_id: threadId,
            project_id: projectId,
            workspace_root: workspaceRoot,
          }),
        )
        const secondStored = yield* OrbStore.get(Ids.OrbId.make("orb_3"))
        return { first, firstStored, second, secondStored }
      }).pipe(
        Effect.provide(
          makeLayer({
            sandbox,
            diagnostics,
            system,
            dataDir,
            sandboxLayer: sandboxCreateFailureLayer("create rejected"),
          }),
        ),
      ),
    )

    expect(result.first._tag).toBe("Failure")
    if (result.first._tag !== "Failure") throw new Error("expected first failure")
    expect(result.first.failure).toBeInstanceOf(OrbManager.OrbProvisionError)
    if (!(result.first.failure instanceof OrbManager.OrbProvisionError))
      throw new Error("expected first provision error")
    expect(result.first.failure.step).toBe("create_sandbox")
    expect(result.firstStored).toMatchObject({ orb_id: orbId, status: "killed", sandbox_id: null })
    expect(result.second._tag).toBe("Failure")
    if (result.second._tag !== "Failure") throw new Error("expected second failure")
    expect(result.second.failure).toBeInstanceOf(OrbManager.OrbProvisionError)
    if (!(result.second.failure instanceof OrbManager.OrbProvisionError))
      throw new Error("expected second provision error")
    expect(result.second.failure.step).toBe("create_sandbox")
    expect(result.secondStored).toMatchObject({ orb_id: Ids.OrbId.make("orb_3"), status: "killed", sandbox_id: null })
    await rm(dataDir, { force: true, recursive: true })
  })

  test("kills the sandbox and marks the orb killed when setup fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState({
      execResults: [
        [{ type: "exit", exitCode: 0 }],
        [
          { type: "stdout", data: "abc123\n" },
          { type: "exit", exitCode: 0 },
        ],
        [
          { type: "stderr", data: "setup failed\n" },
          { type: "exit", exitCode: 17 },
        ],
      ],
    })
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
          template_id: "project-template",
          env: { RIKA_ENV: "test" },
        })
        const provision = yield* Effect.result(
          OrbManager.provisionForThread({
            thread_id: threadId,
            project_id: projectId,
            workspace_root: workspaceRoot,
          }),
        )
        const stored = yield* OrbStore.get(orbId)
        return { provision, stored }
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(result.provision._tag).toBe("Failure")
    if (result.provision._tag !== "Failure") throw new Error("expected provision failure")
    expect(result.provision.failure).toBeInstanceOf(OrbManager.OrbProvisionError)
    if (!(result.provision.failure instanceof OrbManager.OrbProvisionError)) {
      throw new Error("expected OrbProvisionError")
    }
    expect(result.provision.failure.step).toBe("setup")
    expect(result.provision.failure.orb_id).toBe(orbId)
    expect(result.provision.failure.sandbox_id).toBe("sandbox_1")
    expect(sandbox.calls.kill).toEqual(["sandbox_1"])
    expect(result.stored).toMatchObject({ orb_id: orbId, status: "killed", sandbox_id: "sandbox_1" })
    expect(sandbox.calls.exec).toHaveLength(3)
    expect(diagnostics).toContainEqual({
      level: "info",
      message: "orb.setup.stderr",
      data: { sandbox_id: "sandbox_1", line: "setup failed" },
    })
    expect(sandbox.calls.exec[2]?.cmd).toEqual([
      "bash",
      "-lc",
      "if [ -e .agents/setup ] && [ ! -x .agents/setup ]; then echo 'Lifecycle hook file must be executable' >&2; exit 126; fi; if [ -x .agents/setup ]; then .agents/setup; fi",
    ])
    await rm(dataDir, { force: true, recursive: true })
  })

  test("fails fast with the server log tail when the orb server exits before health", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState({
      execResults: [
        [{ type: "exit", exitCode: 0 }],
        [
          { type: "stdout", data: "abc123\n" },
          { type: "exit", exitCode: 0 },
        ],
        [{ type: "exit", exitCode: 0 }],
        [{ type: "started", pid: 4587 }],
        [{ type: "exit", exitCode: 1 }],
        [
          { type: "stdout", data: "Rika failed: Missing required config value RIKA_API_KEY\n" },
          { type: "exit", exitCode: 0 },
        ],
      ],
    })
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem({ failingHealthChecks: 60 })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
          template_id: "project-template",
          env: { RIKA_ENV: "test" },
        })
        const provision = yield* Effect.result(
          OrbManager.provisionForThread({
            thread_id: threadId,
            project_id: projectId,
            workspace_root: workspaceRoot,
          }),
        )
        const stored = yield* OrbStore.get(orbId)
        return { provision, stored }
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(result.provision._tag).toBe("Failure")
    if (result.provision._tag !== "Failure") throw new Error("expected provision failure")
    expect(result.provision.failure).toBeInstanceOf(OrbManager.OrbProvisionError)
    if (!(result.provision.failure instanceof OrbManager.OrbProvisionError)) {
      throw new Error("expected OrbProvisionError")
    }
    expect(result.provision.failure.message).toContain("Missing required config value RIKA_API_KEY")
    expect(result.provision.failure.orb_id).toBe(orbId)
    expect(result.provision.failure.sandbox_id).toBe("sandbox_1")
    expect(system.calls.health).toHaveLength(1)
    expect(system.calls.sleep).toEqual([])
    expect(sandbox.calls.kill).toEqual(["sandbox_1"])
    expect(result.stored).toMatchObject({ orb_id: orbId, status: "killed", sandbox_id: "sandbox_1" })
    await rm(dataDir, { force: true, recursive: true })
  })

  test("emits cleanup diagnostics when provisioning compensation fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState({
      killFailureMessage: "kill denied",
      execResults: [
        [{ type: "exit", exitCode: 0 }],
        [
          { type: "stdout", data: "abc123\n" },
          { type: "exit", exitCode: 0 },
        ],
        [
          { type: "stderr", data: "setup failed\n" },
          { type: "exit", exitCode: 17 },
        ],
      ],
    })
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
          template_id: "project-template",
          env: { RIKA_ENV: "test" },
        })
        const provision = yield* Effect.result(
          OrbManager.provisionForThread({
            thread_id: threadId,
            project_id: projectId,
            workspace_root: workspaceRoot,
          }),
        )
        const stored = yield* OrbStore.get(orbId)
        return { provision, stored }
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(result.provision._tag).toBe("Failure")
    if (result.provision._tag !== "Failure") throw new Error("expected provision failure")
    expect(result.stored).toMatchObject({ orb_id: orbId, status: "killed", sandbox_id: "sandbox_1" })
    expect(sandbox.calls.kill).toEqual(["sandbox_1"])
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "orb.provision.cleanup success",
        data: expect.objectContaining({
          orb_id: orbId,
          sandbox_id: "sandbox_1",
          kill: "failure",
          kill_error: "kill denied",
          status_update: "success",
        }),
      }),
    )
    await rm(dataDir, { force: true, recursive: true })
  })

  test("uses env template and timeout overrides with origin clone credentials kept in exec env", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState({
      execResults: [
        [{ type: "exit", exitCode: 0 }],
        [
          { type: "stdout", data: "def456\n" },
          { type: "exit", exitCode: 0 },
        ],
        [{ type: "exit", exitCode: 0 }],
        [{ type: "started", pid: 4587 }],
      ],
    })
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ProjectStore.create({
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
          default_branch: "trunk",
          template_id: "project-template",
          env: { RIKA_ENV: "test" },
        })
        yield* ProjectStore.setSecret(projectId, "GIT_TOKEN", "git-secret")
        yield* ProjectStore.setSecret(projectId, "OPENAI_API_KEY", "secret-openai")
        const record = yield* OrbManager.provisionForThread({
          thread_id: threadId,
          project_id: projectId,
          workspace_root: workspaceRoot,
        })
        return { record }
      }).pipe(
        Effect.provide(
          makeLayer({
            sandbox,
            diagnostics,
            system,
            dataDir,
            env: {
              RIKA_ORB_TEMPLATE: "env-template",
              RIKA_ORB_IDLE_TIMEOUT: "42",
              RIKA_ORB_CLONE: "origin",
            },
          }),
        ),
      ),
    )

    expect(result.record).toMatchObject({
      status: "running",
      base_commit: "def456",
      endpoint_url: "https://sandbox_1-4587.fake.rika.local",
    })
    expect(system.calls.bundle).toEqual([])
    expect(system.calls.currentBranch).toEqual([])
    expect(sandbox.calls.writeFile).toEqual([])
    expect(sandbox.calls.create[0]).toEqual({
      templateId: "env-template",
      envs: {},
      metadata: { app: "rika", thread_id: threadId, project_id: projectId },
      timeoutMs: 42_000,
      lifecycle: { onTimeout: "pause", autoResume: false },
    })
    expect(sandbox.calls.exec[0]).toEqual({
      sandboxId: "sandbox_1",
      cmd: [
        "bash",
        "-lc",
        "git -c 'credential.helper=!f() { echo username=x-access-token; echo password=$GIT_TOKEN; }; f' clone --branch trunk https://github.com/example/rika.git /home/user/repo",
      ],
      opts: { envs: { GIT_TOKEN: "git-secret" } },
    })
    expect(sandbox.calls.exec[2]?.opts.envs).toEqual({
      GIT_TOKEN: "git-secret",
      OPENAI_API_KEY: "secret-openai",
      RIKA_ENV: "test",
    })
    expect(sandbox.calls.exec[3]?.opts.envs).toEqual({
      GIT_TOKEN: "git-secret",
      OPENAI_API_KEY: "secret-openai",
      RIKA_ENV: "test",
      RIKA_SUBAGENT_TOOLS: "full",
    })
    expect(JSON.stringify(sandbox.calls.exec.map((call) => call.cmd))).not.toContain("git-secret")
    await rm(dataDir, { force: true, recursive: true })
  })

  test("pause resume and kill delegate to the sandbox and persist status transitions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState()
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
          endpoint_url: "https://sandbox_1-4587.fake.rika.local",
          token: "server-token",
        })
        yield* OrbStore.setStatus(created.orb_id, "running")
        const paused = yield* OrbManager.pause(created.orb_id)
        const resumed = yield* OrbManager.resume(created.orb_id)
        const killed = yield* OrbManager.kill(created.orb_id)
        return { paused, resumed, killed }
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(result.paused.status).toBe("paused")
    expect(result.resumed.status).toBe("running")
    expect(result.killed.status).toBe("killed")
    expect(sandbox.calls.pause).toEqual(["sandbox_1"])
    expect(sandbox.calls.resume).toEqual(["sandbox_1"])
    expect(sandbox.calls.kill).toEqual(["sandbox_1"])
    expect(diagnostics.find((entry) => entry.message === "orb.pause success")?.data).toMatchObject({
      orb_id: result.paused.orb_id,
      sandbox_id: "sandbox_1",
    })
    expect(diagnostics.find((entry) => entry.message === "orb.kill success")?.data).toMatchObject({
      orb_id: result.killed.orb_id,
      sandbox_id: "sandbox_1",
    })
    await rm(dataDir, { force: true, recursive: true })
  })

  test("kill releases activity state after the terminal transition", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState()
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()
    const releases: Array<Ids.OrbId> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
          endpoint_url: "https://sandbox_1-4587.fake.rika.local",
          token: "server-token",
        })
        yield* OrbStore.setStatus(created.orb_id, "running")
        yield* OrbManager.kill(created.orb_id)
        const stored = yield* OrbStore.get(created.orb_id)
        return { kill: sandbox.calls.kill, stored }
      }).pipe(
        Effect.provide(
          makeLayer({
            sandbox,
            diagnostics,
            system,
            dataDir,
            activityLayer: activityReleaseRecorderLayer(releases),
          }),
        ),
      ),
    )

    expect(result.kill).toEqual(["sandbox_1"])
    expect(result.stored).toMatchObject({ status: "killed" })
    if (result.stored === undefined) throw new Error("Missing killed orb")
    expect(releases).toEqual([result.stored.orb_id])
    await rm(dataDir, { force: true, recursive: true })
  })

  test("kill marks the orb killed even when the sandbox provider reports it missing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState({ killFailureMessage: "sandbox not found" })
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
          endpoint_url: "https://sandbox_1-4587.fake.rika.local",
          token: "server-token",
        })
        yield* OrbStore.setStatus(created.orb_id, "running")
        const killed = yield* OrbManager.kill(created.orb_id)
        const stored = yield* OrbStore.get(created.orb_id)
        return { killed, stored }
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(result.killed.status).toBe("killed")
    expect(result.stored).toMatchObject({ status: "killed" })
    expect(sandbox.calls.kill).toEqual(["sandbox_1"])
    await rm(dataDir, { force: true, recursive: true })
  })

  test("pause and kill on the same orb do not overlap sandbox lifecycle calls", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()
    const pauseEntered = Effect.runSync(Deferred.make<void>())
    const releasePause = Effect.runSync(Deferred.make<void>())
    const killEntered = Effect.runSync(Deferred.make<void>())
    const events: Array<string> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
          endpoint_url: "https://sandbox_1-4587.fake.rika.local",
          token: "server-token",
        })
        yield* OrbStore.setStatus(created.orb_id, "running")
        const pauseFiber = yield* OrbManager.pause(created.orb_id).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(pauseEntered)
        const killFiber = yield* OrbManager.kill(created.orb_id).pipe(Effect.exit, Effect.forkChild)
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        const killEnteredBeforePauseRelease = yield* Deferred.isDone(killEntered)
        yield* Deferred.succeed(releasePause, undefined)
        const pauseResult = yield* Fiber.join(pauseFiber)
        const killResult = yield* Fiber.join(killFiber)
        const stored = yield* OrbStore.get(created.orb_id)
        return { killEnteredBeforePauseRelease, killResult, pauseResult, stored }
      }).pipe(
        Effect.provide(
          makeLayer({
            sandbox: SandboxClientFake.makeState(),
            diagnostics,
            system,
            dataDir,
            sandboxLayer: delayedPauseLifecycleLayer({
              events,
              killEntered,
              pauseEntered,
              releasePause,
            }),
          }),
        ),
      ),
    )

    expect(result.killEnteredBeforePauseRelease).toBe(false)
    expect(result.pauseResult._tag).toBe("Success")
    expect(result.killResult._tag).toBe("Success")
    expect(result.stored).toMatchObject({ status: "killed" })
    expect(events).toEqual(["pause-enter", "pause-exit", "kill-enter", "kill-exit"])
    await rm(dataDir, { force: true, recursive: true })
  })

  test("pause queued behind kill rejects without pausing a killed sandbox", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()
    const killEntered = Effect.runSync(Deferred.make<void>())
    const releaseKill = Effect.runSync(Deferred.make<void>())
    const events: Array<string> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
          endpoint_url: "https://sandbox_1-4587.fake.rika.local",
          token: "server-token",
        })
        yield* OrbStore.setStatus(created.orb_id, "running")
        const killFiber = yield* OrbManager.kill(created.orb_id).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(killEntered)
        const pauseFiber = yield* OrbManager.pause(created.orb_id).pipe(Effect.exit, Effect.forkChild)
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* Deferred.succeed(releaseKill, undefined)
        const killResult = yield* Fiber.join(killFiber)
        const pauseResult = yield* Fiber.join(pauseFiber)
        const stored = yield* OrbStore.get(created.orb_id)
        return { killResult, pauseResult, stored }
      }).pipe(
        Effect.provide(
          makeLayer({
            sandbox: SandboxClientFake.makeState(),
            diagnostics,
            system,
            dataDir,
            sandboxLayer: delayedKillLifecycleLayer({
              events,
              killEntered,
              releaseKill,
            }),
          }),
        ),
      ),
    )

    expect(result.killResult._tag).toBe("Success")
    expect(result.pauseResult._tag).toBe("Failure")
    expect(result.stored).toMatchObject({ status: "killed" })
    expect(events).toEqual(["kill-enter", "kill-exit"])
    await rm(dataDir, { force: true, recursive: true })
  })

  test("pause and resume on the same orb serialize into a final running status", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()
    const pauseEntered = Effect.runSync(Deferred.make<void>())
    const releasePause = Effect.runSync(Deferred.make<void>())
    const events: Array<string> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
          endpoint_url: "https://sandbox_1-4587.fake.rika.local",
          token: "server-token",
        })
        yield* OrbStore.setStatus(created.orb_id, "running")
        const resumeCompleted = yield* Deferred.make<void>()
        const pauseFiber = yield* OrbManager.pause(created.orb_id).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(pauseEntered)
        const resumeFiber = yield* OrbManager.resume(created.orb_id).pipe(
          Effect.exit,
          Effect.tap(() => Deferred.succeed(resumeCompleted, undefined)),
          Effect.forkChild,
        )
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        const resumeCompletedBeforePauseRelease = yield* Deferred.isDone(resumeCompleted)
        yield* Deferred.succeed(releasePause, undefined)
        const pauseResult = yield* Fiber.join(pauseFiber)
        const resumeResult = yield* Fiber.join(resumeFiber)
        const stored = yield* OrbStore.get(created.orb_id)
        return { pauseResult, resumeCompletedBeforePauseRelease, resumeResult, stored }
      }).pipe(
        Effect.provide(
          makeLayer({
            sandbox: SandboxClientFake.makeState(),
            diagnostics,
            system,
            dataDir,
            sandboxLayer: delayedPauseLifecycleLayer({
              events,
              pauseEntered,
              releasePause,
            }),
          }),
        ),
      ),
    )

    expect(result.resumeCompletedBeforePauseRelease).toBe(false)
    expect(result.pauseResult._tag).toBe("Success")
    expect(result.resumeResult._tag).toBe("Success")
    expect(result.stored).toMatchObject({ status: "running" })
    expect(events).toEqual(["pause-enter", "pause-exit", "resume-enter", "resume-exit"])
    await rm(dataDir, { force: true, recursive: true })
  })

  test("pause and kill reject provisioning orbs without mutating the sandbox", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState()
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
        })
        const pauseError = yield* OrbManager.pause(created.orb_id).pipe(Effect.flip)
        const killError = yield* OrbManager.kill(created.orb_id).pipe(Effect.flip)
        const stored = yield* OrbStore.get(created.orb_id)
        return { pauseError, killError, stored }
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(result.pauseError.step).toBe("pause")
    expect(result.killError.step).toBe("kill")
    expect(result.stored).toMatchObject({ status: "provisioning", sandbox_id: "sandbox_1" })
    expect(sandbox.calls.pause).toEqual([])
    expect(sandbox.calls.kill).toEqual([])
    await rm(dataDir, { force: true, recursive: true })
  })

  test("resume refreshes endpoint, validates health, runs resume hook, and marks running", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState()
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
          endpoint_url: "https://old-orb-endpoint.fake.rika.local",
          token: "server-token",
        })
        yield* OrbStore.setStatus(created.orb_id, "running")
        yield* OrbStore.setStatus(created.orb_id, "paused")
        const resumed = yield* OrbManager.resume(created.orb_id)
        const credentials = yield* OrbStore.endpointCredentials(created.orb_id)
        return { resumed, credentials }
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(result.resumed.status).toBe("running")
    expect(result.resumed.endpoint_url).toBe("https://sandbox_1-4587.fake.rika.local")
    expect(result.credentials).toEqual({
      endpoint_url: "https://sandbox_1-4587.fake.rika.local",
      token: "server-token",
    })
    expect(sandbox.calls.resume).toEqual(["sandbox_1"])
    expect(sandbox.calls.hostUrl).toEqual([{ sandboxId: "sandbox_1", port: 4587 }])
    expect(system.calls.health).toEqual([{ url: "https://sandbox_1-4587.fake.rika.local", token: "server-token" }])
    expect(sandbox.calls.exec).toEqual([
      {
        sandboxId: "sandbox_1",
        cmd: ["bash", "-lc", resumeHookCommand],
        opts: { cwd: "/home/user/repo" },
      },
    ])
    expect(diagnostics.find((entry) => entry.message === "orb.resume success")?.data).toMatchObject({
      orb_id: result.resumed.orb_id,
      sandbox_id: "sandbox_1",
      hook_status: "ok",
    })
    await rm(dataDir, { force: true, recursive: true })
  })

  test("resume relaunches the orb server with the stored token and base commit when health stays down", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState({
      execResults: [[{ type: "started", pid: 4587 }], [{ type: "exit", exitCode: 0 }]],
    })
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem({ failingHealthChecks: 15 })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
          endpoint_url: "https://old-orb-endpoint.fake.rika.local",
          token: "server-token",
        })
        yield* OrbStore.setStatus(created.orb_id, "running")
        yield* OrbStore.setStatus(created.orb_id, "paused")
        yield* OrbManager.resume(created.orb_id)
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(system.calls.health).toHaveLength(16)
    expect(system.calls.sleep).toHaveLength(14)
    expect(sandbox.calls.exec[0]).toEqual({
      sandboxId: "sandbox_1",
      cmd: expectedServerLaunchCommand(),
      opts: {
        background: true,
        cwd: "/home/user/repo",
        envs: { RIKA_SUBAGENT_TOOLS: "full" },
      },
    })
    expect(sandbox.calls.exec[1]).toEqual({
      sandboxId: "sandbox_1",
      cmd: ["bash", "-lc", resumeHookCommand],
      opts: { cwd: "/home/user/repo" },
    })
    await rm(dataDir, { force: true, recursive: true })
  })

  test("resume records failed hook diagnostics without blocking running status", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState({
      execResults: [
        [
          { type: "stderr", data: "resume failed\n" },
          { type: "exit", exitCode: 9 },
        ],
      ],
    })
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
          endpoint_url: "https://old-orb-endpoint.fake.rika.local",
          token: "server-token",
        })
        yield* OrbStore.setStatus(created.orb_id, "running")
        yield* OrbStore.setStatus(created.orb_id, "paused")
        return yield* OrbManager.resume(created.orb_id)
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(result.status).toBe("running")
    expect(diagnostics.find((entry) => entry.message === "orb.resume success")?.data).toMatchObject({
      hook_status: "failed",
      hook_exit_code: 9,
    })
    await rm(dataDir, { force: true, recursive: true })
  })

  test("resume records detached hook diagnostics without killing the resume operation", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState({
      execResults: [
        [
          { type: "stderr", data: "Lifecycle hook detached after 10 seconds\n" },
          { type: "exit", exitCode: 0 },
        ],
      ],
    })
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
          endpoint_url: "https://old-orb-endpoint.fake.rika.local",
          token: "server-token",
        })
        yield* OrbStore.setStatus(created.orb_id, "running")
        yield* OrbStore.setStatus(created.orb_id, "paused")
        return yield* OrbManager.resume(created.orb_id)
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(result.status).toBe("running")
    expect(diagnostics.find((entry) => entry.message === "orb.resume success")?.data).toMatchObject({
      hook_status: "detached",
    })
    await rm(dataDir, { force: true, recursive: true })
  })

  test("concurrent resume calls perform one sandbox resume and return the running record", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-"))
    const sandbox = SandboxClientFake.makeState()
    const diagnostics: Array<Diagnostics.Entry> = []
    const system = makeSystem()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* OrbStore.create({
          thread_id: threadId,
          project_id: projectId,
          sandbox_id: "sandbox_1",
          base_commit: "abc123",
          endpoint_url: "https://old-orb-endpoint.fake.rika.local",
          token: "server-token",
        })
        yield* OrbStore.setStatus(created.orb_id, "running")
        yield* OrbStore.setStatus(created.orb_id, "paused")
        return yield* Effect.all([OrbManager.resume(created.orb_id), OrbManager.resume(created.orb_id)], {
          concurrency: "unbounded",
        })
      }).pipe(Effect.provide(makeLayer({ sandbox, diagnostics, system, dataDir }))),
    )

    expect(result.map((record) => record.status)).toEqual(["running", "running"])
    expect(sandbox.calls.resume).toEqual(["sandbox_1"])
    await rm(dataDir, { force: true, recursive: true })
  })

  const integration = Bun.env.E2B_API_KEY === undefined || Bun.env.E2B_API_KEY.length === 0 ? test.skip : test

  integration("provisions a tiny fixture repo and protects health with the orb token", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-orb-manager-data-"))
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-manager-workspace-"))
    await runGit(workspace, ["init", "-b", "main"])
    await runGit(workspace, ["config", "user.email", "rika@example.test"])
    await runGit(workspace, ["config", "user.name", "Rika Test"])
    await writeFile(join(workspace, "README.md"), "orb integration\n")
    await runGit(workspace, ["add", "README.md"])
    await runGit(workspace, ["commit", "-m", "init"])

    const diagnostics: Array<Diagnostics.Entry> = []
    const configLayer = Config.layerFromValues(
      {
        workspace_root: workspace,
        data_dir: dataDir,
        default_mode: "smart",
      },
      process.env,
    )
    const databaseLayer = Database.memoryLayer
    const timeLayer = Time.fixedLayer(now)
    const idLayer = IdGenerator.sequenceLayer(1)
    const mcpApprovalLayer = McpApprovalStore.layer.pipe(
      Layer.provideMerge(databaseLayer),
      Layer.provideMerge(timeLayer),
    )
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
    const sandboxLayer = SandboxClient.layer.pipe(Layer.provide(configLayer))
    const redactorLayer = SecretRedactor.layer
    const diagnosticsLayer = Diagnostics.memoryLayer(diagnostics).pipe(Layer.provideMerge(redactorLayer))
    const managerLayer = OrbManager.layer.pipe(
      Layer.provideMerge(configLayer),
      Layer.provideMerge(mcpApprovalLayer),
      Layer.provideMerge(projectStoreLayer),
      Layer.provideMerge(orbStoreLayer),
      Layer.provideMerge(sandboxLayer),
      Layer.provideMerge(diagnosticsLayer),
      Layer.provideMerge(redactorLayer),
    )
    const layer = Layer.mergeAll(
      configLayer,
      databaseLayer,
      Migration.layer,
      timeLayer,
      idLayer,
      mcpApprovalLayer,
      projectStoreLayer,
      orbStoreLayer,
      sandboxLayer,
      redactorLayer,
      diagnosticsLayer,
      managerLayer,
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        let provisioned: Ids.OrbId | undefined
        return yield* Effect.gen(function* () {
          yield* Migration.migrate()
          const project = yield* ProjectStore.create({
            name: "integration",
            repo_origin: "https://github.com/example/rika.git",
          })
          const record = yield* OrbManager.provisionForThread({
            thread_id: Ids.ThreadId.make("thread_orb_integration"),
            project_id: project.project_id,
            workspace_root: workspace,
          })
          provisioned = record.orb_id
          const credentials = yield* OrbStore.endpointCredentials(record.orb_id)
          if (credentials === undefined) {
            return yield* Effect.fail(new Error("missing orb endpoint credentials"))
          }
          const unauthorized = yield* Effect.tryPromise(() => fetch(`${credentials.endpoint_url}/health`))
          const authorized = yield* Effect.tryPromise(() =>
            fetch(`${credentials.endpoint_url}/health`, {
              headers: { authorization: `Bearer ${credentials.token}` },
            }),
          )
          return { record, unauthorizedStatus: unauthorized.status, authorizedOk: authorized.ok }
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              provisioned === undefined ? Effect.void : OrbManager.kill(provisioned).pipe(Effect.ignore),
            ),
          ),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.record.status).toBe("running")
    expect(result.unauthorizedStatus).toBe(401)
    expect(result.authorizedOk).toBe(true)
    await rm(dataDir, { force: true, recursive: true })
    await rm(workspace, { force: true, recursive: true })
  })
})

const makeLayer = (input: {
  readonly sandbox: SandboxClientFake.State
  readonly diagnostics: Array<Diagnostics.Entry>
  readonly system: OrbManager.System
  readonly dataDir: string
  readonly env?: Record<string, string | undefined>
  readonly workspaceRoot?: string
  readonly sandboxLayer?: Layer.Layer<SandboxClient.Service>
  readonly activityLayer?: Layer.Layer<OrbActivity.Service>
}) => {
  const root = input.workspaceRoot ?? workspaceRoot
  const sandboxLayer = input.sandboxLayer ?? SandboxClientFake.layer(input.sandbox)
  const configLayer = Config.layerFromValues(
    {
      workspace_root: root,
      data_dir: input.dataDir,
      default_mode: "smart",
    },
    input.env ?? {},
  )
  const settingsLayer = Settings.layerFromEnv(input.env ?? {}, root)
  const databaseLayer = Database.memoryLayer
  const timeLayer = Time.fixedLayer(now)
  const idLayer = IdGenerator.sequenceLayer(1)
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer(input.diagnostics).pipe(Layer.provideMerge(redactorLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
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
  const activityLayer =
    input.activityLayer ??
    OrbActivity.layer.pipe(
      Layer.provideMerge(configLayer),
      Layer.provideMerge(settingsLayer),
      Layer.provideMerge(orbStoreLayer),
      Layer.provideMerge(sandboxLayer),
      Layer.provideMerge(timeLayer),
    )
  const managerLayer = OrbManager.layerWithSystem(input.system).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(mcpApprovalLayer),
    Layer.provideMerge(projectStoreLayer),
    Layer.provideMerge(orbStoreLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(activityLayer),
    Layer.provideMerge(diagnosticsLayer),
    Layer.provideMerge(redactorLayer),
  )
  return Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    timeLayer,
    idLayer,
    redactorLayer,
    settingsLayer,
    mcpApprovalLayer,
    projectStoreLayer,
    orbStoreLayer,
    sandboxLayer,
    activityLayer,
    diagnosticsLayer,
    managerLayer,
  )
}

const activityReleaseRecorderLayer = (releases: Array<Ids.OrbId>) =>
  Layer.succeed(
    OrbActivity.Service,
    OrbActivity.Service.of({
      touch: () => Effect.void,
      release: (releasedOrbId) =>
        Effect.sync(() => {
          releases.push(releasedOrbId)
        }),
    }),
  )

const delayedPauseLifecycleLayer = (input: {
  readonly events: Array<string>
  readonly pauseEntered: Deferred.Deferred<void>
  readonly releasePause: Deferred.Deferred<void>
  readonly killEntered?: Deferred.Deferred<void>
}) =>
  Layer.succeed(
    SandboxClient.Service,
    SandboxClient.Service.of({
      create: () => Effect.never,
      exec: () => Stream.fromIterable([{ type: "exit" as const, exitCode: 0 }]),
      writeFile: () => Effect.never,
      readFile: () => Effect.never,
      hostUrl: (sandboxId, port) => Effect.succeed(`https://${sandboxId}-${port}.fake.rika.local`),
      pause: () =>
        Effect.gen(function* () {
          input.events.push("pause-enter")
          yield* Deferred.succeed(input.pauseEntered, undefined)
          yield* Deferred.await(input.releasePause)
          input.events.push("pause-exit")
        }),
      resume: () =>
        Effect.sync(() => {
          input.events.push("resume-enter")
          input.events.push("resume-exit")
        }),
      kill: () =>
        Effect.gen(function* () {
          input.events.push("kill-enter")
          if (input.killEntered !== undefined) yield* Deferred.succeed(input.killEntered, undefined)
          input.events.push("kill-exit")
        }),
      setTimeout: () => Effect.never,
      list: () => Effect.never,
      templateExists: () => Effect.never,
    }),
  )

const delayedKillLifecycleLayer = (input: {
  readonly events: Array<string>
  readonly killEntered: Deferred.Deferred<void>
  readonly releaseKill: Deferred.Deferred<void>
}) =>
  Layer.succeed(
    SandboxClient.Service,
    SandboxClient.Service.of({
      create: () => Effect.never,
      exec: () => Stream.fromIterable([{ type: "exit" as const, exitCode: 0 }]),
      writeFile: () => Effect.never,
      readFile: () => Effect.never,
      hostUrl: (sandboxId, port) => Effect.succeed(`https://${sandboxId}-${port}.fake.rika.local`),
      pause: () =>
        Effect.sync(() => {
          input.events.push("pause-enter")
          input.events.push("pause-exit")
        }),
      resume: () => Effect.never,
      kill: () =>
        Effect.gen(function* () {
          input.events.push("kill-enter")
          yield* Deferred.succeed(input.killEntered, undefined)
          yield* Deferred.await(input.releaseKill)
          input.events.push("kill-exit")
        }),
      setTimeout: () => Effect.never,
      list: () => Effect.never,
      templateExists: () => Effect.never,
    }),
  )

const sandboxCreateFailureLayer = (message: string) => {
  const failure = (operation: string) =>
    new SandboxClient.SandboxClientError({ message, operation, sandboxId: "sandbox_1" })
  return Layer.succeed(
    SandboxClient.Service,
    SandboxClient.Service.of({
      create: () => Effect.fail(failure("create")),
      exec: () => Stream.fail(failure("exec")),
      writeFile: () => Effect.fail(failure("writeFile")),
      readFile: () => Effect.fail(failure("readFile")),
      hostUrl: () => Effect.fail(failure("hostUrl")),
      pause: () => Effect.fail(failure("pause")),
      resume: () => Effect.fail(failure("resume")),
      kill: () => Effect.fail(failure("kill")),
      setTimeout: () => Effect.fail(failure("setTimeout")),
      list: () => Effect.fail(failure("list")),
      templateExists: () => Effect.fail(failure("templateExists")),
    }),
  )
}

const makeSystem = (
  options: { readonly failingHealthChecks?: number } = {},
): OrbManager.System & {
  readonly calls: {
    readonly bundle: Array<{ readonly workspaceRoot: string; readonly path: string }>
    readonly currentBranch: Array<string>
    readonly health: Array<{ readonly url: string; readonly token: string }>
    readonly sleep: Array<number>
  }
} => {
  const calls = {
    bundle: [],
    currentBranch: [],
    health: [],
    sleep: [],
  } as {
    bundle: Array<{ readonly workspaceRoot: string; readonly path: string }>
    currentBranch: Array<string>
    health: Array<{ readonly url: string; readonly token: string }>
    sleep: Array<number>
  }
  return {
    calls,
    makeTempPath: Effect.succeed("/tmp/rika-orb-manager-test.bundle"),
    createGitBundle: (request) =>
      Effect.sync(() => {
        calls.bundle.push(request)
        return new TextEncoder().encode("bundle-bytes")
      }),
    currentBranch: (root) =>
      Effect.sync(() => {
        calls.currentBranch.push(root)
        return "feature/orb"
      }),
    randomToken: Effect.succeed("server-token"),
    health: (url, token) =>
      Effect.gen(function* () {
        calls.health.push({ url, token })
        if (calls.health.length <= (options.failingHealthChecks ?? 0)) {
          return yield* new OrbManager.SystemError({ message: "health down", operation: "health" })
        }
        return yield* Effect.void
      }),
    sleep: (millis) =>
      Effect.sync(() => {
        calls.sleep.push(millis)
      }),
  }
}

const mcpFingerprint = (config: unknown, defaultCwd: string) =>
  createHash("sha256")
    .update(stableJson(mcpFingerprintInput(config, defaultCwd)))
    .digest("hex")

const mcpFingerprintInput = (config: unknown, defaultCwd: string) =>
  isRecord(config) && typeof config.command === "string"
    ? { ...config, cwd: effectiveMcpCwd(config.cwd, defaultCwd) }
    : config

const effectiveMcpCwd = (cwd: unknown, defaultCwd: string) => {
  const value = typeof cwd === "string" ? cwd : defaultCwd
  return isAbsolute(value) ? value : resolve(defaultCwd, value)
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

const expectRecord = (value: unknown, name: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${name} must be an object`)
  return value
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()])
  if (exitCode !== 0) throw new Error(stderr)
}
