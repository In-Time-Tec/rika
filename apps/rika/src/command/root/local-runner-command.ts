import * as ProductOperation from "@rika/product/product-operation"
import { Context, Effect } from "effect"
import { CliError } from "effect/unstable/cli"
import type { RemoteThreadCreation } from "../../local-executor/local-runner-contract"

export interface Input {
  readonly workspace?: string | undefined
  readonly remoteThreadCreation?: RemoteThreadCreation | undefined
}

export interface Interface {
  readonly run: (input: Input) => Effect.Effect<void, ProductOperation.OperationUnavailable>
}

export const Service = Context.Reference<Interface>("@rika/cli/command/LocalRunnerCommand", {
  defaultValue: () => ({
    run: () =>
      Effect.fail(
        ProductOperation.OperationUnavailable.make({
          operation: "LocalRunner",
          message: "Local runner mode is unavailable in this process",
        }),
      ),
  }),
})

export const dispatch = Effect.fn("LocalRunnerCommand.dispatch")(function* (input: Input) {
  const service = yield* Service
  yield* service
    .run(input)
    .pipe(Effect.mapError((error) => CliError.UserError.make({ cause: error, userMessage: error.message })))
})
