import { describe, expect, test } from "bun:test"
import { Common, Ids, Tool } from "@rika/schema"
import { Effect } from "effect"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

    expect(config).toEqual({
      mode: "allow-all",
      guarded_files: [".rika/plugins/**", "*/.rika/plugins/**"],
    })
    expect(PermissionPolicy.summary(config)).toEqual({
      mode: "allow-all",
      guarded_tools_configured: false,
      guarded_files_configured: true,
    })
    expect(result).toEqual(PermissionPolicy.allow)
  })

  test("default config guards plugin directory writes even in allow-all mode", async () => {
    const blocked = await Effect.runPromise(
      PermissionPolicy.decideFromConfig(
        PermissionPolicy.defaultConfig,
        call("write", { path: ".rika/plugins/untrusted.ts", content: "export default function () {}" }),
      ),
    )
    const absoluteBlocked = await Effect.runPromise(
      PermissionPolicy.decideFromConfig(
        PermissionPolicy.defaultConfig,
        call("write", { path: "/workspace/project/.rika/plugins/untrusted.ts", content: "" }),
      ),
    )
    const allowed = await Effect.runPromise(
      PermissionPolicy.decideFromConfig(PermissionPolicy.defaultConfig, call("write", { path: "src/app.ts" })),
    )

    expect(blocked).toMatchObject({
      action: "reject-and-continue",
      message: "File .rika/plugins/untrusted.ts is guarded by permission policy",
      details: {
        permission_mode: "allow-all",
        matched: "file",
        path: ".rika/plugins/untrusted.ts",
        pattern: ".rika/plugins/**",
      },
    })
    expect(absoluteBlocked).toMatchObject({
      action: "reject-and-continue",
      details: {
        path: "/workspace/project/.rika/plugins/untrusted.ts",
        pattern: "*/.rika/plugins/**",
      },
    })
    expect(allowed).toEqual(PermissionPolicy.allow)
  })

  test("default config guards plugin paths reached through symlinked directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-permission-policy-"))
    await mkdir(join(root, ".rika", "plugins"), { recursive: true })
    await symlink(join(root, ".rika", "plugins"), join(root, "plugin-link"), "dir")

    const blocked = await Effect.runPromise(
      PermissionPolicy.decideFromConfig(
        PermissionPolicy.defaultConfig,
        call("write", { destination: "plugin-link/untrusted.ts", content: "" }),
        { workspace_root: root },
      ),
    )

    expect(blocked).toMatchObject({
      action: "reject-and-continue",
      message: "File .rika/plugins/untrusted.ts is guarded by permission policy",
      details: {
        permission_mode: "allow-all",
        matched: "file",
        path: ".rika/plugins/untrusted.ts",
        pattern: ".rika/plugins/**",
      },
    })
  })

  test("default config guards single-component symlink file targets under sink keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-permission-policy-"))
    const pluginPath = join(root, ".rika", "plugins", "untrusted.ts")
    await mkdir(join(root, ".rika", "plugins"), { recursive: true })
    await writeFile(pluginPath, "")
    await symlink(pluginPath, join(root, "plugin-link"))

    const blocked = await Effect.runPromise(
      PermissionPolicy.decideFromConfig(
        PermissionPolicy.defaultConfig,
        call("write", { destination: "plugin-link", content: "" }),
        { workspace_root: root },
      ),
    )

    expect(blocked).toMatchObject({
      action: "reject-and-continue",
      message: "File .rika/plugins/untrusted.ts is guarded by permission policy",
      details: {
        permission_mode: "allow-all",
        matched: "file",
        path: ".rika/plugins/untrusted.ts",
        pattern: ".rika/plugins/**",
      },
    })
  })

  test("configured guarded tools reject through the normal decision type", async () => {
    const config = PermissionPolicy.configFromEnv({ RIKA_GUARDED_TOOLS: "shell.*, write" })

    const blocked = await Effect.runPromise(PermissionPolicy.decideFromConfig(config, call("shell_command")))
    const allowed = await Effect.runPromise(PermissionPolicy.decideFromConfig(config, call("read")))

    expect(config).toEqual({
      mode: "configured",
      guarded_tools: ["shell.*", "write"],
      guarded_files: [".rika/plugins/**", "*/.rika/plugins/**"],
    })
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
