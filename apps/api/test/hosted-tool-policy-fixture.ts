import { Effect } from "effect"
import type { ActorAttribution } from "@rika/product/hosted-model"
import type { HostedToolPolicyService, ToolAuditExecutor } from "../src/hosted-tool-policy"

const actor = {
  _tag: "PersonalActor",
  owner: { _tag: "PersonalOwner", userId: "user-test" },
  userId: "user-test",
  clientId: "client-test",
  deviceId: "device-test",
} as ActorAttribution

export const testToolPolicy: HostedToolPolicyService = {
  begin: (input) =>
    Effect.succeed({
      auditGroupId: "0".repeat(64),
      ownerId: "owner-test",
      threadId: input.threadId,
      turnId: input.turnId,
      actor,
      policy: input.policy,
      module: input.request.module,
      operation: input.request.operation,
      operationKey: input.operationKey,
      callId: input.callId,
      argumentsDigest: input.argumentsDigest,
      workspaceId: input.workspaceId,
      repository: { identity: "test/repository" },
      branch: "test",
      executor: {
        kind: input.access.fence.target,
        assignmentId: input.access.fence.assignmentId,
        generation: input.access.fence.assignmentGeneration,
        leaseEpoch: input.access.leaseEpoch,
        instanceId: input.access.fence.instanceId,
        executorId: input.access.fence.executorId,
        processIncarnation: input.access.fence.processIncarnation,
      } satisfies ToolAuditExecutor,
    }),
  outcome: () => Effect.void,
  recordDecision: () => Effect.void,
  list: () => Effect.succeed([]),
}
