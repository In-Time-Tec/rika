import { describe, expect, test } from "bun:test"
import { Ide, Ids } from "@rika/schema"
import { Effect } from "effect"
import { Args } from "../src/index"

describe("CLI args", () => {
  test("defaults to interactive mode with no prompt", async () => {
    const command = await Effect.runPromise(Args.parse([]))

    expect(command).toEqual({ type: "interactive", orb: false, ephemeral: false })
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
      orb: false,
      stream_json: false,
      stream_json_input: false,
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

  test("parses orb execute and interactive flags", async () => {
    const compact = await Effect.runPromise(Args.parse(["-ox", "hello"]))
    const project = await Effect.runPromise(Args.parse(["--execute", "--orb", "--project", "demo", "hello"]))
    const run = await Effect.runPromise(Args.parse(["run", "--orb", "--project", "demo", "ship", "it"]))
    const interactive = await Effect.runPromise(Args.parse(["interactive", "--orb"]))
    const rootInteractive = await Effect.runPromise(Args.parse(["--orb"]))

    expect(compact).toMatchObject({ type: "execute", prompt: "hello", orb: true, ephemeral: false })
    expect(project).toMatchObject({
      type: "execute",
      prompt: "hello",
      orb: true,
      project_name: "demo",
      ephemeral: false,
    })
    expect(run).toMatchObject({
      type: "execute",
      prompt: "ship it",
      orb: true,
      project_name: "demo",
      ephemeral: false,
    })
    expect(interactive).toMatchObject({ type: "interactive", orb: true, ephemeral: false })
    expect(rootInteractive).toMatchObject({ type: "interactive", orb: true, ephemeral: false })
  })

  test("parses sync and orb server flags", async () => {
    const threadId = Ids.ThreadId.make("thread_args_sync")
    const sync = await Effect.runPromise(Args.parse(["sync", threadId]))
    const server = await Effect.runPromise(
      Args.parse(["server", "--orb", "--base-commit", "abc123", "--workspace", "/home/user/repo"]),
    )

    expect(sync).toEqual({ type: "sync", thread_id: threadId })
    expect(server).toMatchObject({
      type: "server",
      orb: true,
      base_commit: "abc123",
      workspace_root: "/home/user/repo",
    })
  })

  test("parses thread tournament commands", async () => {
    const threadId = Ids.ThreadId.make("thread_args_tournament")
    const command = await Effect.runPromise(
      Args.parse([
        "threads",
        "tournament",
        threadId,
        "--message",
        "-",
        "-n",
        "3",
        "--modes",
        "smart,deep2,deep3",
        "--rubric",
        "prefer concrete answers",
      ]),
    )

    expect(command).toEqual({
      type: "threads",
      action: "tournament",
      thread_id: threadId,
      message: "-",
      branch_count: 3,
      modes: ["smart", "deep2", "deep3"],
      rubric: "prefer concrete answers",
    })
  })

  test("parses thread import commands", async () => {
    const command = await Effect.runPromise(Args.parse(["threads", "import", "/old/project/.rika"]))

    expect(command).toEqual({ type: "threads", action: "import", source_data_dir: "/old/project/.rika" })
  })

  test("parses memory commands", async () => {
    const index = await Effect.runPromise(Args.parse(["memory", "index", "--workspace", "/workspace/rika"]))
    const status = await Effect.runPromise(Args.parse(["memory", "status"]))

    expect(index).toEqual({ type: "memory", action: "index", workspace_root: "/workspace/rika" })
    expect(status).toEqual({ type: "memory", action: "status" })
  })

  test("parses mcp add, remove, and doctor commands", async () => {
    const remote = await Effect.runPromise(Args.parse(["mcp", "add", "remote", "--url", "https://example.com/mcp"]))
    const global = await Effect.runPromise(
      Args.parse(["mcp", "add", "local", "--global", "--", "node", "server.js", "--stdio"]),
    )
    const remove = await Effect.runPromise(Args.parse(["mcp", "remove", "local", "--global"]))
    const doctor = await Effect.runPromise(Args.parse(["mcp", "doctor"]))

    expect(remote).toEqual({ type: "mcp", action: "add", server_name: "remote", url: "https://example.com/mcp" })
    expect(global).toEqual({
      type: "mcp",
      action: "add",
      server_name: "local",
      global: true,
      command: "node",
      args: ["server.js", "--stdio"],
    })
    expect(remove).toEqual({ type: "mcp", action: "remove", server_name: "local", global: true })
    expect(doctor).toEqual({ type: "mcp", action: "doctor" })
  })

  test("rejects ambiguous mcp add input", async () => {
    const result = await Effect.runPromise(
      Effect.flip(Args.parse(["mcp", "add", "bad", "--url", "https://example.com/mcp", "--", "node"])),
    )

    expect(result).toMatchObject({
      _tag: "ArgsError",
      message: "rika mcp add accepts either --url or command argv, not both",
      exit_code: 2,
    })
  })

  test("parses orb list, kill, shell, and usage commands", async () => {
    const threadId = Ids.ThreadId.make("thread_args_orb_kill")
    const list = await Effect.runPromise(Args.parse(["orb", "list"]))
    const kill = await Effect.runPromise(Args.parse(["orb", "kill", threadId]))
    const forcedKill = await Effect.runPromise(Args.parse(["orb", "kill", threadId, "--force"]))
    const shell = await Effect.runPromise(Args.parse(["orb", "shell", threadId]))
    const usage = await Effect.runPromise(
      Args.parse(["orb", "usage", "--project", "demo", "--since", "2026-07-03T12:00:00.000Z"]),
    )

    expect(list).toEqual({ type: "orb", action: "list" })
    expect(kill).toEqual({ type: "orb", action: "kill", thread_id: threadId, force: false })
    expect(forcedKill).toEqual({ type: "orb", action: "kill", thread_id: threadId, force: true })
    expect(shell).toEqual({ type: "orb", action: "shell", thread_id: threadId })
    expect(usage).toEqual({
      type: "orb",
      action: "usage",
      project_name: "demo",
      since: Date.parse("2026-07-03T12:00:00.000Z"),
    })
  })

  test("parses orb tournament commands with explicit branch count", async () => {
    const command = await Effect.runPromise(
      Args.parse([
        "orb",
        "tournament",
        "ship it",
        "-n",
        "3",
        "--project",
        "demo",
        "--modes",
        "smart,deep2,deep3",
        "--rubric",
        "prefer tested diffs",
        "--sync-winner",
        "--yes",
      ]),
    )

    expect(command).toEqual({
      type: "orb",
      action: "tournament",
      task: "ship it",
      branch_count: 3,
      project_name: "demo",
      modes: ["smart", "deep2", "deep3"],
      rubric: "prefer tested diffs",
      sync_winner: true,
      keep_losers: false,
      yes: true,
    })
  })

  test("rejects orb tournament without explicit branch count", async () => {
    const result = await Effect.runPromise(Effect.flip(Args.parse(["orb", "tournament", "ship it"])))

    expect(result).toMatchObject({
      _tag: "ArgsError",
      exit_code: 2,
    })
    expect(result.message).toContain("Missing required flag: --branches")
  })

  test("allows execute without a prompt so piped stdin can supply it", async () => {
    const command = await Effect.runPromise(Args.parse(["-x"]))

    expect(command).toMatchObject({
      type: "execute",
      prompt: "",
      orb: false,
      stream_json: false,
      stream_json_input: false,
      ephemeral: false,
    })
  })

  test("parses explicit stream JSON execute flags", async () => {
    const command = await Effect.runPromise(Args.parse(["--execute", "--stream-json", "2+2?"]))
    const run = await Effect.runPromise(Args.parse(["run", "--stream-json", "ship", "it"]))

    expect(command).toMatchObject({
      type: "execute",
      prompt: "2+2?",
      orb: false,
      stream_json: true,
      stream_json_input: false,
      ephemeral: false,
    })
    expect(run).toMatchObject({
      type: "execute",
      prompt: "ship it",
      orb: false,
      stream_json: true,
      stream_json_input: false,
      ephemeral: false,
    })
  })

  test("rejects stream JSON input without stream JSON output", async () => {
    const result = await Effect.runPromise(Effect.flip(Args.parse(["--execute", "--stream-json-input", "hello"])))

    expect(result).toMatchObject({
      _tag: "ArgsError",
      message: "--stream-json-input requires --stream-json",
      exit_code: 2,
    })
  })

  test("rejects root stream JSON flags without execute mode", async () => {
    const result = await Effect.runPromise(Effect.flip(Args.parse(["--stream-json"])))

    expect(result).toMatchObject({
      _tag: "ArgsError",
      message: "--stream-json requires --execute or run",
      exit_code: 2,
    })
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

  test("parses thread fork help commands before Effect CLI globals", async () => {
    const long = await Effect.runPromise(Args.parse(["threads", "fork", "--help"]))
    const short = await Effect.runPromise(Args.parse(["threads", "fork", "-h"]))

    expect(long).toEqual({ type: "help", topic: "threads-fork" })
    expect(short).toEqual({ type: "help", topic: "threads-fork" })
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

  test("parses semantic thread search", async () => {
    const command = await Effect.runPromise(Args.parse(["threads", "search", "--semantic", "prior fix"]))

    expect(command).toEqual({
      type: "threads",
      action: "search",
      query: "prior fix",
      semantic: true,
    })
  })

  test("parses project commands", async () => {
    const create = await Effect.runPromise(
      Args.parse([
        "project",
        "create",
        "demo",
        "--repo",
        "https://github.com/x/y",
        "--branch",
        "trunk",
        "--template",
        "linux",
      ]),
    )
    const list = await Effect.runPromise(Args.parse(["project", "list"]))
    const show = await Effect.runPromise(Args.parse(["project", "show", "demo"]))
    const setEnv = await Effect.runPromise(Args.parse(["project", "set-env", "demo", "FOO=bar"]))
    const setSecret = await Effect.runPromise(Args.parse(["project", "set-secret", "demo", "TOKEN"]))

    expect(create).toEqual({
      type: "project",
      action: "create",
      name: "demo",
      repo_origin: "https://github.com/x/y",
      default_branch: "trunk",
      template_id: "linux",
    })
    expect(list).toEqual({ type: "project", action: "list" })
    expect(show).toEqual({ type: "project", action: "show", name: "demo" })
    expect(setEnv).toEqual({ type: "project", action: "set-env", name: "demo", env_assignment: "FOO=bar" })
    expect(setSecret).toEqual({ type: "project", action: "set-secret", name: "demo", secret_name: "TOKEN" })
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

  test("parses config list and edit commands", async () => {
    const list = await Effect.runPromise(Args.parse(["config", "list"]))
    const editUser = await Effect.runPromise(Args.parse(["config", "edit"]))
    const editWorkspace = await Effect.runPromise(Args.parse(["config", "edit", "--workspace"]))

    expect(list).toEqual({ type: "config", action: "list" })
    expect(editUser).toEqual({ type: "config", action: "edit" })
    expect(editWorkspace).toEqual({ type: "config", action: "edit", workspace: true })
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
      orb: false,
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
    const compact = await Effect.runPromise(Args.parse(["threads", "compact", threadId]))
    const fork = await Effect.runPromise(Args.parse(["threads", "fork", threadId, "--at-turn", "turn_args_threads"]))
    const visibility = await Effect.runPromise(Args.parse(["threads", "visibility", threadId, "workspace"]))
    const reference = await Effect.runPromise(Args.parse(["threads", "reference", threadId, "auth", "race"]))
    const rebuildProjection = await Effect.runPromise(Args.parse(["threads", "rebuild-projection"]))

    expect(list).toEqual({ type: "threads", action: "list", include_archived: true, limit: 5 })
    expect(search).toEqual({ type: "threads", action: "search", query: "auth race", limit: 3 })
    expect(archive).toEqual({ type: "threads", action: "archive", thread_id: threadId })
    expect(compact).toEqual({ type: "threads", action: "compact", thread_id: threadId })
    expect(fork).toEqual({
      type: "threads",
      action: "fork",
      thread_id: threadId,
      at_turn: Ids.TurnId.make("turn_args_threads"),
    })
    expect(visibility).toEqual({ type: "threads", action: "visibility", thread_id: threadId, visibility: "workspace" })
    expect(reference).toEqual({ type: "threads", action: "reference", thread_id: threadId, query: "auth race" })
    expect(rebuildProjection).toEqual({ type: "threads", action: "rebuild-projection" })
  })

  test("parses skill management commands", async () => {
    const list = await Effect.runPromise(Args.parse(["skills", "list"]))
    const inspect = await Effect.runPromise(Args.parse(["skills", "inspect", "deploy"]))
    const add = await Effect.runPromise(Args.parse(["skills", "add", "owner/repo/path/to/skill", "--user", "--force"]))
    const remove = await Effect.runPromise(Args.parse(["skills", "remove", "deploy", "--user"]))

    expect(list).toEqual({ type: "skills", action: "list" })
    expect(inspect).toEqual({ type: "skills", action: "inspect", name: "deploy" })
    expect(add).toEqual({
      type: "skills",
      action: "add",
      source: "owner/repo/path/to/skill",
      user: true,
      force: true,
    })
    expect(remove).toEqual({ type: "skills", action: "remove", name: "deploy", user: true })
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
      orb: false,
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

  test("returns Effect CLI diagnostics for invalid flag values", async () => {
    const error = await Effect.runPromise(Args.parse(["threads", "list", "--limit", "nope"]).pipe(Effect.flip))

    expect(error.exit_code).toBe(2)
    expect(error.message).toContain("USAGE")
    expect(error.message).toContain("Invalid value")
  })
})
