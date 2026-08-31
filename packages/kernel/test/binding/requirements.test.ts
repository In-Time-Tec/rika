import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { HostBindings } from "generalist/repl"

const Failure = Schema.Struct({ _tag: Schema.tag("Failure"), retry: Schema.Boolean })

const registry = HostBindings.make([
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
        handle: () => Effect.succeed(Schema.decodeSync(Schema.Struct({ count: Schema.String }))({ count: "many" })),
      },
      {
        name: "failure",
        input: Schema.Struct({}),
        output: Schema.Never,
        failure: Failure,
        handle: () =>
          Effect.fail(
            Schema.decodeSync(Schema.Struct({ _tag: Schema.tag("Failure"), retry: Schema.String }))({
              _tag: "Failure",
              retry: "later",
            }),
          ),
      },
    ],
  },
])

const schemaFailure = (operation: string, input: Schema.Json) =>
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
        _tag: "generalist/repl/HostModuleSchemaFailure",
        stage: "decode-input",
      })
      expect(decode.message).toContain("Expected string")
      expect(decode.message).toContain('at ["path"]')
      expect(output).toMatchObject({ stage: "encode-output" })
      expect(output.message).toContain("Expected number")
      expect(output.message).toContain('at ["count"]')
      expect(failure).toMatchObject({ stage: "encode-failure" })
      expect(failure.message).toContain("Expected boolean")
      expect(failure.message).toContain('at ["retry"]')
    }),
  )
})
