import { expect, it } from "@effect/vitest"
import * as ToolRuntime from "@rika/product/native-tool-runtime"
import { Effect } from "effect"
import { executeShellCommand } from "../../../src/operation/interactive/shell"

it.effect("keeps recorded ! shell on the private runtime port and polls its process", () =>
  Effect.gen(function* () {
    const requests: Array<ToolRuntime.Request> = []
    const runtime: ToolRuntime.Interface = {
      run: (request) => {
        requests.push(request)
        if (request._tag === "Shell")
          return Effect.succeed({ text: "first ", truncated: false, running: true, processId: "process-one" })
        if (request._tag === "ShellCommandStatus")
          return Effect.succeed({ text: "second", truncated: false, running: false, exitCode: 0 })
        return Effect.die(`unexpected ${request._tag}`)
      },
    }

    expect(yield* executeShellCommand(runtime, "printf ok")).toEqual({
      text: "first second",
      truncated: false,
      exitCode: 0,
    })
    expect(requests).toEqual([
      { _tag: "Shell", command: "sh", args: ["-c", "printf ok"], waitMillis: 10_000 },
      { _tag: "ShellCommandStatus", processId: "process-one", waitMillis: 9_000 },
    ])
  }),
)
