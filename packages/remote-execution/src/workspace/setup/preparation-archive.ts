import { Effect } from "effect"
import type { EncodedArchive, RepositoryCheckoutWire } from "../../protocol/messages"
import { decodeArchive, restoreArchive } from "../artifact/archive"
import { WorkspaceError } from "../error"
import type { PreparationContext } from "./preparation-context"

export const archiveFailure = (message: string) => WorkspaceError.make({ phase: "checkout", message, retryable: false })

export const restoreWorkspace = Effect.fn("Workspace.restore")(function* (
  context: PreparationContext,
  archive: EncodedArchive,
) {
  const decoded = yield* decodeArchive(archive).pipe(
    Effect.mapError(() => archiveFailure("Workspace archive verification failed")),
  )
  yield* restoreArchive(context.root, decoded, context.workspaceCommandPrefix).pipe(
    Effect.mapError(() => archiveFailure("Workspace archive restoration failed")),
  )
})

export const resetCheckout = Effect.fn("Workspace.resetCheckout")(function* (
  context: PreparationContext,
  checkout: RepositoryCheckoutWire,
) {
  const result = yield* context.command(
    [
      ...context.workspaceCommandPrefix,
      "bash",
      "-ceu",
      'find "$1" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +; git -C "$1" reset --hard "$2"; git -C "$1" clean -ffdx',
      "rika-cache-reset",
      context.root,
      checkout.commitSha,
    ],
    context.root,
    context.workspaceEnvironment,
    context.report("checkout"),
  )
  if (result.code !== 0)
    return yield* WorkspaceError.make({
      phase: "checkout",
      message: "Workspace could not recover from an invalid setup cache",
      retryable: true,
    })
})
