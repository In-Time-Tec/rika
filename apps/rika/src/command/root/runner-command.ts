import * as ProductOperation from "@rika/product/product-operation"
import { Context, Effect } from "effect"
import { CliError } from "effect/unstable/cli"
import type { RemoteThreadCreation } from "../../runner/runner-contract"

export interface Input {
  readonly workspace?: string | undefined
  readonly remoteThreadCreation?: RemoteThreadCreation | undefined
}

export interface Interface {
  readonly run: (input: Input) => Effect.Effect<void, ProductOperation.OperationUnavailable>
}

export const Service = Context.Reference<Interface>("@rika/cli/command/RunnerCommand", {
  defaultValue: () => ({
    run: () =>
      Effect.fail(
        ProductOperation.OperationUnavailable.make({
          operation: "Runner",
          message: "Runner mode is unavailable in this process",
        }),
      ),
  }),
})

export const dispatch = Effect.fn("RunnerCommand.dispatch")(function* (input: Input) {
  const service = yield* Service
  yield* service
    .run(input)
    .pipe(Effect.mapError((error) => CliError.UserError.make({ cause: error, userMessage: error.message })))
})
