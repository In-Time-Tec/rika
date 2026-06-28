import { describe, expect, test } from "bun:test"
import { Ide, Ids } from "@rika/schema"
import { Effect } from "effect"
import { Args } from "../src/index"

describe("CLI args", () => {
  test("defaults to interactive mode with no prompt", async () => {
    const command = await Effect.runPromise(Args.parse([]))

    expect(command).toEqual({ type: "interactive", ephemeral: false })
  })

  test("parses run commands through Effect CLI definitions", async () => {
    const threadId = Ids.ThreadId.make("thread_args_run")
    const command = await Effect.runPromise(
      Args.parse([
        "run",
        "--mode",
        "rush",
        "--workspace",
        "/workspace/rika",
        "--thread",
        threadId,
        "--ephemeral",
        "ship",
        "it",
      ]),
    )

    expect(command).toEqual({
      type: "execute",
      prompt: "ship it",
      mode: "rush",
      workspace_root: "/workspace/rika",
      thread_id: threadId,
      ephemeral: true,
    })
  })

  test("parses --execute and -e root commands", async () => {
    const long = await Effect.runPromise(Args.parse(["--execute", "--mode", "deep", "explain", "this"]))
    const short = await Effect.runPromise(Args.parse(["-e", "hello"]))

    expect(long).toMatchObject({ type: "execute", prompt: "explain this", mode: "deep", ephemeral: false })
    expect(short).toMatchObject({ type: "execute", prompt: "hello", ephemeral: false })
  })

  test("parses explicit interactive commands", async () => {
    const threadId = Ids.ThreadId.make("thread_args_interactive")
    const command = await Effect.runPromise(
      Args.parse(["interactive", "--mode", "rush", "--workspace", "/workspace/rika", "--thread", threadId]),
    )

    expect(command).toEqual({
      type: "interactive",
      mode: "rush",
      workspace_root: "/workspace/rika",
      thread_id: threadId,
      ephemeral: false,
    })
  })

  test("parses thread management commands", async () => {
    const threadId = Ids.ThreadId.make("thread_args_threads")
    const list = await Effect.runPromise(Args.parse(["threads", "list", "--include-archived", "--limit", "5"]))
    const search = await Effect.runPromise(Args.parse(["threads", "search", "auth", "race", "--limit", "3"]))
    const archive = await Effect.runPromise(Args.parse(["threads", "archive", threadId]))
    const reference = await Effect.runPromise(Args.parse(["threads", "reference", threadId, "auth", "race"]))

    expect(list).toEqual({ type: "threads", action: "list", include_archived: true, limit: 5 })
    expect(search).toEqual({ type: "threads", action: "search", query: "auth race", limit: 3 })
    expect(archive).toEqual({ type: "threads", action: "archive", thread_id: threadId })
    expect(reference).toEqual({ type: "threads", action: "reference", thread_id: threadId, query: "auth race" })
  })

  test("parses skill management commands", async () => {
    const list = await Effect.runPromise(Args.parse(["skills", "list"]))
    const inspect = await Effect.runPromise(Args.parse(["skills", "inspect", "deploy"]))

    expect(list).toEqual({ type: "skills", action: "list" })
    expect(inspect).toEqual({ type: "skills", action: "inspect", name: "deploy" })
  })

  test("parses MCP management commands", async () => {
    const list = await Effect.runPromise(Args.parse(["mcp", "list"]))
    const approve = await Effect.runPromise(Args.parse(["mcp", "approve", "filesystem"]))

    expect(list).toEqual({ type: "mcp", action: "list" })
    expect(approve).toEqual({ type: "mcp", action: "approve", server_name: "filesystem" })
  })

  test("parses review commands", async () => {
    const command = await Effect.runPromise(
      Args.parse(["review", "--staged", "--base", "main", "--workspace", "/workspace/rika", "src/app.ts"]),
    )

    expect(command).toEqual({
      type: "review",
      staged: true,
      base_ref: "main",
      workspace_root: "/workspace/rika",
      paths: ["src/app.ts"],
      ephemeral: false,
    })
  })

  test("parses extension management commands", async () => {
    const threadId = Ids.ThreadId.make("thread_args_extensions")
    const createSkill = await Effect.runPromise(
      Args.parse([
        "extensions",
        "create-skill",
        "deploy-helper",
        "--description",
        "Deploy safely",
        "--instructions",
        "Run checks",
        "--thread",
        threadId,
      ]),
    )
    const createPlugin = await Effect.runPromise(
      Args.parse(["extensions", "create-plugin", "notify", "--description", "Notify user"]),
    )
    const enablePlugin = await Effect.runPromise(
      Args.parse(["extensions", "enable-plugin", "notify", "--verification", "bun test", "--thread", threadId]),
    )
    const rollbackPlugin = await Effect.runPromise(
      Args.parse(["extensions", "rollback-plugin", "notify", "--reason", "startup failed"]),
    )

    expect(createSkill).toEqual({
      type: "extensions",
      action: "create-skill",
      name: "deploy-helper",
      description: "Deploy safely",
      instructions: "Run checks",
      thread_id: threadId,
    })
    expect(createPlugin).toEqual({
      type: "extensions",
      action: "create-plugin",
      name: "notify",
      description: "Notify user",
    })
    expect(enablePlugin).toEqual({
      type: "extensions",
      action: "enable-plugin",
      name: "notify",
      verification_command: "bun test",
      thread_id: threadId,
    })
    expect(rollbackPlugin).toEqual({
      type: "extensions",
      action: "rollback-plugin",
      name: "notify",
      reason: "startup failed",
    })
  })

  test("parses server commands", async () => {
    const command = await Effect.runPromise(
      Args.parse([
        "server",
        "--host",
        "127.0.0.1",
        "--port",
        "4587",
        "--token",
        "secret",
        "--workspace",
        "/workspace/rika",
        "--ephemeral",
      ]),
    )

    expect(command).toEqual({
      type: "server",
      host: "127.0.0.1",
      port: 4587,
      token: "secret",
      workspace_root: "/workspace/rika",
      ephemeral: true,
    })
  })

  test("parses IDE integration commands", async () => {
    const clientId = Ids.IdeClientId.make("ide_args_client")
    const connect = await Effect.runPromise(
      Args.parse([
        "ide",
        "connect",
        "--client",
        clientId,
        "--name",
        "Mock IDE",
        "--workspace",
        "/workspace/rika",
        "--capabilities",
        "active-context,navigation",
        "--active-file",
        "packages/cli/src/runtime.ts",
        "--start-line",
        "10",
        "--end-line",
        "12",
        "--selected-text",
        "const mode = 'smart'",
        "--server",
        "http://127.0.0.1:4587",
        "--token",
        "secret",
      ]),
    )
    const status = await Effect.runPromise(Args.parse(["ide", "status", "--server", "http://127.0.0.1:4587"]))
    const disconnect = await Effect.runPromise(Args.parse(["ide", "disconnect", "--client", clientId]))
    const openFile = await Effect.runPromise(
      Args.parse([
        "ide",
        "open-file",
        "--path",
        "packages/cli/src/runtime.ts",
        "--start-line",
        "10",
        "--end-line",
        "12",
      ]),
    )

    const initialContext: Ide.ContextSnapshot = {
      workspace_roots: ["/workspace/rika"],
      active_file: {
        path: "packages/cli/src/runtime.ts",
        selection: { range: { start_line: 10, end_line: 12 }, selected_text: "const mode = 'smart'" },
      },
    }
    expect(connect).toEqual({
      type: "ide",
      action: "connect",
      client_id: clientId,
      name: "Mock IDE",
      workspace_roots: ["/workspace/rika"],
      capabilities: ["active-context", "navigation"],
      initial_context: initialContext,
      server_url: "http://127.0.0.1:4587",
      token: "secret",
    })
    expect(status).toEqual({ type: "ide", action: "status", server_url: "http://127.0.0.1:4587" })
    expect(disconnect).toEqual({ type: "ide", action: "disconnect", client_id: clientId })
    expect(openFile).toEqual({
      type: "ide",
      action: "open-file",
      open_file: {
        path: "packages/cli/src/runtime.ts",
        range: { start_line: 10, end_line: 12 },
      },
    })
  })

  test("rejects root prompt text unless --execute is set", async () => {
    const error = await Effect.runPromise(Args.parse(["hello"]).pipe(Effect.flip))

    expect(error.exit_code).toBe(2)
    expect(error.message).toContain("Expected run, interactive, or --execute")
  })

  test("returns Effect CLI diagnostics for invalid flags", async () => {
    const error = await Effect.runPromise(Args.parse(["run", "--bogus"]).pipe(Effect.flip))

    expect(error.exit_code).toBe(2)
    expect(error.message).toContain("USAGE")
    expect(error.message).toContain("Unrecognized flag: --bogus")
  })

  test("returns Effect CLI diagnostics for missing flag values", async () => {
    const error = await Effect.runPromise(Args.parse(["run", "--mode"]).pipe(Effect.flip))

    expect(error.exit_code).toBe(2)
    expect(error.message).toContain("USAGE")
    expect(error.message).toContain("Invalid value")
  })
})
