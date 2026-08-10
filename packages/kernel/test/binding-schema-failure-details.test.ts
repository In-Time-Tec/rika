import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { HostBindingRegistry } from "@batonfx/repl"

const Failure = Schema.Struct({ _tag: Schema.tag("Failure"), retry: Schema.Boolean })

const registry = HostBindingRegistry.make([
  {
    name: "fixture",
    operations: [
      {
        name: "decode",
        input: Schema.Struct({ path: Schema.String }),
        output: Schema.Void,
        failure: Schema.Never,
        handle: () => Effect.void,
      },
      {
        name: "output",
        input: Schema.Struct({}),
        output: Schema.Struct({ count: Schema.Finite }),
        failure: Schema.Never,
        handle: () => Effect.succeed({ count: "many" } as never),
      },
      {
        name: "failure",
        input: Schema.Struct({}),
        output: Schema.Never,
        failure: Failure,
        handle: () => Effect.fail({ _tag: "Failure", retry: "later" } as never),
      },
    ],
  },
])

const schemaFailure = (operation: string, input: unknown) =>
  Effect.gen(function* () {
    const mounted = yield* registry
    return yield* Effect.flip(mounted.invoke({ module: "fixture", operation, input }))
  })

describe("host binding schema failure details", () => {
  it.effect("preserves the issue path and expected type at every host-binding schema stage", () =>
    Effect.gen(function* () {
      const decode = yield* schemaFailure("decode", { path: 7 })
      const output = yield* schemaFailure("output", {})
      const failure = yield* schemaFailure("failure", {})

      expect(decode).toMatchObject({
        _tag: "@batonfx/repl/HostBindingSchemaFailure",
        stage: "decode-input",
      })
      expect(decode.message).toContain("Expected string, got 7")
      expect(decode.message).toContain('at ["path"]')
      expect(output).toMatchObject({ stage: "encode-output" })
      expect(output.message).toContain('Expected number, got "many"')
      expect(output.message).toContain('at ["count"]')
      expect(failure).toMatchObject({ stage: "encode-failure" })
      expect(failure.message).toContain('Expected boolean, got "later"')
      expect(failure.message).toContain('at ["retry"]')
    }),
  )
})
