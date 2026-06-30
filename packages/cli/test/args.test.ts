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

  test("parses --execute and -x root commands", async () => {
    const long = await Effect.runPromise(Args.parse(["--execute", "--mode", "deep3", "explain", "this"]))
    const short = await Effect.runPromise(Args.parse(["-x", "hello"]))
    const modeAlias = await Effect.runPromise(Args.parse(["-x", "-m", "rush", "alias", "mode"]))

    expect(long).toMatchObject({ type: "execute", prompt: "explain this", mode: "deep3", ephemeral: false })
    expect(short).toMatchObject({ type: "execute", prompt: "hello", ephemeral: false })
    expect(modeAlias).toMatchObject({ type: "execute", prompt: "alias mode", mode: "rush", ephemeral: false })
  })

  test("parses Amp-compatible version commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["--version"]))
    const lower = await Effect.runPromise(Args.parse(["-v"]))
    const upper = await Effect.runPromise(Args.parse(["-V"]))
    const command = await Effect.runPromise(Args.parse(["version"]))

    expect(long).toEqual({ type: "version" })
    expect(lower).toEqual({ type: "version" })
    expect(upper).toEqual({ type: "version" })
    expect(command).toEqual({ type: "version" })
  })

  test("parses Amp-compatible root help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["--help"]))
    const short = await Effect.runPromise(Args.parse(["-h"]))

    expect(long).toEqual({ type: "help" })
    expect(short).toEqual({ type: "help" })
  })

  test("parses Amp-compatible version help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["version", "--help"]))
    const short = await Effect.runPromise(Args.parse(["version", "-h"]))

    expect(long).toEqual({ type: "help", topic: "version" })
    expect(short).toEqual({ type: "help", topic: "version" })
  })

  test("parses Amp-compatible logout help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["logout", "--help"]))
    const short = await Effect.runPromise(Args.parse(["logout", "-h"]))

    expect(long).toEqual({ type: "help", topic: "logout" })
    expect(short).toEqual({ type: "help", topic: "logout" })
  })

  test("parses Amp-compatible login help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["login", "--help"]))
    const short = await Effect.runPromise(Args.parse(["login", "-h"]))

    expect(long).toEqual({ type: "help", topic: "login" })
    expect(short).toEqual({ type: "help", topic: "login" })
  })

  test("parses Amp-compatible clone help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["clone", "--help"]))
    const short = await Effect.runPromise(Args.parse(["clone", "-h"]))

    expect(long).toEqual({ type: "help", topic: "clone" })
    expect(short).toEqual({ type: "help", topic: "clone" })
  })

  test("parses Amp-compatible top help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["top", "--help"]))
    const short = await Effect.runPromise(Args.parse(["top", "-h"]))

    expect(long).toEqual({ type: "help", topic: "top" })
    expect(short).toEqual({ type: "help", topic: "top" })
  })

  test("parses Amp-compatible last help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["last", "--help"]))
    const short = await Effect.runPromise(Args.parse(["last", "-h"]))

    expect(long).toEqual({ type: "help", topic: "last" })
    expect(short).toEqual({ type: "help", topic: "last" })
  })

  test("parses Amp-compatible threads help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["threads", "--help"]))
    const short = await Effect.runPromise(Args.parse(["threads", "-h"]))

    expect(long).toEqual({ type: "help", topic: "threads" })
    expect(short).toEqual({ type: "help", topic: "threads" })
  })

  test("parses Amp-compatible threads new help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["threads", "new", "--help"]))
    const short = await Effect.runPromise(Args.parse(["threads", "new", "-h"]))

    expect(long).toEqual({ type: "help", topic: "threads-new" })
    expect(short).toEqual({ type: "help", topic: "threads-new" })
  })

  test("parses Amp-compatible threads continue help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["threads", "continue", "--help"]))
    const short = await Effect.runPromise(Args.parse(["threads", "continue", "-h"]))

    expect(long).toEqual({ type: "help", topic: "threads-continue" })
    expect(short).toEqual({ type: "help", topic: "threads-continue" })
  })

  test("parses Amp-compatible threads list help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["threads", "list", "--help"]))
    const short = await Effect.runPromise(Args.parse(["threads", "list", "-h"]))

    expect(long).toEqual({ type: "help", topic: "threads-list" })
    expect(short).toEqual({ type: "help", topic: "threads-list" })
  })

  test("parses Amp-compatible threads usage help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["threads", "usage", "--help"]))
    const short = await Effect.runPromise(Args.parse(["threads", "usage", "-h"]))

    expect(long).toEqual({ type: "help", topic: "threads-usage" })
    expect(short).toEqual({ type: "help", topic: "threads-usage" })
  })

  test("parses Amp-compatible threads visibility help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["threads", "visibility", "--help"]))
    const short = await Effect.runPromise(Args.parse(["threads", "visibility", "-h"]))

    expect(long).toEqual({ type: "help", topic: "threads-visibility" })
    expect(short).toEqual({ type: "help", topic: "threads-visibility" })
  })

  test("parses Amp-compatible threads label help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["threads", "label", "--help"]))
    const short = await Effect.runPromise(Args.parse(["threads", "label", "-h"]))

    expect(long).toEqual({ type: "help", topic: "threads-label" })
    expect(short).toEqual({ type: "help", topic: "threads-label" })
  })

  test("parses Amp-compatible threads share help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["threads", "share", "--help"]))
    const short = await Effect.runPromise(Args.parse(["threads", "share", "-h"]))

    expect(long).toEqual({ type: "help", topic: "threads-share" })
    expect(short).toEqual({ type: "help", topic: "threads-share" })
  })

  test("parses Amp-compatible threads search help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["threads", "search", "--help"]))
    const short = await Effect.runPromise(Args.parse(["threads", "search", "-h"]))

    expect(long).toEqual({ type: "help", topic: "threads-search" })
    expect(short).toEqual({ type: "help", topic: "threads-search" })
  })

  test("parses Amp-compatible config help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["config", "--help"]))
    const short = await Effect.runPromise(Args.parse(["config", "-h"]))

    expect(long).toEqual({ type: "help", topic: "config" })
    expect(short).toEqual({ type: "help", topic: "config" })
  })

  test("parses Amp-compatible config keymap help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["config", "keymap", "--help"]))
    const short = await Effect.runPromise(Args.parse(["config", "keymap", "-h"]))

    expect(long).toEqual({ type: "help", topic: "config-keymap" })
    expect(short).toEqual({ type: "help", topic: "config-keymap" })
  })

  test("parses Amp-compatible config edit help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["config", "edit", "--help"]))
    const short = await Effect.runPromise(Args.parse(["config", "edit", "-h"]))

    expect(long).toEqual({ type: "help", topic: "config-edit" })
    expect(short).toEqual({ type: "help", topic: "config-edit" })
  })

  test("parses Amp-compatible mcp help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["mcp", "--help"]))
    const short = await Effect.runPromise(Args.parse(["mcp", "-h"]))

    expect(long).toEqual({ type: "help", topic: "mcp" })
    expect(short).toEqual({ type: "help", topic: "mcp" })
  })

  test("parses Amp-compatible mcp add help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["mcp", "add", "--help"]))
    const short = await Effect.runPromise(Args.parse(["mcp", "add", "-h"]))

    expect(long).toEqual({ type: "help", topic: "mcp-add" })
    expect(short).toEqual({ type: "help", topic: "mcp-add" })
  })

  test("parses Amp-compatible mcp list help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["mcp", "list", "--help"]))
    const short = await Effect.runPromise(Args.parse(["mcp", "list", "-h"]))

    expect(long).toEqual({ type: "help", topic: "mcp-list" })
    expect(short).toEqual({ type: "help", topic: "mcp-list" })
  })

  test("parses Amp-compatible mcp doctor help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["mcp", "doctor", "--help"]))
    const short = await Effect.runPromise(Args.parse(["mcp", "doctor", "-h"]))

    expect(long).toEqual({ type: "help", topic: "mcp-doctor" })
    expect(short).toEqual({ type: "help", topic: "mcp-doctor" })
  })

  test("parses Amp-compatible mcp oauth help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["mcp", "oauth", "--help"]))
    const short = await Effect.runPromise(Args.parse(["mcp", "oauth", "-h"]))

    expect(long).toEqual({ type: "help", topic: "mcp-oauth" })
    expect(short).toEqual({ type: "help", topic: "mcp-oauth" })
  })

  test("parses Amp-compatible mcp oauth login help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["mcp", "oauth", "login", "--help"]))
    const short = await Effect.runPromise(Args.parse(["mcp", "oauth", "login", "-h"]))

    expect(long).toEqual({ type: "help", topic: "mcp-oauth-login" })
    expect(short).toEqual({ type: "help", topic: "mcp-oauth-login" })
  })

  test("parses Amp-compatible mcp oauth logout help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["mcp", "oauth", "logout", "--help"]))
    const short = await Effect.runPromise(Args.parse(["mcp", "oauth", "logout", "-h"]))

    expect(long).toEqual({ type: "help", topic: "mcp-oauth-logout" })
    expect(short).toEqual({ type: "help", topic: "mcp-oauth-logout" })
  })

  test("parses Amp-compatible mcp oauth status help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["mcp", "oauth", "status", "--help"]))
    const short = await Effect.runPromise(Args.parse(["mcp", "oauth", "status", "-h"]))

    expect(long).toEqual({ type: "help", topic: "mcp-oauth-status" })
    expect(short).toEqual({ type: "help", topic: "mcp-oauth-status" })
  })

  test("parses Amp-compatible mcp remove help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["mcp", "remove", "--help"]))
    const short = await Effect.runPromise(Args.parse(["mcp", "remove", "-h"]))

    expect(long).toEqual({ type: "help", topic: "mcp-remove" })
    expect(short).toEqual({ type: "help", topic: "mcp-remove" })
  })

  test("parses Amp-compatible mcp approve help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["mcp", "approve", "--help"]))
    const short = await Effect.runPromise(Args.parse(["mcp", "approve", "-h"]))

    expect(long).toEqual({ type: "help", topic: "mcp-approve" })
    expect(short).toEqual({ type: "help", topic: "mcp-approve" })
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

  test("parses config commands", async () => {
    const command = await Effect.runPromise(Args.parse(["config", "keymap"]))

    expect(command).toEqual({ type: "config", action: "keymap" })
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

  test("parses doctor command", async () => {
    const command = await Effect.runPromise(Args.parse(["doctor"]))

    expect(command).toEqual({ type: "doctor" })
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

  test("parses -e as an Amp-compatible invalid execute alias command", async () => {
    const command = await Effect.runPromise(Args.parse(["-e"]))

    expect(command).toEqual({ type: "invalid_execute_alias" })
  })

  test("returns Effect CLI diagnostics for missing flag values", async () => {
    const error = await Effect.runPromise(Args.parse(["run", "--mode"]).pipe(Effect.flip))

    expect(error.exit_code).toBe(2)
    expect(error.message).toContain("USAGE")
    expect(error.message).toContain("Invalid value")
  })
})
