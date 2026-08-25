import { Context, Effect, Schema } from "effect"
import type { Access } from "./executor-assignments"
import { FencingGeneration, OwnerId, WorkspaceId } from "./model"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const KernelProfileDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Output = Schema.String.check(Schema.isMaxLength(16_384))

export const WorkspacePreparationPhase = Schema.Literals(["checkout", "setup", "resume", "capabilities"])
export type WorkspacePreparationPhase = typeof WorkspacePreparationPhase.Type

export const HookOutcome = Schema.Literals(["missing", "completed", "continued"])
export type HookOutcome = typeof HookOutcome.Type

export const HookEvidence = Schema.Struct({
  digest: Schema.NullOr(Digest),
  commitSha: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  buildDigest: Digest,
  environmentDigest: Digest,
  startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  finishedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: HookOutcome,
})
export type HookEvidence = typeof HookEvidence.Type

export const WorkspacePreparationEvidence = Schema.Struct({
  workspaceId: WorkspaceId,
  repositoryId: Schema.NullOr(Identifier),
  commitSha: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  kernelProfileDigest: KernelProfileDigest,
  bindingContractDigest: KernelProfileDigest,
  setup: HookEvidence,
  resume: Schema.NullOr(HookEvidence),
  capabilities: Schema.Array(Identifier).check(Schema.isMaxLength(32)),
})
export type WorkspacePreparationEvidence = typeof WorkspacePreparationEvidence.Type

export const WorkspacePreparation = Schema.Struct({
  assignmentId: Identifier,
  ownerId: OwnerId,
  workspaceId: WorkspaceId,
  generation: FencingGeneration,
  leaseEpoch: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  state: Schema.Literals(["preparing", "ready", "failed"]),
  phase: WorkspacePreparationPhase,
  evidence: Schema.NullOr(WorkspacePreparationEvidence),
  failure: Schema.NullOr(
    Schema.Struct({
      message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
      retryable: Schema.Boolean,
    }),
  ),
  startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  updatedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  deadlineAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type WorkspacePreparation = typeof WorkspacePreparation.Type

export interface PreparationAttempt {
  readonly access: Access
  readonly workspaceId: string
  readonly phase: WorkspacePreparationPhase
  readonly attempt: number
  readonly now: number
}

export interface PreparationStart extends PreparationAttempt {
  readonly deadlineAt: number
}

export interface PreparationOutput {
  readonly access: Access
  readonly phase: WorkspacePreparationPhase
  readonly attempt: number
  readonly stream: "stdout" | "stderr"
  readonly text: string
  readonly redacted: true
  readonly truncated: boolean
  readonly now: number
}

export interface WorkspacePreparationsService {
  readonly start: (input: PreparationStart) => Effect.Effect<WorkspacePreparation, WorkspacePreparationError>
  readonly appendOutput: (input: PreparationOutput) => Effect.Effect<void, WorkspacePreparationError>
  readonly complete: (
    input: PreparationAttempt & { readonly evidence: WorkspacePreparationEvidence },
  ) => Effect.Effect<WorkspacePreparation, WorkspacePreparationError>
  readonly fail: (
    input: PreparationAttempt & { readonly message: string; readonly retryable: boolean },
  ) => Effect.Effect<WorkspacePreparation, WorkspacePreparationError>
  readonly retryAttempt: (access: Access) => Effect.Effect<number, WorkspacePreparationError>
  readonly requireReady: (access: Access) => Effect.Effect<WorkspacePreparation, WorkspacePreparationError>
  readonly expireOverdue: (now: number) => Effect.Effect<number, WorkspacePreparationError>
}

export class WorkspacePreparationError extends Schema.TaggedError<WorkspacePreparationError>()(
  "WorkspacePreparationError",
  {
    reason: Schema.Literals(["conflict", "database", "invalid", "not-found", "stale-fence"]),
    message: Schema.String,
  },
) {}

export class WorkspacePreparations extends Context.Service<WorkspacePreparations, WorkspacePreparationsService>()(
  "@rika/product/hosted/workspace-preparation/WorkspacePreparations",
) {}

export const boundedPreparationOutput = (text: string) => ({
  text: text.slice(0, 16_384) as typeof Output.Type,
  truncated: text.length > 16_384,
})
