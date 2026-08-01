import * as OpenAiAuth from "../../authentication/openai-auth-service"
import { Console, Context, Effect, Layer } from "effect"
import { OperationUnavailable } from "../contract/product-operation-errors"
import type { Input } from "../contract/product-operation"

export interface AuthOperationOptions {
  readonly layer: Layer.Layer<OpenAiAuth.Service, OperationError>
  readonly assertOpenAiDirect: (workspace: string) => Effect.Effect<void, OperationError>
}

export interface OperationError {
  readonly message: string
}

const unavailable = (input: Extract<Input, { readonly _tag: "Auth" }>, message: string) =>
  OperationUnavailable.make({ operation: input._tag, message })

export const run = Effect.fn("AuthenticationOperation.run")(function* (
  input: Extract<Input, { readonly _tag: "Auth" }>,
  options: AuthOperationOptions,
  defaultWorkspace: string,
) {
  if (input.action === "login") {
    yield* options
      .assertOpenAiDirect(input.clientWorkspace ?? defaultWorkspace)
      .pipe(Effect.mapError((error) => unavailable(input, error.message)))
  }
  const context = yield* Layer.build(options.layer).pipe(Effect.mapError((error) => unavailable(input, String(error))))
  const auth = Context.get(context, OpenAiAuth.Service)
  if (input.action === "login") {
    yield* (input.deviceCode === true ? auth.loginDevice : auth.loginBrowser()).pipe(
      Effect.flatMap(() => Console.log("OpenAI account login complete.")),
      Effect.mapError((error) => unavailable(input, error.message)),
    )
    return
  }
  if (input.action === "logout") {
    const result = yield* auth.logout.pipe(Effect.mapError((error) => unavailable(input, error.message)))
    yield* Console.log(
      result.removed
        ? "OpenAI account credentials removed. Server revocation is not supported."
        : "No OpenAI account credentials were stored. Server revocation is not supported.",
    )
    return
  }
  const status = yield* auth.status.pipe(Effect.mapError((error) => unavailable(input, error.message)))
  let message: string
  if (status._tag === "Unauthenticated") message = "OpenAI account: unauthenticated"
  else if (status._tag === "Present") message = "OpenAI account: credentials present (remote validity not checked)"
  else if (status._tag === "RefreshRequired") message = "OpenAI account: refresh required (remote validity not checked)"
  else message = "OpenAI account: credential store is corrupt; log in again after removing it"
  yield* Console.log(message)
})
