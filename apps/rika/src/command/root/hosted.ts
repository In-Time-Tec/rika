import * as ProductOperation from "@rika/product/product-operation"
import { Context, Effect } from "effect"
import { CliError } from "effect/unstable/cli"
import type { ModelProvider, RunRequest } from "../../hosted/contract"
import type { EnvironmentPhase, EnvironmentScope } from "@rika/product/environment-policy"
import type { RepositoryService } from "@rika/product/workspace-capability"

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
  | { readonly _tag: "Organization"; readonly action: "personal" }
  | { readonly _tag: "Organization"; readonly action: "use"; readonly organization: string }
  | { readonly _tag: "Organization"; readonly action: "invite"; readonly email: string }
  | { readonly _tag: "Project"; readonly action: "list" }
  | { readonly _tag: "Project"; readonly action: "create"; readonly name: string }
  | { readonly _tag: "Project"; readonly action: "use"; readonly project: string }
  | { readonly _tag: "RemoteThread"; readonly action: "new" }
  | { readonly _tag: "RemoteRun"; readonly threadId: string; readonly request: RunRequest }
  | { readonly _tag: "Credential"; readonly action: "put"; readonly provider: ModelProvider; readonly apiKey: string }
  | { readonly _tag: "Credential"; readonly action: "list"; readonly provider?: ModelProvider | undefined }
  | { readonly _tag: "Credential"; readonly action: "revoke"; readonly provider: ModelProvider }
  | { readonly _tag: "Provider"; readonly action: "login"; readonly deviceCode: boolean }
  | { readonly _tag: "Provider"; readonly action: "status" | "logout" }
  | {
      readonly _tag: "Secret"
      readonly action: "put"
      readonly name: string
      readonly value: string
      readonly scope?: EnvironmentScope | undefined
      readonly phase?: EnvironmentPhase | undefined
    }
  | {
      readonly _tag: "Secret"
      readonly action: "revoke"
      readonly name: string
      readonly scope?: EnvironmentScope | undefined
    }
  | {
      readonly _tag: "ThreadService"
      readonly action: "ensure"
      readonly threadId: string
      readonly service: RepositoryService
    }
  | { readonly _tag: "ThreadService"; readonly action: "stop"; readonly threadId: string; readonly serviceId: string }
  | { readonly _tag: "ThreadPortal"; readonly threadId: string; readonly port: number }
  | {
      readonly _tag: "ThreadSync"
      readonly threadId: string
      readonly commitSha: string
      readonly targetBranch?: string | undefined
      readonly title: string
      readonly body: string
    }

export interface Interface {
  readonly run: (
    input: Input,
  ) => Effect.Effect<void, ProductOperation.InvalidInput | ProductOperation.OperationUnavailable>
}

export const Service = Context.Reference<Interface>("@rika/cli/command/HostedCommandService", {
  defaultValue: () => ({
    run: (input) =>
      Effect.fail(
        ProductOperation.OperationUnavailable.make({
          operation: input._tag,
          message: "Account commands are unavailable in this process",
        }),
      ),
  }),
})

export const dispatch = Effect.fn("HostedCommand.dispatch")(function* (input: Input) {
  const service = yield* Service
  yield* service
    .run(input)
    .pipe(Effect.mapError((error) => CliError.UserError.make({ cause: error, userMessage: error.message })))
})
