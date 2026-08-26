import { describe, expect, it } from "@effect/vitest"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { Context, Effect, Layer } from "effect"
import * as MachineBindings from "../src/machine-bindings"

describe("machine bindings", () => {
  it.effect("turns parent Cell cancellation into a known coding-tool failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          MachineBindings.layer({ execute: () => Effect.succeed({ _tag: "Cancelled" }) }),
        )
        const runtime = Context.get(context, CodingToolRuntime.Service)
        const result = yield* Effect.result(runtime.run({ _tag: "Bash", command: "sleep 30" }))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            _tag: "ToolError",
            tool: "bash",
            kind: "operation",
            category: "operation",
            outcome: "known",
            recovery: "never",
          })
      }),
    ),
  )
})
