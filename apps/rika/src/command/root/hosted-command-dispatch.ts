import { Context, Effect } from "effect"
import { HostedError, type RunRequest } from "../../hosted/hosted-contract"

export type Input =
  | {
      readonly _tag: "Auth"
      readonly action: "login"
      readonly server?: string | undefined
      readonly noOpen: boolean
    }
  | { readonly _tag: "Auth"; readonly action: "status"; readonly json: boolean }
  | { readonly _tag: "Auth"; readonly action: "logout"; readonly all?: boolean | undefined }
  | { readonly _tag: "Auth"; readonly action: "devices" }
  | { readonly _tag: "Auth"; readonly action: "revoke-device"; readonly device?: string | undefined }
  | { readonly _tag: "Organization"; readonly action: "list" }
  | { readonly _tag: "Organization"; readonly action: "use"; readonly organization: string }
  | { readonly _tag: "Organization"; readonly action: "invite"; readonly email: string }
  | { readonly _tag: "RemoteThread"; readonly action: "new" }
  | { readonly _tag: "LocalThread"; readonly action: "new" }
  | { readonly _tag: "LocalForeground"; readonly threadId?: string | undefined; readonly workspace?: string | undefined }
  | { readonly _tag: "RemoteRun"; readonly threadId: string; readonly request: RunRequest }

export interface Interface {
  readonly run: (
    input: Input,
  ) => Effect.Effect<void, HostedError>
}

export const Service = Context.Reference<Interface>("@rika/cli/command/HostedCommandService", {
  defaultValue: () => ({
    run: (_input) =>
      Effect.fail(
        HostedError.make({
          kind: "network",
          message: "Hosted commands are unavailable in this process",
        }),
      ),
  }),
})

export const dispatch = Effect.fn("HostedCommand.dispatch")(function* (input: Input) {
  const service = yield* Service
  yield* service.run(input)
})
