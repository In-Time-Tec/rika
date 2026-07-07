import { describe, expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, Diagnostics, SecretRedactor } from "@rika/core"
import { Common, Ids, Tool } from "@rika/schema"
import { Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Tool as AiTool } from "effect/unstable/ai"
import { PermissionPolicy, ToolExecutor, ToolRegistry } from "../src/index"

const call = (name: string, input: Common.JsonValue = {}): Tool.Call => ({
  id: Ids.ToolCallId.make(`tool_call_${name.replaceAll(".", "_")}`),
  name,
  input,
})

const readOnlyCall = (name: string, input: Common.JsonValue = {}): Tool.Call => ({
  ...call(name, input),
  metadata: { tool_access: "read-only" },
})

const fakeToolLayer = (
  handlers: Readonly<Record<string, ToolRegistry.FakeHandler>>,
  policy: Layer.Layer<PermissionPolicy.Service> = PermissionPolicy.allowLayer,
  diagnostics: Array<Diagnostics.Entry> = [],
) => {
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer(diagnostics).pipe(Layer.provideMerge(redactorLayer))
  return ToolExecutor.layer.pipe(
    Layer.provideMerge(ToolRegistry.fakeLayer(handlers)),
    Layer.provideMerge(policy),
    Layer.provideMerge(diagnosticsLayer),
  )
}

describe("ToolExecutor", () => {
  test("runs allowed tools through the registry", async () => {
    const result = await Effect.runPromise(
      ToolExecutor.execute(call("fake_echo", { text: "hello" })).pipe(
        Effect.provide(fakeToolLayer({ fake_echo: (toolCall) => Effect.succeed({ echoed: toolCall.input }) })),
      ),
    )

    expect(result).toMatchObject({
      name: "fake_echo",
      status: "success",
      output: { echoed: { text: "hello" } },
      metadata: { permission_mode: "allow-all", permission_action: "allow" },
    })
  })

  test("emits a tool execution wide event through Diagnostics", async () => {
    const diagnostics: Array<Diagnostics.Entry> = []
    const result = await Effect.runPromise(
      ToolExecutor.execute(call("fake_echo", { text: "hello" })).pipe(
        Effect.provide(
          fakeToolLayer(
            { fake_echo: (toolCall) => Effect.succeed({ echoed: toolCall.input }) },
            PermissionPolicy.allowLayer,
            diagnostics,
          ),
        ),
      ),
    )

    expect(result.status).toBe("success")
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      level: "info",
      message: "tool.exec success",
      data: {
        op: "tool.exec",
        outcome: "success",
        tool_name: "fake_echo",
        tool_call_id: "tool_call_fake_echo",
        permission_mode: "allow-all",
        permission_action: "allow",
        status: "success",
      },
    })
  })

  test("asks PermissionPolicy before the registry executes each tool call", async () => {
    const order: Array<string> = []
    const result = await Effect.runPromise(
      ToolExecutor.execute(call("fake_ordered")).pipe(
        Effect.provide(
          fakeToolLayer(
            {
              fake_ordered: () =>
                Effect.sync(() => {
                  order.push("registry")
                  return { ok: true }
                }),
            },
            PermissionPolicy.layerFromDecider(() =>
              Effect.sync(() => {
                order.push("policy")
                return PermissionPolicy.allow
              }),
            ),
          ),
        ),
      ),
    )

    expect(order).toEqual(["policy", "registry"])
    expect(result).toMatchObject({ status: "success", output: { ok: true } })
  })

  test("reject-and-continue blocks registry execution", async () => {
    let executed = false
    const result = await Effect.runPromise(
      ToolExecutor.execute(call("fake_blocked")).pipe(
        Effect.provide(
          fakeToolLayer(
            {
              fake_blocked: () =>
                Effect.sync(() => {
                  executed = true
                  return { should_not: "run" }
                }),
            },
            PermissionPolicy.rejectLayer("blocked by policy"),
          ),
        ),
      ),
    )

    expect(executed).toBe(false)
    expect(result).toMatchObject({
      name: "fake_blocked",
      status: "error",
      error: { kind: "permission", message: "blocked by policy", code: "fake_blocked" },
      metadata: { permission_mode: "configured", permission_action: "reject-and-continue" },
    })
  })

  test("read-only turn metadata rejects non-read-only tools before registry execution", async () => {
    let executed = false
    const result = await Effect.runPromise(
      ToolExecutor.execute(readOnlyCall("shell_command", { command: "printf nope" })).pipe(
        Effect.provide(
          fakeToolLayer({
            shell_command: () =>
              Effect.sync(() => {
                executed = true
                return { should_not: "run" }
              }),
          }),
        ),
      ),
    )

    expect(executed).toBe(false)
    expect(result).toMatchObject({
      name: "shell_command",
      status: "error",
      error: {
        kind: "permission",
        code: "shell_command",
        message: "Tool shell_command is not available during read-only turns",
      },
      metadata: { permission_action: "reject-and-continue", tool_access: "read-only" },
    })
  })

  test("read-only turn metadata allows read-only tools", async () => {
    const result = await Effect.runPromise(
      ToolExecutor.execute(readOnlyCall("read", { path: "AGENTS.md" })).pipe(
        Effect.provide(
          fakeToolLayer({
            read: (toolCall) => Effect.succeed({ content: "ok", input: toolCall.input }),
          }),
        ),
      ),
    )

    expect(result).toMatchObject({
      name: "read",
      status: "success",
      output: { content: "ok", input: { path: "AGENTS.md" } },
      metadata: { permission_mode: "allow-all", permission_action: "allow", tool_access: "read-only" },
    })
  })

  test("modify changes the input before registry execution", async () => {
    const result = await Effect.runPromise(
      ToolExecutor.execute(call("fake_modify", { original: true })).pipe(
        Effect.provide(
          fakeToolLayer(
            {
              fake_modify: (toolCall) =>
                Effect.succeed({
                  input: toolCall.input,
                  ...(toolCall.metadata === undefined ? {} : { metadata: toolCall.metadata }),
                }),
            },
            PermissionPolicy.layerFromDecider(() => Effect.succeed(PermissionPolicy.modify({ modified: true }))),
          ),
        ),
      ),
    )

    expect(result).toMatchObject({
      status: "success",
      output: { input: { modified: true }, metadata: { permission_action: "modify" } },
      metadata: { permission_mode: "configured", permission_action: "modify" },
    })
  })

  test("synthesize returns a policy result without registry execution", async () => {
    let executed = false
    const toolCall = call("fake_synth")
    const result = await Effect.runPromise(
      ToolExecutor.execute(toolCall).pipe(
        Effect.provide(
          fakeToolLayer(
            {
              fake_synth: () =>
                Effect.sync(() => {
                  executed = true
                  return { should_not: "run" }
                }),
            },
            PermissionPolicy.layerFromDecider(() =>
              Effect.succeed(
                PermissionPolicy.synthesize({
                  id: Ids.ToolCallId.make("tool_call_other"),
                  name: "other",
                  status: "success",
                  output: { synthesized: true },
                }),
              ),
            ),
          ),
        ),
      ),
    )

    expect(executed).toBe(false)
    expect(result).toEqual({
      id: toolCall.id,
      name: toolCall.name,
      status: "success",
      output: { synthesized: true },
      metadata: { permission_mode: "configured", permission_action: "synthesize" },
    })
  })

  test("per-turn definitions cannot shadow base registry tools", async () => {
    let baseExecuted = false
    let extraExecuted = false
    const extra: ToolRegistry.Definition = {
      tool: AiTool.make("fake_echo", {
        description: "Extra echo",
        parameters: Schema.Record(Schema.String, Schema.Json),
        success: Schema.Json,
        failure: Schema.Json,
        failureMode: "return",
      }),
      execute: () =>
        Effect.sync(() => {
          extraExecuted = true
          return { source: "extra" }
        }),
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* ToolExecutor.Service
        const descriptors = yield* executor.describeWithDefinitions([extra])
        const executed = yield* executor.executeWithDefinitions(call("fake_echo"), [extra])
        return { descriptors, executed }
      }).pipe(
        Effect.provide(
          fakeToolLayer({
            fake_echo: () =>
              Effect.sync(() => {
                baseExecuted = true
                return { source: "base" }
              }),
          }),
        ),
      ),
    )

    expect(result.descriptors.filter((descriptor) => descriptor.name === "fake_echo")).toHaveLength(1)
    expect(result.executed).toMatchObject({ status: "success", output: { source: "base" } })
    expect(baseExecuted).toBe(true)
    expect(extraExecuted).toBe(false)
  })
})

describe("shell_command tool", () => {
  const configLayer = Config.layerFromValues({
    workspace_root: process.cwd(),
    data_dir: `${process.cwd()}/.rika-test`,
    default_mode: "smart",
  })
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const layer = ToolExecutor.shellLayer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(diagnosticsLayer))

  test("returns capped stdout for successful commands", async () => {
    const result = await Effect.runPromise(
      ToolExecutor.execute(call("shell_command", { command: "printf hello", max_output_bytes: 3 })).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result).toMatchObject({
      name: "shell_command",
      status: "success",
      output: { exit_code: 0, stdout: "hel", stdout_truncated: true, timed_out: false },
    })
  })

  test("returns structured errors for non-zero exits", async () => {
    const result = await Effect.runPromise(
      ToolExecutor.execute(call("shell_command", { command: "echo nope >&2; exit 7" })).pipe(Effect.provide(layer)),
    )

    expect(result).toMatchObject({
      name: "shell_command",
      status: "error",
      error: { kind: "tool", code: "shell_command", details: { exit_code: 7, stderr: "nope\n" } },
    })
  })

  test("returns structured timeout errors", async () => {
    const result = await Effect.runPromise(
      ToolExecutor.execute(call("shell_command", { command: "sleep 1", timeout_ms: 10 })).pipe(Effect.provide(layer)),
    )

    expect(result).toMatchObject({
      name: "shell_command",
      status: "error",
      error: { kind: "tool", code: "shell_command", retryable: true, details: { timed_out: true } },
    })
  })

  test("timeout uses Clock and kills the shell process", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-shell-timeout-"))
    const pidPath = join(root, "child.pid")
    const markerPath = join(root, "late.marker")
    let pid: number | undefined

    try {
      const command = bunEval([
        `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid))`,
        "await Bun.sleep(200)",
        `await Bun.write(${JSON.stringify(markerPath)}, "late")`,
      ])

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* ToolExecutor.execute(
              call("shell_command", { command, timeout_ms: 1000, max_output_bytes: 1000 }),
            ).pipe(Effect.forkScoped({ startImmediately: true }))
            pid = Number(yield* Effect.promise(() => waitForText(pidPath)))
            yield* TestClock.adjust("1 second")
            return yield* Fiber.join(fiber)
          }),
        ).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
      )

      await Bun.sleep(250)

      expect(result).toMatchObject({
        name: "shell_command",
        status: "error",
        error: { kind: "tool", code: "shell_command", retryable: true, details: { timed_out: true } },
      })
      expect(await pathExists(markerPath)).toBe(false)
      expect(processAlive(pid)).toBe(false)
    } finally {
      killProcess(pid)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("timeout gives a SIGTERM grace window before SIGKILL", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-shell-grace-"))
    const pidPath = join(root, "child.pid")
    const termPath = join(root, "term.marker")
    let pid: number | undefined

    try {
      const command = bunEval([
        `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid))`,
        `process.on("SIGTERM", () => { void Bun.write(${JSON.stringify(termPath)}, "term") })`,
        "await Bun.sleep(30000)",
      ])

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* ToolExecutor.execute(
              call("shell_command", { command, timeout_ms: 1000, max_output_bytes: 1000 }),
            ).pipe(Effect.forkScoped({ startImmediately: true }))
            pid = Number(yield* Effect.promise(() => waitForText(pidPath)))
            yield* TestClock.adjust("1 second")
            yield* Effect.promise(() => waitForText(termPath))
            const aliveDuringGrace = processAlive(pid)
            yield* TestClock.adjust("999 millis")
            const aliveBeforeKill = processAlive(pid)
            yield* TestClock.adjust("1 millis")
            const output = yield* Fiber.join(fiber)
            return { aliveBeforeKill, aliveDuringGrace, output }
          }),
        ).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
      )

      await Bun.sleep(250)

      expect(result.output).toMatchObject({
        name: "shell_command",
        status: "error",
        error: { kind: "tool", code: "shell_command", retryable: true, details: { timed_out: true } },
      })
      expect(result.aliveDuringGrace).toBe(true)
      expect(result.aliveBeforeKill).toBe(true)
      expect(processAlive(pid)).toBe(false)
    } finally {
      killProcess(pid)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("interrupting shell execution kills the shell process", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-shell-interrupt-"))
    const pidPath = join(root, "child.pid")
    const markerPath = join(root, "late.marker")
    let pid: number | undefined

    try {
      const command = bunEval([
        `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid))`,
        "await Bun.sleep(200)",
        `await Bun.write(${JSON.stringify(markerPath)}, "late")`,
      ])
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* ToolExecutor.execute(call("shell_command", { command, timeout_ms: 5000 })).pipe(
              Effect.forkScoped({ startImmediately: true }),
            )
            pid = Number(yield* Effect.promise(() => waitForText(pidPath)))
            yield* Fiber.interrupt(fiber)
          }),
        ).pipe(Effect.provide(layer)),
      )
      await Bun.sleep(250)

      expect(await pathExists(markerPath)).toBe(false)
      expect(processAlive(pid)).toBe(false)
    } finally {
      killProcess(pid)
      await rm(root, { recursive: true, force: true })
    }
  })
})

const bunEval = (lines: ReadonlyArray<string>) => `bun -e ${JSON.stringify(lines.join(";"))}`

const waitForText = async (path: string) => {
  const deadline = Date.now() + 1_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8")
    } catch (error) {
      lastError = error
      await Bun.sleep(10)
    }
  }
  throw lastError
}

const pathExists = async (path: string) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const processAlive = (pid: number | undefined) => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const killProcess = (pid: number | undefined) => {
  if (pid === undefined) return
  try {
    process.kill(pid, "SIGKILL")
  } catch {}
}
