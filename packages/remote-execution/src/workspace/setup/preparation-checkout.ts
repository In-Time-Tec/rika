import { Clock, Effect, Option } from "effect"
import type { RepositoryCheckoutWire } from "../../protocol/messages"
import { WorkspaceError } from "../error"
import type { PreparationContext } from "./preparation-context"
import type { Marker, Options } from "./preparation-contracts"

const previousMarker = Effect.fn("Workspace.previousMarker")(function* (
  context: PreparationContext,
  options: Options,
  known: Marker | undefined,
) {
  const { assignment } = context
  if (assignment.cold) {
    if (known === undefined)
      return yield* WorkspaceError.make({
        phase: "checkout",
        message: "Cold workspace is missing its preparation marker",
        retryable: false,
      })
  } else if (known === undefined || known.lastWakeId !== assignment.wakeId) return undefined
  yield* context.verify(known)
  if (known.setupState === "failed" && !assignment.retry)
    return yield* WorkspaceError.make({
      phase: "setup",
      message: "Workspace setup failed previously; retry it explicitly",
      retryable: true,
    })
  return known
})

const cloneCheckout = Effect.fn("Workspace.cloneCheckout")(function* (
  context: PreparationContext,
  options: Options,
  checkout: RepositoryCheckoutWire,
) {
  const checkoutRoot = `${context.workspaceParent}/.rika-checkout-${context.assignmentDigest}-g${context.assignment.access.fence.assignmentGeneration}`
  yield* context.fileSystem.remove(checkoutRoot, { recursive: true, force: true })
  yield* Effect.gen(function* () {
    if (checkout.private) yield* context.acquireCredential("git-read")
    const environment = {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: `${context.credentialRoot}/git-credential-rika`,
      GIT_CONFIG_KEY_1: "credential.useHttpPath",
      GIT_CONFIG_VALUE_1: "true",
    }
    const clone = yield* context
      .command(
        [
          ...context.workspaceCommandPrefix,
          "env",
          ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
          "git",
          "clone",
          "--filter=blob:none",
          "--no-checkout",
          `https://github.com/${checkout.owner}/${checkout.name}.git`,
          checkoutRoot,
        ],
        context.workspaceParent,
        context.workspaceEnvironment,
        context.report("checkout"),
      )
      .pipe(Effect.timeoutOption("5 minutes"))
    if (Option.isNone(clone) || clone.value.code !== 0)
      return yield* WorkspaceError.make({ phase: "checkout", message: "Repository clone failed", retryable: true })
    const checkoutResult = yield* context.runAsWorkspace(
      "checkout",
      ["git", "-C", checkoutRoot, "checkout", "--detach", checkout.commitSha],
      5 * 60 * 1_000,
      checkoutRoot,
    )
    if (checkoutResult.code !== 0)
      return yield* WorkspaceError.make({
        phase: "checkout",
        message: "Repository commit checkout failed",
        retryable: true,
      })
    yield* context.configureRepository(checkout, checkoutRoot)
    const verified = yield* Effect.all([
      context.runAsWorkspace("checkout", ["git", "-C", checkoutRoot, "rev-parse", "HEAD"], 30_000, checkoutRoot),
      context.runAsWorkspace(
        "checkout",
        ["git", "-C", checkoutRoot, "remote", "get-url", "origin"],
        30_000,
        checkoutRoot,
      ),
    ])
    if (
      verified[0].code !== 0 ||
      verified[0].output.trim() !== checkout.commitSha ||
      verified[1].code !== 0 ||
      verified[1].output.trim() !== `https://github.com/${checkout.owner}/${checkout.name}.git`
    )
      return yield* WorkspaceError.make({
        phase: "checkout",
        message: "Repository checkout verification failed",
        retryable: false,
      })
    if (checkout.private) {
      yield* options.revoke("git-read")
      yield* context.clearCredential()
    }
    yield* context.fileSystem.rename(checkoutRoot, context.root)
  }).pipe(
    Effect.tapError(() =>
      Effect.all(
        [
          context.fileSystem.remove(checkoutRoot, { recursive: true, force: true }),
          options.revoke("git-read").pipe(Effect.ignore),
          context.clearCredential().pipe(Effect.ignore),
        ],
        { discard: true },
      ),
    ),
  )
})

const createCheckout = Effect.fn("Workspace.createCheckout")(function* (context: PreparationContext, options: Options) {
  yield* context.fileSystem.makeDirectory(context.workspaceParent, { recursive: true, mode: 0o750 })
  if (context.assignment.checkout !== null) yield* cloneCheckout(context, options, context.assignment.checkout)
  else {
    const created = yield* context.runAsWorkspace(
      "checkout",
      ["install", "-d", "-m", "0750", context.root],
      30_000,
      context.workspaceParent,
    )
    if (created.code !== 0)
      return yield* WorkspaceError.make({
        phase: "checkout",
        message: "Workspace directory creation failed",
        retryable: true,
      })
  }
})

const createMarker = Effect.fn("Workspace.createMarker")(function* (context: PreparationContext, options: Options) {
  const setupCommit = context.assignment.checkout?.commitSha ?? null
  const startedAt = yield* Clock.currentTimeMillis
  const marker: Marker = {
    version: 2,
    assignmentId: context.assignment.access.fence.assignmentId,
    assignmentGeneration: context.assignment.access.fence.assignmentGeneration,
    workspaceId: context.assignment.workspaceId,
    templateBuildId: context.assignment.templateBuildId,
    kernelProfileDigest: options.kernel.profileDigest,
    bindingContractDigest: options.kernel.bindingContractDigest,
    repositoryId: context.assignment.checkout?.repositoryId ?? null,
    commitSha: setupCommit,
    setupState: "failed",
    setup: {
      digest: null,
      commitSha: setupCommit,
      buildDigest: context.buildDigest,
      environmentDigest: context.environmentDigest,
      startedAt,
      finishedAt: yield* Clock.currentTimeMillis,
      outcome: "missing",
    },
    resume: null,
    lastWakeId: context.assignment.wakeId,
  }
  yield* context.writeMarker(marker)
  return marker
})

export const initializeCheckout = Effect.fn("Workspace.initializeCheckout")(function* (
  context: PreparationContext,
  options: Options,
) {
  yield* context.fileSystem.makeDirectory(context.markerDirectory, { recursive: true, mode: 0o700 })
  const known = yield* context.readMarker()
  yield* options.reporter.started("checkout")
  const previous = yield* previousMarker(context, options, known)
  if (previous !== undefined) return previous
  if (
    known !== undefined ||
    (yield* context.fileSystem.stat(context.root).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ))
  )
    return yield* WorkspaceError.make({
      phase: "checkout",
      message: "Fresh workspace contains stale or partial checkout state",
      retryable: false,
    })
  yield* createCheckout(context, options)
  return yield* createMarker(context, options)
})

export const startCredentials = Effect.fn("Workspace.startCredentials")(function* (context: PreparationContext) {
  const checkout = context.assignment.checkout
  if (checkout === null) return
  if (checkout.private) {
    const credential = yield* context.acquireCredential("git-read")
    yield* context.startRefresh("git-read", credential)
  }
  const credential = yield* context.acquireCredential("github-read")
  yield* context.startRefresh("github-read", credential)
})
