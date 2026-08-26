import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "tenetkit/repl"
import * as CodingToolResult from "@rika/coding-tools/coding-tool-result"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as MediaContract from "@rika/coding-tools/media-view-contract"
import { nested, NestedOperationFailed, operation, type Requirements } from "../envelope"

export const name = "media"

const Failure = Schema.Union([CodingToolResult.ToolFailure, NestedOperationFailed])

const Attached = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  artifact: Schema.optionalKey(MediaContract.Artifact),
})

const AttachInput = Schema.Struct({ path: Schema.String })

export const operations: ReadonlyArray<HostBindingRegistry.AnyOperation<CodingToolRuntime.Service | Requirements>> = [
  operation({
    name: "attach",
    input: AttachInput,
    output: Attached,
    failure: Failure,
    handle: (input) =>
      nested(
        { kind: "media.attach", payload: input, replayPolicy: "provider-idempotent" },
        Effect.map(
          Effect.flatMap(CodingToolRuntime.Service, (runtime) => runtime.run({ _tag: "ViewMedia", path: input.path })),
          (result) =>
            result.artifact === undefined
              ? { text: result.text, truncated: result.truncated }
              : { text: result.text, truncated: result.truncated, artifact: result.artifact },
        ),
      ),
  }),
]

export const module: HostBindingRegistry.Module<CodingToolRuntime.Service | Requirements> = { name, operations }
