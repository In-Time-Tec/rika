import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Doctor, LocalBackend, Output } from "../src/index"

describe("CLI doctor command", () => {
  test("prints local diagnostics without leaking secrets", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const layer = Doctor.layerFromInput({
      cwd: "/workspace/rika",
      version: "test-version",
      env: {
        CI: "true",
        RIKA_WORKSPACE_ROOT: "/workspace/rika",
        RIKA_DATA_DIR: "/workspace/rika/.rika-test",
        RIKA_API_KEY: "model-secret",
        RIKA_GUARDED_TOOLS: "shell_command",
        RIKA_RIVET_HOST: "remote",
        RIKA_RIVET_ENDPOINT: "https://rivet.example.com",
        RIKA_RIVET_TOKEN: "rivet-secret",
        RIKA_RIVET_NAMESPACE: "team",
      },
    })
      .pipe(Layer.provideMerge(Output.memoryLayer(output)))
      .pipe(Layer.provideMerge(LocalBackend.layerFromInput({ env: {}, cwd: "/workspace/rika" })))

    const exitCode = await Effect.runPromise(Doctor.executeCommand({ type: "doctor" }).pipe(Effect.provide(layer)))

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    expect(output.stdout.join("\n")).not.toContain("model-secret")
    expect(output.stdout.join("\n")).not.toContain("rivet-secret")
    const parsed = Schema.decodeUnknownSync(Doctor.Report)(JSON.parse(output.stdout[0] ?? "{}"))
    expect(parsed).toMatchObject({
      version: "test-version",
      environment: { cwd: "/workspace/rika", ci: true },
      config: {
        workspace_root: "/workspace/rika",
        data_dir: "/workspace/rika/.rika-test",
        api_key_configured: true,
        telemetry: "disabled",
      },
      backend: {
        status: "disconnected",
      },
      permission: {
        mode: "configured",
        guarded_tools_configured: true,
        guarded_files_configured: false,
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
      "permissions",
      "rivet",
      "telemetry",
    ])
  })

  test("warns when model provider credentials are missing", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const layer = Doctor.layerFromInput({
      cwd: "/workspace/rika",
      version: "test-version",
      env: {},
    })
      .pipe(Layer.provideMerge(Output.memoryLayer(output)))
      .pipe(Layer.provideMerge(LocalBackend.layerFromInput({ env: {}, cwd: "/workspace/rika" })))

    const exitCode = await Effect.runPromise(Doctor.executeCommand({ type: "doctor" }).pipe(Effect.provide(layer)))

    expect(exitCode).toBe(0)
    const parsed = Schema.decodeUnknownSync(Doctor.Report)(JSON.parse(output.stdout[0] ?? "{}"))
    const modelProvider = parsed.checks.find((check) => check.name === "model-provider")

    expect(parsed.config.api_key_configured).toBe(false)
    expect(modelProvider).toMatchObject({
      status: "warning",
      message: "RIKA_API_KEY is required for live model calls.",
    })
  })
})
