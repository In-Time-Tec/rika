import { Effect, Schema } from "effect"
import { CredentialBroker } from "./credential-broker"
import { WorkspaceError } from "./error"
import { restoreWorkspace } from "./setup/preparation-archive"
import { initializeCheckout, startCredentials } from "./setup/preparation-checkout"
import { preparationContext } from "./setup/preparation-context"
import type { Options } from "./setup/preparation-contracts"
import { prepareSetup, resumeAndEvidence } from "./setup/preparation-lifecycle"

const readOnlyGhWrapper = CredentialBroker.readOnlyGhWrapper

export {
  EphemeralCredentialRoot,
  pushApprovedBranch,
  RemoteRepositoryRoot,
  type BranchPushOptions,
} from "./branch-publication"
export type { Credential } from "./credential-broker"
export { WorkspaceError } from "./error"
export type { Assignment, KernelIdentity, Options, Reporter } from "./setup/preparation-contracts"

const make = Effect.fn("Workspace.make")(function* (options: Options) {
  const context = yield* preparationContext(options)
  const marker = yield* initializeCheckout(context, options)
  if (!context.assignment.cold && options.seed !== undefined && options.restore === undefined)
    yield* restoreWorkspace(context, options.seed.archive)
  yield* startCredentials(context)
  const state = yield* prepareSetup(context, options, marker)
  return yield* resumeAndEvidence(context, options, state)
})

export const prepare = Effect.fn("Workspace.prepare")(function* (options: Options) {
  return yield* make(options).pipe(
    Effect.mapError((error) =>
      Schema.is(WorkspaceError)(error)
        ? error
        : WorkspaceError.make({
            phase: "capabilities",
            message: "Workspace filesystem preparation failed",
            retryable: true,
          }),
    ),
  )
})

export const testing = { readOnlyGhWrapper } as const
