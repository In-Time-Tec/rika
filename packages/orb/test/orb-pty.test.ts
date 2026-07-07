import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { OrbPty } from "../src/index"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe("OrbPty", () => {
  test("opens the shared tmux PTY and forwards terminal IO", async () => {
    type Call =
      | {
          readonly type: "open"
          readonly command: ReadonlyArray<string>
          readonly cwd: string
          readonly cols: number
          readonly rows: number
          readonly env: Readonly<Record<string, string>>
        }
      | { readonly type: "write"; readonly text: string }
      | { readonly type: "resize"; readonly cols: number; readonly rows: number }
      | { readonly type: "close" }

    const calls: Array<Call> = []
    const output: Array<string> = []
    const exits: Array<OrbPty.PtyExit> = []
    let emitData: ((bytes: Uint8Array) => Effect.Effect<void>) | undefined
    let emitExit: ((exit: OrbPty.PtyExit) => Effect.Effect<void>) | undefined

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* OrbPty.open({
          workspace_root: "/workspace/rika",
          cols: 90,
          rows: 32,
          onData: (bytes) =>
            Effect.sync(() => {
              output.push(decoder.decode(bytes))
            }),
          onExit: (exit) =>
            Effect.sync(() => {
              exits.push(exit)
            }),
        })

        yield* session.write(encoder.encode("pwd\n"))
        yield* session.resize(120, 40)
        yield* session.close

        if (emitData === undefined) throw new Error("missing terminal callback")
        if (emitExit === undefined) throw new Error("missing exit callback")
        yield* emitData(encoder.encode("hello from tmux"))
        yield* emitExit({ source: "process", exit_code: 0, signal: null })

        return output
      }).pipe(
        Effect.provide(
          OrbPty.layerWithSystem(
            OrbPty.systemTestLayer({
              open: (input) =>
                Effect.sync(() => {
                  calls.push({
                    type: "open",
                    command: input.command,
                    cwd: input.cwd,
                    cols: input.cols,
                    rows: input.rows,
                    env: input.env,
                  })
                  emitData = input.onData
                  emitExit = input.onExit
                  return {
                    write: (bytes) =>
                      Effect.sync(() => {
                        calls.push({ type: "write", text: decoder.decode(bytes) })
                      }),
                    resize: (cols, rows) =>
                      Effect.sync(() => {
                        calls.push({ type: "resize", cols, rows })
                      }),
                    close: Effect.sync(() => {
                      calls.push({ type: "close" })
                    }),
                  }
                }),
            }),
            { PATH: "/usr/bin", TERM: "xterm-ghostty", RIKA_TEST_VALUE: "kept" },
          ),
        ),
      ),
    )

    expect(calls).toEqual([
      {
        type: "open",
        command: ["tmux", "new-session", "-A", "-s", "rika"],
        cwd: "/workspace/rika",
        cols: 90,
        rows: 32,
        env: { PATH: "/usr/bin", TERM: "xterm-256color", RIKA_TEST_VALUE: "kept" },
      },
      { type: "write", text: "pwd\n" },
      { type: "resize", cols: 120, rows: 40 },
      { type: "close" },
    ])
    expect(result).toEqual(["hello from tmux"])
    expect(exits).toEqual([{ source: "process", exit_code: 0, signal: null }])
  })
})
