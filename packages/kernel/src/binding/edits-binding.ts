import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "tenetkit/repl"
import * as CodingToolResult from "@rika/coding-tools/coding-tool-result"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { nested, NestedOperationFailed, operation, type Requirements } from "./nested-operation-envelope"

export const name = "edits"

const Failure = Schema.Union([CodingToolResult.ToolFailure, NestedOperationFailed])

const AppliedEdit = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  diff: Schema.optionalKey(Schema.String),
})

const Applied = Schema.Struct({ applied: Schema.Array(AppliedEdit), truncated: Schema.Boolean })

const Replacement = Schema.Struct({
  path: Schema.String,
  oldStr: Schema.String,
  newStr: Schema.String,
  replaceAll: Schema.optionalKey(Schema.Boolean),
})

const ApplyInput = Schema.Struct({
  replacements: Schema.Array(Replacement).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
})

const run = (request: typeof CodingToolRuntime.Request.Type) =>
  Effect.flatMap(CodingToolRuntime.Service, (runtime) => runtime.run(request))

const applyOne = (replacement: typeof Replacement.Type) =>
  Effect.map(
    run({
      _tag: "Edit",
      path: replacement.path,
      oldStr: replacement.oldStr,
      newStr: replacement.newStr,
      ...(replacement.replaceAll === undefined ? {} : { replaceAll: replacement.replaceAll }),
    }),
    (result) => ({
      edit: {
        path: replacement.path,
        text: result.text,
        ...(result.diff === undefined ? {} : { diff: result.diff }),
      },
      truncated: result.truncated,
    }),
  )

export const operations: ReadonlyArray<HostBindingRegistry.AnyOperation<CodingToolRuntime.Service | Requirements>> = [
  operation({
    name: "apply",
    input: ApplyInput,
    output: Applied,
    failure: Failure,
    handle: (input) =>
      nested(
        {
          kind: "edits.apply",
          payload: input,
          replayPolicy: "never",
          approval: {
            capability: "edits.apply",
            request: { paths: input.replacements.map((replacement) => replacement.path) },
          },
        },
        Effect.map(Effect.forEach(input.replacements, applyOne), (results) => ({
          applied: results.map((result) => result.edit),
          truncated: results.some((result) => result.truncated),
        })),
      ),
  }),
]

export const module: HostBindingRegistry.Module<CodingToolRuntime.Service | Requirements> = { name, operations }
