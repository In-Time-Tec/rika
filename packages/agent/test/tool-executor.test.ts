import { describe, expect, test } from "bun:test"
import { Config } from "@rika/core"
import { Common, Ids, Tool } from "@rika/schema"
import { Effect, Layer } from "effect"
import { PermissionPolicy, ToolExecutor, ToolRegistry } from "../src/index"

const call = (name: string, input: Common.JsonValue = {}): Tool.Call => ({
  id: Ids.ToolCallId.make(`tool_call_${name.replaceAll(".", "_")}`),
  name,
  input,
})

const fakeToolLayer = (
  handlers: Readonly<Record<string, ToolRegistry.FakeHandler>>,
  policy: Layer.Layer<PermissionPolicy.Service> = PermissionPolicy.allowLayer,
) => ToolExecutor.layer.pipe(Layer.provideMerge(ToolRegistry.fakeLayer(handlers)), Layer.provideMerge(policy))

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
})

describe("shell_command tool", () => {
  const configLayer = Config.layerFromValues({
    workspace_root: process.cwd(),
    data_dir: `${process.cwd()}/.rika-test`,
    default_mode: "smart",
  })
  const layer = ToolExecutor.shellLayer.pipe(Layer.provideMerge(configLayer))

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
})
