import { Effect } from "effect"

import {
  type ForkIntent as ForkIntentType,
  type LifecyclePolicy as LifecyclePolicyType,
  type OrbWorkspaceBinding,
  type PrepareIntent as PrepareIntentType,
  type ResumeIntent as ResumeIntentType,
  type StopIntent as StopIntentType,
  type WorkspaceLifecycleError,
  idempotencyWindowMillis,
} from "./contract"

type LifecycleError = (
  operation: WorkspaceLifecycleError["operation"],
  kind: WorkspaceLifecycleError["kind"],
  message: string,
) => WorkspaceLifecycleError

const bindingIsFreshResume = (source: OrbWorkspaceBinding, next: OrbWorkspaceBinding): boolean =>
  source.workspaceId === source.placement.workspaceId &&
  next.workspaceId === next.placement.workspaceId &&
  source.workspaceId === next.workspaceId &&
  source.placement.lineageId === next.placement.lineageId &&
  source.assignmentId !== next.assignmentId &&
  next.generation > source.generation

const bindingIsFreshFork = (source: OrbWorkspaceBinding, next: OrbWorkspaceBinding): boolean =>
  source.workspaceId === source.placement.workspaceId &&
  next.workspaceId === next.placement.workspaceId &&
  source.workspaceId !== next.workspaceId &&
  source.placement.lineageId !== next.placement.lineageId &&
  source.assignmentId !== next.assignmentId

const validBillableWindow = (request: { readonly issuedAtMillis: number; readonly expiresAtMillis: number }): boolean =>
  request.expiresAtMillis - request.issuedAtMillis === idempotencyWindowMillis

const validSafeBody = (
  body: { readonly noEnv: true; readonly env: Readonly<Record<string, string>>; readonly ttlSeconds: number },
  policy: LifecyclePolicyType,
): boolean => body.noEnv && Object.keys(body.env).length === 0 && body.ttlSeconds === policy.ttlSeconds

const bindingIsConsistent = (binding: OrbWorkspaceBinding): boolean =>
  binding.workspaceId === binding.placement.workspaceId

export const lifecycleValidation = {
  prepare: (lifecycleError: LifecycleError, policy: LifecyclePolicyType, intent: PrepareIntentType) => {
    if (
      intent.template.sourceBoxId !== policy.template.sourceBoxId ||
      intent.template.snapshotId !== policy.template.snapshotId ||
      intent.request.sourceBoxId !== intent.template.sourceBoxId
    )
      return Effect.fail(
        lifecycleError("prepare", "template-mismatch", "Prepare intent does not use the configured pin"),
      )
    if (
      !bindingIsConsistent(intent.binding) ||
      !validBillableWindow(intent.request) ||
      !validSafeBody(intent.request.body, policy)
    )
      return Effect.fail(lifecycleError("prepare", "invalid-intent", "Prepare intent violates Box safety policy"))
    return Effect.succeed(intent)
  },
  stop: (lifecycleError: LifecycleError, intent: StopIntentType) =>
    bindingIsConsistent(intent.binding) && intent.boxId === intent.request.boxId && !intent.request.body.force
      ? Effect.succeed(intent)
      : Effect.fail(lifecycleError("stop", "invalid-intent", "Stop intent does not match its Box or is destructive")),
  resume: (lifecycleError: LifecycleError, policy: LifecyclePolicyType, intent: ResumeIntentType) => {
    if (
      intent.source.boxId !== intent.source.snapshot.boxId ||
      intent.request.boxId !== intent.source.boxId ||
      !bindingIsFreshResume(intent.source.binding, intent.binding) ||
      !validSafeBody(intent.request.body, policy)
    )
      return Effect.fail(lifecycleError("resume", "invalid-intent", "Resume intent does not carry a fresh safe fence"))
    return Effect.succeed(intent)
  },
  fork: (lifecycleError: LifecycleError, policy: LifecyclePolicyType, intent: ForkIntentType) => {
    if (
      intent.source.boxId !== intent.source.snapshot.boxId ||
      intent.request.sourceBoxId !== intent.source.boxId ||
      !bindingIsFreshFork(intent.source.binding, intent.binding) ||
      !validBillableWindow(intent.request) ||
      !validSafeBody(intent.request.body, policy)
    )
      return Effect.fail(lifecycleError("fork", "invalid-intent", "Fork intent does not carry distinct safe lineage"))
    return Effect.succeed(intent)
  },
}
