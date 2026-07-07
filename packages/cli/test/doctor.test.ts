import { describe, expect, test } from "bun:test"
import { Config, IdGenerator, Time } from "@rika/core"
import { SandboxClientFake } from "@rika/orb"
import { Database, Migration, OrbStore } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Effect, Layer, Schema } from "effect"
import { BackendEndpoint, Doctor, LocalBackend, Output } from "../src/index"

const now = Common.TimestampMillis.make(2_040_000_000_000)
const workspaceRoot = "/workspace/rika"
const projectId = Ids.ProjectId.make("project_doctor")

describe("CLI doctor command", () => {
  test("prints local diagnostics without leaking secrets", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const layer = doctorLayer({
      output,
      input: {
        cwd: workspaceRoot,
        version: "test-version",
        env: {
          CI: "true",
          RIKA_WORKSPACE_ROOT: workspaceRoot,
          RIKA_DATA_DIR: "/workspace/rika/.rika-test",
          RIKA_API_KEY: "model-secret",
          RIKA_BASE_URL: "http://127.0.0.1:8317/v1",
          RIKA_EMBEDDINGS_API_KEY: "embeddings-secret",
          RIKA_GUARDED_TOOLS: "shell_command",
          RIKA_RIVET_HOST: "remote",
          RIKA_RIVET_ENDPOINT: "https://rivet.example.com",
          RIKA_RIVET_TOKEN: "rivet-secret",
          RIKA_RIVET_NAMESPACE: "team",
        },
      },
    })

    const exitCode = await Effect.runPromise(Doctor.executeCommand({ type: "doctor" }).pipe(Effect.provide(layer)))

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    expect(output.stdout.join("\n")).not.toContain("model-secret")
    expect(output.stdout.join("\n")).not.toContain("embeddings-secret")
    expect(output.stdout.join("\n")).not.toContain("rivet-secret")
    const parsed = Schema.decodeUnknownSync(Doctor.Report)(JSON.parse(output.stdout[0] ?? "{}"))
    expect(parsed).toMatchObject({
      version: "test-version",
      environment: { cwd: workspaceRoot, ci: true },
      config: {
        workspace_root: workspaceRoot,
        data_dir: "/workspace/rika/.rika-test",
        api_key_configured: true,
        embeddings_api_key_configured: true,
        telemetry: "enabled",
        telemetry_endpoint: "http://127.0.0.1:27686",
      },
      backend: {
        status: "disconnected",
      },
      permission: {
        mode: "configured",
        guarded_tools_configured: true,
        guarded_files_configured: true,
      },
      rivet: {
        host: "remote",
        endpoint: "https://rivet.example.com",
        token_configured: true,
        namespace_configured: true,
      },
    })
    expect(parsed.checks.map((check) => check.name)).toEqual([
      "data-dir",
      "model-provider",
      "model-proxy",
      "embeddings-provider",
      "permissions",
      "rivet",
      "telemetry",
      "e2b-api-key",
      "orb-template",
      "orb-store",
      "orb-orphans",
    ])
  })

  test("warns when live model credentials are configured without the proxy base URL", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const layer = doctorLayer({
      output,
      input: {
        cwd: workspaceRoot,
        version: "test-version",
        env: {
          RIKA_API_KEY: "model-secret",
        },
      },
    })

    const exitCode = await Effect.runPromise(Doctor.executeCommand({ type: "doctor" }).pipe(Effect.provide(layer)))

    expect(exitCode).toBe(0)
    const parsed = Schema.decodeUnknownSync(Doctor.Report)(JSON.parse(output.stdout[0] ?? "{}"))
    const modelProxy = parsed.checks.find((check) => check.name === "model-proxy")

    expect(parsed.config.api_key_configured).toBe(true)
    expect(parsed.config.base_url_configured).toBe(false)
    expect(modelProxy).toMatchObject({
      status: "warning",
      message: "RIKA_BASE_URL is required when live model calls are enabled.",
    })
  })

  test("warns when model provider credentials are missing", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const layer = doctorLayer({
      output,
      input: {
        cwd: workspaceRoot,
        version: "test-version",
        env: {},
      },
    })

    const exitCode = await Effect.runPromise(Doctor.executeCommand({ type: "doctor" }).pipe(Effect.provide(layer)))

    expect(exitCode).toBe(0)
    const parsed = Schema.decodeUnknownSync(Doctor.Report)(JSON.parse(output.stdout[0] ?? "{}"))
    const modelProvider = parsed.checks.find((check) => check.name === "model-provider")
    const modelProxy = parsed.checks.find((check) => check.name === "model-proxy")
    const embeddingsProvider = parsed.checks.find((check) => check.name === "embeddings-provider")

    expect(parsed.config.api_key_configured).toBe(false)
    expect(parsed.config.embeddings_api_key_configured).toBe(false)
    expect(modelProvider).toMatchObject({
      status: "warning",
      message: "RIKA_API_KEY is required for live model calls.",
    })
    expect(modelProxy).toMatchObject({
      status: "skipped",
      message: "Model proxy check skipped because RIKA_API_KEY is unset.",
    })
    expect(embeddingsProvider).toMatchObject({
      status: "warning",
      message: "RIKA_EMBEDDINGS_API_KEY is required for live thread memory indexing.",
    })
  })

  test("reports stale running orbs and orphan sandboxes without leaking endpoint tokens", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const sandbox = SandboxClientFake.makeState()
    sandbox.sandboxes.set("sandbox_stale", {
      sandboxId: "sandbox_stale",
      templateId: "rika-orb",
      metadata: {
        app: "rika",
        thread_id: "thread_doctor_stale",
        project_id: projectId,
      },
      state: "running",
    })
    sandbox.sandboxes.set("sandbox_orphan", {
      sandboxId: "sandbox_orphan",
      templateId: "rika-orb",
      metadata: {
        app: "rika",
        thread_id: "thread_doctor_orphan",
        project_id: projectId,
      },
      state: "running",
    })
    const layer = doctorLayer({
      output,
      sandbox,
      input: {
        cwd: workspaceRoot,
        version: "test-version",
        env: {
          E2B_API_KEY: "e2b-secret",
        },
      },
      health: (url, token) =>
        url === "https://stale.rika.test" && token === "orb-secret"
          ? Effect.fail(
              new BackendEndpoint.BackendEndpointError({
                message: "orb health failed",
                operation: "health",
              }),
            )
          : Effect.succeed({
              status: "healthy",
              url,
              workspace_root: workspaceRoot,
              data_dir: `${workspaceRoot}/.rika`,
              backend_id: "doctor-test",
              version: "test-version",
            }),
    })

    const parsed = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const orb = yield* OrbStore.create({
          thread_id: Ids.ThreadId.make("thread_doctor_stale"),
          project_id: projectId,
          sandbox_id: "sandbox_stale",
          endpoint_url: "https://stale.rika.test",
          token: "orb-secret",
        })
        yield* OrbStore.setStatus(orb.orb_id, "running")
        return yield* Doctor.report()
      }).pipe(Effect.provide(layer)),
    )

    const encoded = JSON.stringify(parsed)
    const orbStore = parsed.checks.find((check) => check.name === "orb-store")
    const orphan = parsed.checks.find((check) => check.name === "orb-orphans")
    expect(encoded).not.toContain("orb-secret")
    expect(encoded).not.toContain("e2b-secret")
    expect(orbStore).toMatchObject({
      status: "warning",
    })
    expect(orbStore?.message).toContain("thread_doctor_stale")
    expect(orbStore?.message).toContain("rika orb kill thread_doctor_stale")
    expect(orphan).toMatchObject({
      status: "warning",
    })
    expect(orphan?.message).toContain("sandbox_orphan")
    expect(orphan?.message).toContain("thread_doctor_orphan")
  })
})

const doctorLayer = (input: {
  readonly output: Output.MemoryOutput
  readonly input: Doctor.Input
  readonly sandbox?: SandboxClientFake.State
  readonly health?: BackendEndpoint.HealthInterface["health"]
}) => {
  const dataDir = input.input.env.RIKA_DATA_DIR ?? `${input.input.cwd}/.rika`
  const configLayer = Config.layerFromValues(
    {
      workspace_root: input.input.env.RIKA_WORKSPACE_ROOT ?? input.input.cwd,
      data_dir: dataDir,
      default_mode: "smart",
    },
    input.input.env,
  )
  const databaseLayer = Database.memoryLayer
  const timeLayer = Time.fixedLayer(now)
  const idLayer = IdGenerator.sequenceLayer(1)
  const orbStoreLayer = OrbStore.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const sandboxLayer = SandboxClientFake.layer(input.sandbox ?? SandboxClientFake.makeState())
  const healthLayer = Layer.succeed(
    BackendEndpoint.Health,
    BackendEndpoint.Health.of({
      health:
        input.health ??
        ((url) =>
          Effect.succeed({
            status: "healthy",
            url,
            workspace_root: input.input.cwd,
            data_dir: dataDir,
            backend_id: "doctor-test",
            version: input.input.version ?? "0.0.0",
          })),
    }),
  )
  return Doctor.layerFromInput(input.input).pipe(
    Layer.provideMerge(Output.memoryLayer(input.output)),
    Layer.provideMerge(LocalBackend.layerFromInput({ env: {}, cwd: input.input.cwd })),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(Migration.layer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
    Layer.provideMerge(orbStoreLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(healthLayer),
  )
}
