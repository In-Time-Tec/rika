import type { WorkspaceBinding } from "@rika/execution"
import { Effect, Layer, Schema } from "effect"
import { NestedOperation, ToolContext } from "generalist"

import {
  BoxId,
  LifecyclePolicy,
  OrbWorkspaceBinding,
  PrepareIntent,
  ResumeIntent,
  SnapshotReference,
  idempotencyWindowMillis,
  type BoxId as BoxIdType,
  type OrbWorkspaceBinding as OrbWorkspaceBindingType,
} from "../../src/contract"
import type { BoxProviderService } from "../../src/provider"

export const sourceBoxId = Schema.decodeSync(BoxId)("bx_23456789")
export const preparedBoxId = Schema.decodeSync(BoxId)("bx_abcdefgh")
export const forkedBoxId = Schema.decodeSync(BoxId)("bx_jkmnpqrs")
export const snapshot = Schema.decodeSync(SnapshotReference)({
  id: "7417be09-d419-4ae0-b3fc-7f04a5a71ef1",
  boxId: sourceBoxId,
  generation: 3,
  completedAt: "2026-09-09T12:00:00Z",
  sizeBytes: 1_024,
  fileCount: 12,
})

const binding = (
  workspaceId: string,
  assignmentId: string,
  generation: number,
  lineageId: string,
): OrbWorkspaceBindingType =>
  Schema.decodeSync(OrbWorkspaceBinding)({
    workspaceId,
    assignmentId,
    generation,
    placement: { _tag: "Orb", workspaceId, lineageId },
    buildId: "executor-build-v2",
    protocolVersion: 1,
  })

export const sourceBinding = binding("workspace-source", "assignment-source-1", 1, "lineage-source")
export const preparedBinding = binding("workspace-prepared", "assignment-prepared-1", 1, "lineage-prepared")
export const resumedBinding = binding("workspace-source", "assignment-source-2", 2, "lineage-source")
export const forkedBinding = binding("workspace-fork", "assignment-fork-1", 1, "lineage-fork")

export const policy = Schema.decodeSync(LifecyclePolicy)({
  template: { sourceBoxId, snapshotId: snapshot.id },
  ttlSeconds: 3_600,
  readinessAttempts: 3,
  readinessDelayMillis: 0,
})

export const readyBox = (id: BoxIdType) => ({
  id,
  state: "ready" as const,
  snapshotAvailable: id === sourceBoxId,
  setupStatus: null,
  environment: null,
})

export const archivedSource = {
  id: sourceBoxId,
  state: "archived" as const,
  snapshotAvailable: true,
  snapshotCompletedAt: snapshot.completedAt,
  setupStatus: null,
  environment: null,
}

export const baseProvider = (forkIds: ReadonlyArray<BoxIdType> = [preparedBoxId]): BoxProviderService => {
  let forkIndex = 0
  return {
    create: () => Effect.die("create is not used by pinned lifecycle preparation"),
    fork: () => {
      const id = forkIds[Math.min(forkIndex, forkIds.length - 1)] ?? preparedBoxId
      forkIndex += 1
      return Effect.succeed(readyBox(id))
    },
    resume: (request) => Effect.succeed(readyBox(request.boxId)),
    stop: (request) => Effect.succeed({ ...archivedSource, id: request.boxId }),
    get: (boxId) => Effect.succeed(boxId === sourceBoxId ? archivedSource : readyBox(boxId)),
    latestSnapshot: (boxId) => Effect.succeed(boxId === sourceBoxId ? snapshot : null),
  }
}

export const checkpoint = {
  quiesce: () => Effect.void,
  flush: () => Effect.void,
}

export const contextLayer = (operationKey: string) =>
  Layer.merge(
    NestedOperation.layerDirect,
    ToolContext.layerTest({
      signal: new AbortController().signal,
      emit: () => Effect.succeed(true),
      sessionId: "session-box-lifecycle",
      runId: `run-${operationKey}`,
      operationKey,
    }),
  )

export const prepareIntent = () =>
  Schema.decodeSync(PrepareIntent)({
    _tag: "Prepare",
    intentId: "prepare-intent-1",
    acceptedInputId: "accepted-input-1",
    template: policy.template,
    binding: preparedBinding,
    request: {
      sourceBoxId,
      idempotencyKey: "prepare-key-1",
      issuedAtMillis: 0,
      expiresAtMillis: idempotencyWindowMillis,
      body: { noEnv: true, env: {}, ttlSeconds: policy.ttlSeconds },
    },
  })

export const resumeIntent = () =>
  Schema.decodeSync(ResumeIntent)({
    _tag: "Resume",
    intentId: "resume-preparation-1",
    source: { boxId: sourceBoxId, binding: sourceBinding, snapshot },
    binding: resumedBinding,
    request: { boxId: sourceBoxId, body: { noEnv: true, env: {}, ttlSeconds: 3_600 } },
  })

export type { WorkspaceBinding }
