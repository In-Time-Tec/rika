import { describe, expect, test } from "bun:test"
import { Common, Ids, Tool } from "@rika/schema"
import { Effect } from "effect"
import { PermissionPolicy } from "../src/index"

const call = (name: string, input: Common.JsonValue = {}): Tool.Call => ({
  id: Ids.ToolCallId.make(`tool_call_${name.replaceAll(".", "_")}`),
  name,
  input,
})

describe("PermissionPolicy", () => {
  test("defaults to allow-all with no approval prompts", async () => {
    const config = PermissionPolicy.configFromEnv({})

    const result = await Effect.runPromise(PermissionPolicy.decideFromConfig(config, call("shell_command")))

    expect(config).toEqual({ mode: "allow-all" })
    expect(PermissionPolicy.summary(config)).toEqual({
      mode: "allow-all",
      guarded_tools_configured: false,
      guarded_files_configured: false,
    })
    expect(result).toEqual(PermissionPolicy.allow)
  })

  test("configured guarded tools reject through the normal decision type", async () => {
    const config = PermissionPolicy.configFromEnv({ RIKA_GUARDED_TOOLS: "shell.*, write" })

    const blocked = await Effect.runPromise(PermissionPolicy.decideFromConfig(config, call("shell_command")))
    const allowed = await Effect.runPromise(PermissionPolicy.decideFromConfig(config, call("read")))

    expect(config).toEqual({ mode: "configured", guarded_tools: ["shell.*", "write"] })
    expect(blocked).toMatchObject({
      action: "reject-and-continue",
      message: "Tool shell_command is guarded by permission policy",
      details: { permission_mode: "configured", matched: "tool", tool: "shell_command", pattern: "shell.*" },
    })
    expect(allowed).toEqual(PermissionPolicy.allow)
  })

  test("configured guarded files reject without inspecting full tool inputs", async () => {
    const config = PermissionPolicy.configFromEnv({ RIKA_GUARDED_FILES: "secrets/*" })

    const blocked = await Effect.runPromise(
      PermissionPolicy.decideFromConfig(config, call("write", { path: "secrets/token.txt", content: "super-secret" })),
    )

    expect(blocked).toMatchObject({
      action: "reject-and-continue",
      message: "File secrets/token.txt is guarded by permission policy",
      details: { permission_mode: "configured", matched: "file", path: "secrets/token.txt", pattern: "secrets/*" },
    })
    expect(JSON.stringify(blocked)).not.toContain("super-secret")
  })

  test("layerFromConfig exposes the active permission mode", async () => {
    const mode = await Effect.runPromise(
      PermissionPolicy.mode().pipe(
        Effect.provide(PermissionPolicy.layerFromConfig({ mode: "configured", guarded_tools: ["shell_command"] })),
      ),
    )

    expect(mode).toBe("configured")
  })
})
