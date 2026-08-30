import { approvalTarget } from "@rika/execution"
import {
  BetterAuthUserId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  OrganizationId,
  OwnerId,
  ThreadId,
  WorkspaceId,
  type ActorAttribution,
  type HostedOwner,
} from "@rika/product/hosted-model"
import type * as ExecutionProjection from "@rika/product/execution-projection"
import {
  ToolPolicyStore,
  type AuditAppend,
  type AuditRecord,
  layer as toolPolicyStoreLayer,
} from "@rika/product-store/execution-tool-policy"
import type { AccessWire } from "@rika/remote-execution/protocol"
import { Crypto, Effect, Encoding, Layer, Schema } from "effect"
import type {
  HostedToolPolicy,
  HostedToolPolicyError,
  ToolAuditRecord,
  HostedToolPolicyService,
  ToolAdmissionContext,
  ToolAuditCheckpoint,
  ToolAuditExecutor,
} from "./tool-policy"

const executorOf = (access: AccessWire, kind: "runner" | "orb"): ToolAuditExecutor => ({
  kind,
  assignmentId: access.fence.assignmentId,
  generation: access.fence.assignmentGeneration,
  leaseEpoch: access.leaseEpoch,
  instanceId: access.fence.instanceId,
  executorId: access.fence.executorId,
  processIncarnation: access.fence.processIncarnation,
})

interface AuditOptional {
  decisionActor?: ActorAttribution
  authorizationId?: string
  authorizationCheckpoint?: ToolAuditCheckpoint
}

export const auditLayer = (dependencies: {
  readonly tag: typeof HostedToolPolicy
  readonly error: typeof HostedToolPolicyError
  readonly recordSchema: typeof ToolAuditRecord
  readonly canonical: (
    value:
      | Schema.Json
      | ActorAttribution
      | ToolAuditCheckpoint
      | { readonly runId: string; readonly approvalId: string },
  ) => string
}) => {
  const unavailable = () => dependencies.error.make({ kind: "unavailable", message: "Tool audit is unavailable" })
  const decodeStoreRecord = (record: AuditRecord) =>
    Schema.decodeUnknownEffect(dependencies.recordSchema)(record).pipe(Effect.mapError(unavailable))
  const hostedToolPolicyLayer = Layer.effect(
    dependencies.tag,
    Effect.gen(function* () {
      const store = yield* ToolPolicyStore
      const crypto = yield* Crypto.Crypto
      const digest = Effect.fn("HostedToolPolicy.digest")(function* (value: string) {
        return Encoding.encodeHex(yield* crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.orDie))
      })
      const append = Effect.fn("HostedToolPolicy.append")(function* <Phase extends AuditAppend["phase"]>(input: {
        readonly context: ToolAdmissionContext
        readonly phase: Phase
        readonly decisionActor?: ActorAttribution
        readonly authorizationId?: string
        readonly checkpoint?: ToolAuditCheckpoint
        readonly decision: ToolAuditRecord["decision"]
        readonly outcome: ToolAuditRecord["outcome"]
      }) {
        const value = input.context
        const optional: AuditOptional = {}
        if (input.decisionActor !== undefined) optional.decisionActor = input.decisionActor
        if (input.authorizationId !== undefined) optional.authorizationId = input.authorizationId
        if (input.checkpoint !== undefined) optional.authorizationCheckpoint = input.checkpoint
        return {
          auditGroupId: value.auditGroupId,
          phase: input.phase,
          ownerId: yield* Schema.decodeEffect(OwnerId)(value.ownerId),
          threadId: yield* Schema.decodeEffect(ThreadId)(value.threadId),
          turnId: value.turnId,
          actor: value.actor,
          ...optional,
          policy: value.policy,
          module: value.module,
          operation: value.operation,
          operationKey: value.operationKey,
          callId: value.callId,
          argumentsDigest: value.argumentsDigest,
          workspaceId: yield* Schema.decodeEffect(WorkspaceId)(value.workspaceId),
          repository: value.repository,
          branch: value.branch,
          executor: {
            ...value.executor,
            assignmentId: yield* Schema.decodeEffect(ExecutorAssignmentId)(value.executor.assignmentId),
            executorId: yield* Schema.decodeEffect(ExecutorInstanceId)(value.executor.executorId),
          },
          decision: input.decision,
          outcome: input.outcome,
        }
      }, Effect.mapError(unavailable))

      const insert = Effect.fn("HostedToolPolicy.insert")(function* (input: Parameters<typeof append>[0]) {
        yield* store.insertAudit(yield* append(input)).pipe(Effect.mapError(unavailable))
      })

      const begin: HostedToolPolicyService["begin"] = Effect.fn("HostedToolPolicy.begin")(function* (input) {
        const admission = yield* store
          .loadAdmissionContext({
            threadId: yield* Schema.decodeEffect(ThreadId)(input.threadId).pipe(Effect.mapError(unavailable)),
            turnId: input.turnId,
            workspaceId: yield* Schema.decodeEffect(WorkspaceId)(input.workspaceId).pipe(Effect.mapError(unavailable)),
            fence: {
              assignmentId: yield* Schema.decodeEffect(ExecutorAssignmentId)(input.access.fence.assignmentId).pipe(
                Effect.mapError(unavailable),
              ),
              target: input.access.fence.target,
              generation: input.access.fence.assignmentGeneration,
              leaseEpoch: input.access.leaseEpoch,
              providerInstanceId: input.access.fence.instanceId,
              executorInstanceId: yield* Schema.decodeEffect(ExecutorInstanceId)(input.access.fence.executorId).pipe(
                Effect.mapError(unavailable),
              ),
              processIncarnation: input.access.fence.processIncarnation,
            },
          })
          .pipe(Effect.mapError(unavailable))
        if (admission === undefined)
          return yield* dependencies.error.make({
            kind: "forbidden",
            message: "Tool admission no longer has authenticated Thread and executor authority",
          })
        const repository = admission.repositoryIdentity === null ? null : { identity: admission.repositoryIdentity }
        const executor = executorOf(input.access, admission.executorKind)
        const auditGroupId = yield* digest(
          dependencies.canonical({
            ownerId: admission.ownerId,
            threadId: input.threadId,
            turnId: input.turnId,
            actor: admission.actor,
            policy: input.policy,
            module: input.request.module,
            operation: input.request.operation,
            operationKey: input.operationKey,
            callId: input.callId,
            argumentsDigest: input.argumentsDigest,
            workspaceId: input.workspaceId,
            repository,
            branch: admission.branch,
            executor,
          }),
        )
        const context: ToolAdmissionContext = {
          auditGroupId,
          ownerId: admission.ownerId,
          threadId: input.threadId,
          turnId: input.turnId,
          actor: admission.actor,
          policy: input.policy,
          module: input.request.module,
          operation: input.request.operation,
          operationKey: input.operationKey,
          callId: input.callId,
          argumentsDigest: input.argumentsDigest,
          workspaceId: input.workspaceId,
          repository,
          branch: admission.branch,
          executor,
        }
        yield* insert({
          context,
          phase: "admission",
          decision: input.policy.approval === "exact" ? "pending" : "not-required",
          outcome: "admitted",
        })
        return context
      })

      const outcome: HostedToolPolicyService["outcome"] = Effect.fn("HostedToolPolicy.outcome")(function* (input) {
        const decision = input.policy.approval === "exact" ? "pending" : "not-required"
        yield* input.authorizationId === undefined
          ? insert({ context: input, phase: "outcome", decision, outcome: input.outcome })
          : insert({
              context: input,
              phase: "outcome",
              authorizationId: input.authorizationId,
              decision,
              outcome: input.outcome,
            })
      })

      const checkpoint = Effect.fn("HostedToolPolicy.checkpoint")(function* (
        value: ExecutionProjection.Checkpoint,
      ): Effect.fn.Return<ToolAuditCheckpoint> {
        return { version: value.version, cursor: value.cursor, digest: yield* digest(dependencies.canonical(value)) }
      })

      const recordDecision: HostedToolPolicyService["recordDecision"] = Effect.fn("HostedToolPolicy.recordDecision")(
        function* (input) {
          const ownerId = yield* Schema.decodeEffect(OwnerId)(input.ownerId).pipe(Effect.mapError(unavailable))
          const threadId = yield* Schema.decodeEffect(ThreadId)(input.threadId).pipe(Effect.mapError(unavailable))
          const records = yield* store
            .listAuthorizationRecords({
              ownerId,
              threadId,
              turnId: input.turnId,
              authorizationId: input.authorizationId,
            })
            .pipe(Effect.mapError(unavailable))
          const source = records[0]
          if (source === undefined)
            return yield* dependencies.error.make({
              kind: "conflict",
              message: "Authorization has no matching admitted tool operation",
            })
          const record = yield* decodeStoreRecord(source)
          const context: ToolAdmissionContext = {
            auditGroupId: record.auditGroupId,
            ownerId: record.ownerId,
            threadId: record.threadId,
            turnId: record.turnId,
            actor: record.actor,
            policy: record.policy,
            module: record.module,
            operation: record.operation,
            operationKey: record.operationKey,
            callId: record.callId,
            argumentsDigest: record.argumentsDigest,
            workspaceId: record.workspaceId,
            repository: record.repository,
            branch: record.branch,
            executor: record.executor,
          }
          const expectedCheckpoint = yield* checkpoint(input.checkpoint)
          const expectedTarget = approvalTarget(input.checkpoint, input.authorizationId)
          if (expectedTarget === undefined)
            return yield* dependencies.error.make({
              kind: "conflict",
              message: "Authorization checkpoint does not contain the admitted operation",
            })
          const result = yield* store
            .appendDecision({
              record: {
                ...(yield* append({
                  context,
                  phase: "decision",
                  decisionActor: input.actor,
                  authorizationId: input.authorizationId,
                  checkpoint: expectedCheckpoint,
                  decision: input.decision,
                  outcome: "admitted",
                })),
                phase: "decision",
                authorizationId: input.authorizationId,
              },
              expectedProjector: {
                version: input.checkpoint.version,
                runId: expectedTarget.runId,
                approvalId: expectedTarget.approvalId,
              },
            })
            .pipe(Effect.mapError(unavailable))
          if (result === "conflict")
            return yield* dependencies.error.make({
              kind: "conflict",
              message: "Authorization already has a different decision",
            })
        },
      )

      const list: HostedToolPolicyService["list"] = Effect.fn("HostedToolPolicy.list")(function* (input) {
        const principalUserId = yield* Schema.decodeEffect(BetterAuthUserId)(input.principal.userId).pipe(
          Effect.mapError(unavailable),
        )
        const ownerId = yield* store
          .resolveOwner({ principalUserId, owner: input.owner })
          .pipe(Effect.mapError(unavailable))
        if (ownerId === undefined)
          return yield* dependencies.error.make({ kind: "forbidden", message: "Audit owner is unavailable" })
        const records = yield* store
          .listInspectionRecords({ ownerId, principalUserId, limit: input.limit })
          .pipe(Effect.mapError(unavailable))
        return yield* Effect.forEach(records, decodeStoreRecord)
      })
      return dependencies.tag.of({ begin, outcome, recordDecision, list })
    }),
  )
  return hostedToolPolicyLayer.pipe(Layer.provide(toolPolicyStoreLayer))
}
export const personalOwner = (userId: string): HostedOwner => ({
  _tag: "PersonalOwner",
  userId: BetterAuthUserId.make(userId),
})
export const organizationOwner = (organizationId: string): HostedOwner => ({
  _tag: "OrganizationOwner",
  organizationId: OrganizationId.make(organizationId),
})
