import { PermissionPolicy } from "@rika/agent"
import type { PluginEntrypoint } from "./api"

export const commandAndToolPlugin: PluginEntrypoint = (rika) => {
  rika.registerTool(
    "example.echo",
    {
      description: "Echo a JSON input value from an example plugin.",
      inputSchema: { type: "object" },
    },
    (call) => ({ plugin: "example", input: call.input }),
  )

  rika.registerCommand(
    "example-notify",
    { title: "Example notify", category: "examples", description: "Send a plugin UI notification." },
    async (ctx) => {
      await ctx.ui.notify("Example plugin command ran")
    },
  )
}

export const permissionHookPlugin: PluginEntrypoint = (rika) => {
  rika.on("tool.call", (event) => {
    if (event.tool === "shell_command") return PermissionPolicy.reject("example plugin blocked shell_command")
    return undefined
  })
}

export const uiPlugin: PluginEntrypoint = (rika) => {
  rika.registerCommand("example-confirm", { title: "Example confirm", category: "examples" }, async (ctx) => {
    const confirmed = await ctx.ui.confirm({ title: "Continue?", message: "Example plugin confirmation" })
    await ctx.ui.notify(confirmed ? "Confirmed" : "Cancelled")
  })
}
