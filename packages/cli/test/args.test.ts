import { describe, expect, test } from "bun:test"
import { Ids } from "@rika/schema"
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
