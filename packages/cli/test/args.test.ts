import { describe, expect, test } from "bun:test"
import { Ids } from "@rika/schema"
import { Effect } from "effect"
import { Args } from "../src/index"

describe("CLI args", () => {
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
