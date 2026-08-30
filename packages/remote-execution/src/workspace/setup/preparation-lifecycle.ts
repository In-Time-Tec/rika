import { Clock, Effect } from "effect"
import type { WorkspacePreparationEvidenceWire } from "../../protocol/messages"
import { encodeArchive, hookDigest as readHookDigest, type SetupCacheKey } from "../artifact/archive"
import { createArchive } from "../artifact/archive-upload"
import { archiveFailure, resetCheckout, restoreWorkspace } from "./preparation-archive"
import type { PreparationContext } from "./preparation-context"
import type { Marker, Options } from "./preparation-contracts"
import { inspectCapabilities, runHook } from "./preparation-hooks"

interface PreparationState {
  readonly marker: Marker
  readonly setupHookDigest: string
  readonly restoredCheckpointId: string | null
  readonly restoredCache: boolean
}

const setupCacheKey = (
  context: PreparationContext,
  options: Options,
  setupHookDigest: string,
): SetupCacheKey | undefined => {
  const checkout = context.assignment.checkout
  if (options.setupCache === undefined || checkout === null) return undefined
  return Object.assign(
    {
      ownerId: options.setupCache.ownerId,
      repository: {
        repositoryId: checkout.repositoryId,
        owner: checkout.owner,
        name: checkout.name,
        commitSha: checkout.commitSha,
      },
      setupHookDigest,
      templateBuildId: context.assignment.templateBuildId,
      environmentDigest: context.authorizedEnvironmentDigest,
    },
    options.seed === undefined ? undefined : { workspaceSeedDigest: options.seed.archive.contentDigest },
  )
}

const restoreSetup = Effect.fn("Workspace.restoreSetup")(function* (
  context: PreparationContext,
  options: Options,
  marker: Marker,
  cacheKey: SetupCacheKey | undefined,
) {
  let restoredCheckpointId: string | null = null
  let restoredCache = false
  if (options.restore !== undefined) {
    yield* restoreWorkspace(context, options.restore.archive)
    yield* context.verify(marker)
    restoredCheckpointId = options.restore.checkpointId
  } else if (cacheKey !== undefined && marker.setupState !== "completed" && !context.assignment.retry) {
    const cached = yield* options.setupCache!.load(cacheKey).pipe(Effect.catchCause(() => Effect.succeed(null)))
    if (cached !== null) {
      restoredCache = yield* restoreWorkspace(context, cached).pipe(
        Effect.andThen(context.verify(marker)),
        Effect.as(true),
        Effect.catch(() => resetCheckout(context, context.assignment.checkout!).pipe(Effect.as(false))),
      )
    }
  }
  return { restoredCheckpointId, restoredCache }
})

const recordRestoredSetup = Effect.fn("Workspace.recordRestoredSetup")(function* (
  context: PreparationContext,
  marker: Marker,
  restored: boolean,
  initialDigest: string,
) {
  if (!restored) return { marker, setupHookDigest: initialDigest }
  const setupHookDigest = yield* setupDigest(context, "Restored setup hook could not be verified")
  const restoredAt = yield* Clock.currentTimeMillis
  const updated: Marker = {
    ...marker,
    setupState: "completed",
    setup: {
      digest: setupHookDigest,
      commitSha: context.assignment.checkout?.commitSha ?? null,
      buildDigest: context.buildDigest,
      environmentDigest: context.environmentDigest,
      startedAt: restoredAt,
      finishedAt: restoredAt,
      outcome: "completed",
    },
  }
  yield* context.writeMarker(updated)
  return { marker: updated, setupHookDigest }
})

const setupDigest = (context: PreparationContext, message: string) =>
  readHookDigest(context.root, "setup").pipe(Effect.mapError(() => archiveFailure(message)))

const storeSetupCache = (context: PreparationContext, options: Options, cacheKey: SetupCacheKey | undefined) => {
  if (cacheKey === undefined) return Effect.void
  const archiveSecrets = new Set(options.secretValues ?? [])
  for (const secret of context.secrets) archiveSecrets.add(secret)
  return createArchive(context.root, archiveSecrets).pipe(
    Effect.map(encodeArchive),
    Effect.flatMap((archive) => options.setupCache!.store(cacheKey, archive)),
    Effect.ignoreCause,
  )
}

const runSetup = Effect.fn("Workspace.runSetup")(function* (
  context: PreparationContext,
  options: Options,
  marker: Marker,
  cacheKey: SetupCacheKey | undefined,
) {
  if (marker.setupState === "completed" && !context.assignment.retry) return marker
  const setup = yield* runHook(
    context,
    "setup",
    context.assignment.checkout?.commitSha ?? null,
    options.setupTimeout ?? 20 * 60 * 1_000,
  ).pipe(Effect.tapError(() => context.writeMarker({ ...marker, setupState: "failed" })))
  const updated: Marker = { ...marker, setupState: "completed", setup }
  yield* context.writeMarker(updated)
  yield* storeSetupCache(context, options, cacheKey)
  return updated
})

export const prepareSetup = Effect.fn("Workspace.prepareSetup")(function* (
  context: PreparationContext,
  options: Options,
  marker: Marker,
) {
  const initialDigest = yield* setupDigest(context, "Workspace setup hook could not be verified")
  const cacheKey = setupCacheKey(context, options, initialDigest)
  const restoration = yield* restoreSetup(context, options, marker, cacheKey)
  const restored = restoration.restoredCheckpointId !== null || restoration.restoredCache
  const recorded = yield* recordRestoredSetup(context, marker, restored, initialDigest)
  const setupMarker = yield* runSetup(context, options, recorded.marker, cacheKey)
  return {
    marker: setupMarker,
    setupHookDigest: recorded.setupHookDigest,
    ...restoration,
  } satisfies PreparationState
})

export const resumeAndEvidence = Effect.fn("Workspace.resumeAndEvidence")(function* (
  context: PreparationContext,
  options: Options,
  state: PreparationState,
) {
  let marker = state.marker
  if (
    state.restoredCheckpointId !== null ||
    state.restoredCache ||
    (context.assignment.cold && marker.lastWakeId !== context.assignment.wakeId)
  ) {
    const resume = yield* runHook(
      context,
      "resume",
      context.assignment.checkout?.commitSha ?? null,
      options.resumeTimeout ?? 24 * 60 * 60 * 1_000,
      options.resumeBlockingWindow ?? 10_000,
    )
    marker = { ...marker, resume, lastWakeId: context.assignment.wakeId }
    yield* context.writeMarker(marker)
  }
  const capabilities = yield* inspectCapabilities(context, options)
  return {
    workspaceId: context.assignment.workspaceId,
    repositoryId: context.assignment.checkout?.repositoryId ?? null,
    commitSha: context.assignment.checkout?.commitSha ?? null,
    kernelProfileDigest: options.kernel.profileDigest,
    bindingContractDigest: options.kernel.bindingContractDigest,
    setup: marker.setup,
    resume: marker.resume,
    capabilities,
    lifecycle: {
      environmentDigest: context.authorizedEnvironmentDigest,
      templateBuildId: context.assignment.templateBuildId,
      setupHookDigest: state.setupHookDigest,
      restoredCheckpointId: state.restoredCheckpointId,
    },
  } satisfies WorkspacePreparationEvidenceWire
})
