import { describe, expect, test } from "bun:test"
import { Ids } from "@rika/schema"
import { Effect } from "effect"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Debug } from "../src/index"

describe("CLI debug command", () => {
  test("launches bundled motel as a child process with Rika filters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rika-debug-test-"))
    const script = join(dir, "fake-motel.js")
    const output = join(dir, "output.json")
    const expectedCwd = await realpath(dir)
    const threadId = Ids.ThreadId.make("thread_debug_test")
    await writeFile(
      script,
      `const output = process.env.RIKA_FAKE_MOTEL_OUTPUT
if (output === undefined) process.exit(2)
await Bun.write(output, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  baseUrl: process.env.MOTEL_OTEL_BASE_URL,
  queryUrl: process.env.MOTEL_OTEL_QUERY_URL,
  service: process.env.MOTEL_TUI_SERVICE_NAME,
  attrKey: process.env.MOTEL_TUI_ATTR_KEY,
  attrValue: process.env.MOTEL_TUI_ATTR_VALUE,
  theme: process.env.MOTEL_TUI_THEME,
}))
`,
    )

    try {
      const exitCode = await Effect.runPromise(
        Debug.executeCommand(
          { type: "debug", all: false, thread_id: threadId },
          {
            RIKA_BUN_EXECUTABLE: process.execPath,
            RIKA_FAKE_MOTEL_OUTPUT: output,
            RIKA_MOTEL_SCRIPT: script,
            RIKA_TELEMETRY_ENDPOINT: "http://127.0.0.1:4999/",
          },
        ),
      )
      const invocation = JSON.parse(await readFile(output, "utf8"))

      expect(exitCode).toBe(0)
      expect(invocation).toEqual({
        argv: ["tui"],
        cwd: expectedCwd,
        baseUrl: "http://127.0.0.1:4999",
        queryUrl: "http://127.0.0.1:4999",
        service: "rika",
        attrKey: "rika.thread_id",
        attrValue: threadId,
        theme: "rika",
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
