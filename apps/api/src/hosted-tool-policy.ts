import * as PgClient from "@effect/sql-pg/PgClient"
import type { AccessWire, BindingRequest } from "@rika/remote-execution/protocol"
import type { BindingOutcome, BindingResponse } from "@rika/remote-execution/protocol"
import { NestedOperation, ToolContext } from "tenetkit"
import type { HostBindingRegistry } from "tenetkit/repl"
import { ActorAttribution, BetterAuthUserId, OrganizationId, type HostedOwner } from "@rika/product/hosted-model"
import type * as ExecutionProjection from "@rika/product/execution-projection"
import { Cause, Context, Crypto, Effect, Encoding, Layer, Option, Schema } from "effect"
import type { AuthenticatedPrincipal } from "./hosted-product"

export const ToolSideEffect = Schema.Literals([
  "none",
  "workspace",
  "terminal",
  "git",
  "secret",
  "publishing",
  "hosted-state",
  "external",
])
export type ToolSideEffect = typeof ToolSideEffect.Type

export const ToolApproval = Schema.Literals(["none", "exact"])
export type ToolApproval = typeof ToolApproval.Type

export const ToolPolicy = Schema.Struct({
  id: Schema.Literal("hosted-tool-policy"),
  version: Schema.Literal(1),
  capability: Schema.NonEmptyString,
  capabilities: Schema.Array(Schema.NonEmptyString),
  sideEffect: ToolSideEffect,
  approval: ToolApproval,
  replayPolicy: Schema.Literals(["none", "never", "provider-idempotent"]),
})
export type ToolPolicy = typeof ToolPolicy.Type

const ToolCapabilitiesJson = Schema.fromJsonString(Schema.Array(Schema.NonEmptyString))

export const ToolAuditCheckpoint = Schema.Struct({
  version: Schema.Int,
  cursor: Schema.String,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export type ToolAuditCheckpoint = typeof ToolAuditCheckpoint.Type

export const ToolAuditExecutor = Schema.Struct({
  kind: Schema.Literals(["runner", "orb"]),
  assignmentId: Schema.String,
  generation: Schema.Int,
  leaseEpoch: Schema.Int,
  instanceId: Schema.String,
  executorId: Schema.String,
  processIncarnation: Schema.String,
})
export type ToolAuditExecutor = typeof ToolAuditExecutor.Type

export const ToolAuditRepository = Schema.Struct({ identity: Schema.NonEmptyString })
export type ToolAuditRepository = typeof ToolAuditRepository.Type

export const ToolAuditRecord = Schema.Struct({
  sequence: Schema.String,
  auditGroupId: Schema.String,
  phase: Schema.Literals(["admission", "decision", "outcome"]),
  ownerId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  actor: ActorAttribution,
  decisionActor: Schema.NullOr(ActorAttribution),
  policy: ToolPolicy,
  authorizationId: Schema.NullOr(Schema.String),
  authorizationCheckpoint: Schema.NullOr(ToolAuditCheckpoint),
  module: Schema.String,
  operation: Schema.String,
  operationKey: Schema.String,
  callId: Schema.String,
  argumentsDigest: Schema.String,
  workspaceId: Schema.String,
  repository: Schema.NullOr(ToolAuditRepository),
  branch: Schema.NullOr(Schema.String),
  executor: ToolAuditExecutor,
  decision: Schema.Literals(["not-required", "pending", "approved", "denied"]),
  outcome: Schema.Literals(["admitted", "suspended", "succeeded", "failed", "denied", "unknown"]),
  occurredAt: Schema.String,
})
export type ToolAuditRecord = typeof ToolAuditRecord.Type

const ToolAuthorizationRequest = Schema.Struct({
  policy: Schema.Struct({ id: Schema.Literal("hosted-tool-policy"), version: Schema.Literal(1) }),
  operation: Schema.Struct({ module: Schema.NonEmptyString, name: Schema.NonEmptyString }),
  argumentsDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  workspace: Schema.NonEmptyString,
  repository: Schema.NullOr(ToolAuditRepository),
  branch: Schema.NullOr(Schema.String),
  executor: ToolAuditExecutor,
  actor: ActorAttribution,
})
type ToolAuthorizationRequest = typeof ToolAuthorizationRequest.Type

export class HostedToolPolicyError extends Schema.TaggedError<HostedToolPolicyError>()("HostedToolPolicyError", {
  kind: Schema.Literals(["forbidden", "conflict", "unknown-tool", "unavailable"]),
  message: Schema.String,
}) {}

const read = (capability: string): ToolPolicy => ({
  id: "hosted-tool-policy",
  version: 1,
  capability,
  capabilities: [capability],
  sideEffect: "none",
  approval: "none",
  replayPolicy: "none",
})

const effect = (
  capability: string,
  sideEffect: Exclude<ToolSideEffect, "none">,
  approval: ToolApproval,
  replayPolicy: "never" | "provider-idempotent",
  capabilities: ReadonlyArray<string> = [capability],
): ToolPolicy => ({
  id: "hosted-tool-policy",
  version: 1,
  capability,
  capabilities,
  sideEffect,
  approval,
  replayPolicy,
})

const commandCapabilities = (command: string) => {
  const capabilities = ["terminal.execute"]
  const git = /(^|[;&|()\s])git(?:\s|$)/i.test(command)
  const secret =
    /(^|[;&|()\s])(env|printenv|set)(?:\s|$)|\.env(?:\s|$)|\b(secret|password|api[_-]?key|access[_-]?token|private[_-]?key)\b/i.test(
      command,
    )
  const publishing =
    /(^|[;&|()\s])git\s+push(?:\s|$)|(^|[;&|()\s])(npm|bun|pnpm|yarn)\s+publish(?:\s|$)|(^|[;&|()\s])docker\s+push(?:\s|$)|(^|[;&|()\s])gh\s+release\s+create(?:\s|$)|(^|[;&|()\s])railway\s+(up|deploy)(?:\s|$)/i.test(
      command,
    )
  if (git) capabilities.push("git.execute")
  if (secret) capabilities.push("secret.access")
  if (publishing) capabilities.push("publishing.execute")
  return capabilities
}

export const policyFor = (request: Pick<BindingRequest, "module" | "operation" | "input">): ToolPolicy => {
  const name = `${request.module}.${request.operation}`
  if (request.module === "workspace") {
    if (request.operation === "search" || request.operation === "list" || request.operation === "read")
      return read(name)
    if (request.operation === "write" || request.operation === "replace")
      return effect(name, "workspace", "exact", "never")
  }
  if (request.module === "edits" && request.operation === "apply") return effect(name, "workspace", "exact", "never")
  if (request.module === "processes") {
    if (request.operation === "status") return read(name)
    if (request.operation === "stop") return effect("terminal.control", "terminal", "exact", "never")
    if (request.operation === "start") {
      const command =
        typeof request.input === "object" && request.input !== null && "command" in request.input
          ? String(request.input.command)
          : ""
      const capabilities = commandCapabilities(command)
      let capability = "terminal.execute"
      let sideEffect: Exclude<ToolSideEffect, "none"> = "terminal"
      if (capabilities.includes("git.execute")) {
        capability = "git.execute"
        sideEffect = "git"
      }
      if (capabilities.includes("secret.access")) {
        capability = "secret.access"
        sideEffect = "secret"
      }
      if (capabilities.includes("publishing.execute")) {
        capability = "publishing.execute"
        sideEffect = "publishing"
      }
      return effect(capability, sideEffect, "exact", "never", capabilities)
    }
  }
  if (request.module === "web" && (request.operation === "search" || request.operation === "readPage"))
    return effect(name, "external", "none", "provider-idempotent")
  if (request.module === "media" && request.operation === "attach")
    return effect(name, "external", "none", "provider-idempotent")
  if (request.module === "threads" && ["search", "find", "read"].includes(request.operation)) return read(name)
  if (
    request.module === "context" &&
    ["current", "historyPage", "searchHistory", "compactions"].includes(request.operation)
  )
    return read(name)
  if (request.module === "harness") {
    if (request.operation === "snapshot" || request.operation === "overview") return read(name)
    if (
      [
        "createMemory",
        "createSkill",
        "createSubagent",
        "createPromptNote",
        "updateMemory",
        "updateSkill",
        "updateSubagent",
        "updatePromptNote",
        "deleteMemory",
        "deleteSkill",
        "deleteSubagent",
        "deletePromptNote",
        "recordRefinement",
        "rollback",
      ].includes(request.operation)
    )
      return effect(name, "hosted-state", "none", "never")
  }
  if (request.module === "goal") {
    if (request.operation === "get") return read(name)
    if (request.operation === "create" || request.operation === "complete")
      return effect(name, "hosted-state", "none", "never")
  }
  if (request.module === "mcp") {
    if (request.operation === "servers" || request.operation === "tools") return read(name)
    if (request.operation === "call") return effect(name, "external", "exact", "never")
  }
  if (request.module === "artifacts") {
    if (request.operation === "get") return read(name)
    if (request.operation === "put") return effect(name, "hosted-state", "none", "provider-idempotent")
  }
  throw HostedToolPolicyError.make({ kind: "unknown-tool", message: `Tool ${name} is not admitted by hosted policy` })
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`
}

const sha256 = Effect.fn("HostedToolPolicy.sha256")(function* (value: string) {
  const crypto = yield* Crypto.Crypto
  return Encoding.encodeHex(yield* crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.orDie))
})

export const argumentsDigest = (input: BindingRequest["input"]) => sha256(canonical(input ?? null))

const nestedFailure = (kind: string, failure: NestedOperation.Failure) => {
  if (failure._tag === "tenetkit/core/NestedOperationDivergence")
    return {
      _tag: "NestedOperationFailed" as const,
      reason: "divergence" as const,
      kind,
      message: `nested operation ${failure.ordinal} recorded ${failure.recordedKind} and was requested as ${failure.requestedKind}`,
    }
  if (failure._tag === "tenetkit/core/NestedOperationUnknown")
    return {
      _tag: "NestedOperationFailed" as const,
      reason: "unknown" as const,
      kind,
      message: `nested operation ${failure.operationId} crossed its boundary with an unobserved outcome`,
    }
  if (failure._tag === "tenetkit/core/NestedOperationDenied")
    return {
      _tag: "NestedOperationFailed" as const,
      reason: "denied" as const,
      kind,
      message: `${failure.capability} was denied: ${failure.reason}`,
    }
  return {
    _tag: "NestedOperationFailed" as const,
    reason: "suspended" as const,
    kind,
    message: `${failure.capability} awaits approval under token ${failure.token}`,
    token: failure.token,
  }
}

export interface ToolAdmissionContext {
  readonly auditGroupId: string
  readonly ownerId: string
  readonly threadId: string
  readonly turnId: string
  readonly actor: ActorAttribution
  readonly policy: ToolPolicy
  readonly module: string
  readonly operation: string
  readonly operationKey: string
  readonly callId: string
  readonly argumentsDigest: string
  readonly workspaceId: string
  readonly repository: ToolAuditRepository | null
  readonly branch: string | null
  readonly executor: ToolAuditExecutor
}

export interface BeginToolAdmissionInput {
  readonly threadId: string
  readonly turnId: string
  readonly workspaceId: string
  readonly operationKey: string
  readonly callId: string
  readonly request: BindingRequest
  readonly access: AccessWire
  readonly policy: ToolPolicy
  readonly argumentsDigest: string
}

export interface RecordDecisionInput {
  readonly ownerId: string
  readonly threadId: string
  readonly turnId: string
  readonly actor: ActorAttribution
  readonly authorizationId: string
  readonly checkpoint: ExecutionProjection.Checkpoint
  readonly operation: string
  readonly capability: string
  readonly authorizationRequest: string
  readonly decision: "approved" | "denied"
  readonly outcome: "admitted" | "succeeded" | "failed"
}

export interface HostedToolPolicyService {
  readonly begin: (input: BeginToolAdmissionInput) => Effect.Effect<ToolAdmissionContext, HostedToolPolicyError>
  readonly outcome: (
    input: ToolAdmissionContext & {
      readonly authorizationId?: string
      readonly outcome: "suspended" | "succeeded" | "failed" | "denied" | "unknown"
    },
  ) => Effect.Effect<void, HostedToolPolicyError>
  readonly recordDecision: (input: RecordDecisionInput) => Effect.Effect<void, HostedToolPolicyError>
  readonly list: (input: {
    readonly principal: Pick<AuthenticatedPrincipal, "userId">
    readonly owner: HostedOwner
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ToolAuditRecord>, HostedToolPolicyError>
}

export class HostedToolPolicy extends Context.Service<HostedToolPolicy, HostedToolPolicyService>()(
  "@rika/api/hosted-tool-policy/HostedToolPolicy",
) {}

const directNestedOperations = NestedOperation.NestedOperations.of({
  run: (_request, operation) => operation,
})

export const toolAuthorizationRequest = (context: ToolAdmissionContext): ToolAuthorizationRequest => ({
  policy: { id: context.policy.id, version: context.policy.version },
  operation: { module: context.module, name: context.operation },
  argumentsDigest: context.argumentsDigest,
  workspace: context.workspaceId,
  repository: context.repository,
  branch: context.branch,
  executor: context.executor,
  actor: context.actor,
})

export interface InvokeAdmittedToolInput {
  readonly policyService: HostedToolPolicyService
  readonly threadId: string
  readonly turnId: string
  readonly workspaceId: string
  readonly operationKey: string
  readonly callId: string
  readonly request: BindingRequest
  readonly access: AccessWire
  readonly invoke: Effect.Effect<HostBindingRegistry.Response, HostBindingRegistry.BindingFailure>
}

export const invokeAdmittedTool: (
  input: InvokeAdmittedToolInput,
) => Effect.Effect<
  BindingOutcome,
  HostedToolPolicyError,
  Crypto.Crypto | NestedOperation.NestedOperations | ToolContext.ToolContext
> = Effect.fn("HostedToolPolicy.invoke")(function* (input) {
  const policy = yield* Effect.try({
    try: () => policyFor(input.request),
    catch: (error) =>
      Schema.is(HostedToolPolicyError)(error)
        ? error
        : HostedToolPolicyError.make({ kind: "unknown-tool", message: "Tool is not admitted by hosted policy" }),
  })
  const digest = yield* argumentsDigest(input.request.input)
  const context = yield* input.policyService.begin({
    threadId: input.threadId,
    turnId: input.turnId,
    workspaceId: input.workspaceId,
    operationKey: input.operationKey,
    callId: input.callId,
    request: input.request,
    access: input.access,
    policy,
    argumentsDigest: digest,
  })
  const exactRequest = toolAuthorizationRequest(context)
  const kind = `rika.tool.${context.module}.${context.operation}`
  const invocation = input.invoke.pipe(Effect.provideService(NestedOperation.NestedOperations, directNestedOperations))
  const replayPolicy = policy.replayPolicy === "none" ? "pure" : policy.replayPolicy
  const admitted = NestedOperation.run(
    {
      kind,
      payload: exactRequest,
      replayPolicy,
      ...(policy.approval === "exact" ? { approval: { capability: policy.capability, request: exactRequest } } : {}),
    },
    invocation,
  )
  const result = yield* Effect.exit(admitted)
  if (result._tag === "Success") {
    const response = result.value as BindingResponse
    yield* input.policyService.outcome({
      ...context,
      outcome: response._tag === "Failure" ? "failed" : "succeeded",
    })
    return { _tag: "Returned", response }
  }
  const failure = Option.getOrUndefined(Cause.findErrorOption(result.cause))
  if (failure === undefined) {
    yield* input.policyService.outcome({ ...context, outcome: "unknown" })
    return { _tag: "Unknown", message: "Binding authority was lost after its operation crossed" }
  }
  if (failure._tag === "tenetkit/core/NestedOperationSuspended") {
    yield* input.policyService.outcome({
      ...context,
      authorizationId: failure.token,
      outcome: "suspended",
    })
    return { _tag: "Suspend", token: failure.token }
  }
  const isNested =
    failure._tag === "tenetkit/core/NestedOperationDenied" ||
    failure._tag === "tenetkit/core/NestedOperationDivergence" ||
    failure._tag === "tenetkit/core/NestedOperationUnknown"
  let outcome: "denied" | "unknown" | "failed" = "failed"
  if (isNested) outcome = "unknown"
  if (failure._tag === "tenetkit/core/NestedOperationDenied") outcome = "denied"
  yield* input.policyService.outcome({
    ...context,
    outcome,
  })
  switch (failure._tag) {
    case "tenetkit/core/NestedOperationDenied":
    case "tenetkit/core/NestedOperationDivergence":
    case "tenetkit/core/NestedOperationUnknown":
      return {
        _tag: "Returned",
        response: { _tag: "Failure", failure: nestedFailure(kind, failure) },
      }
    default:
      return { _tag: "Rejected", failure }
  }
})

interface AdmissionRow {
  readonly ownerId: string
  readonly actor: unknown
  readonly executorKind: "runner" | "orb"
  readonly repositoryIdentity: string | null
  readonly branch: string | null
}

interface AuditRow {
  readonly sequence: string
  readonly auditGroupId: string
  readonly phase: ToolAuditRecord["phase"]
  readonly ownerId: string
  readonly threadId: string
  readonly turnId: string
  readonly actor: unknown
  readonly decisionActor: unknown
  readonly policyId: string
  readonly policyVersion: number
  readonly capability: string
  readonly capabilities: unknown
  readonly sideEffect: ToolSideEffect
  readonly approval: ToolApproval
  readonly replayPolicy: ToolPolicy["replayPolicy"]
  readonly authorizationId: string | null
  readonly authorizationCheckpoint: unknown
  readonly module: string
  readonly operation: string
  readonly operationKey: string
  readonly callId: string
  readonly argumentsDigest: string
  readonly workspaceId: string
  readonly repository: unknown
  readonly branch: string | null
  readonly executor: unknown
  readonly decision: ToolAuditRecord["decision"]
  readonly outcome: ToolAuditRecord["outcome"]
  readonly occurredAt: string
}

const unavailable = () => HostedToolPolicyError.make({ kind: "unavailable", message: "Tool audit is unavailable" })

const executorOf = (access: AccessWire, kind: "runner" | "orb"): ToolAuditExecutor => ({
  kind,
  assignmentId: access.fence.assignmentId,
  generation: access.fence.assignmentGeneration,
  leaseEpoch: access.leaseEpoch,
  instanceId: access.fence.instanceId,
  executorId: access.fence.executorId,
  processIncarnation: access.fence.processIncarnation,
})

const decodeRecord = (row: AuditRow) =>
  Schema.decodeUnknownEffect(ToolAuditRecord)({
    sequence: row.sequence,
    auditGroupId: row.auditGroupId,
    phase: row.phase,
    ownerId: row.ownerId,
    threadId: row.threadId,
    turnId: row.turnId,
    actor: row.actor,
    decisionActor: row.decisionActor,
    policy: {
      id: row.policyId,
      version: row.policyVersion,
      capability: row.capability,
      capabilities: row.capabilities,
      sideEffect: row.sideEffect,
      approval: row.approval,
      replayPolicy: row.replayPolicy,
    },
    authorizationId: row.authorizationId,
    authorizationCheckpoint: row.authorizationCheckpoint,
    module: row.module,
    operation: row.operation,
    operationKey: row.operationKey,
    callId: row.callId,
    argumentsDigest: row.argumentsDigest,
    workspaceId: row.workspaceId,
    repository: row.repository,
    branch: row.branch,
    executor: row.executor,
    decision: row.decision,
    outcome: row.outcome,
    occurredAt: row.occurredAt,
  }).pipe(Effect.mapError(unavailable))

export const layer = Layer.effect(
  HostedToolPolicy,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const crypto = yield* Crypto.Crypto
    const digest = Effect.fn("HostedToolPolicy.digest")(function* (value: string) {
      return Encoding.encodeHex(yield* crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.orDie))
    })

    const insert = Effect.fn("HostedToolPolicy.insert")(function* (input: {
      readonly context: ToolAdmissionContext
      readonly phase: "admission" | "decision" | "outcome"
      readonly decisionActor?: ActorAttribution
      readonly authorizationId?: string
      readonly checkpoint?: ToolAuditCheckpoint
      readonly decision: ToolAuditRecord["decision"]
      readonly outcome: ToolAuditRecord["outcome"]
    }) {
      const value = input.context
      const capabilities = yield* Schema.encodeEffect(ToolCapabilitiesJson)(value.policy.capabilities)
      yield* sql`INSERT INTO rika_hosted_tool_audit_records
          (audit_group_id, phase, owner_id, thread_id, turn_id, actor, decision_actor,
            policy_id, policy_version, capability, capabilities, side_effect, approval, replay_policy,
            authorization_id, authorization_checkpoint, module, operation, operation_key, call_id,
            arguments_digest, workspace_id, repository, branch, executor, decision, outcome)
          VALUES (${value.auditGroupId}, ${input.phase}, ${value.ownerId}, ${value.threadId}, ${value.turnId},
            ${sql.json(value.actor)}, ${input.decisionActor === undefined ? null : sql.json(input.decisionActor)},
            ${value.policy.id}, ${value.policy.version}, ${value.policy.capability}, ${capabilities}::jsonb,
            ${value.policy.sideEffect}, ${value.policy.approval}, ${value.policy.replayPolicy}, ${input.authorizationId ?? null},
            ${input.checkpoint === undefined ? null : sql.json(input.checkpoint)}, ${value.module}, ${value.operation},
            ${value.operationKey}, ${value.callId}, ${value.argumentsDigest}, ${value.workspaceId},
            ${value.repository === null ? null : sql.json(value.repository)}, ${value.branch}, ${sql.json(value.executor)},
            ${input.decision}, ${input.outcome})`
    }, Effect.mapError(unavailable))

    const begin: HostedToolPolicyService["begin"] = Effect.fn("HostedToolPolicy.begin")(function* (input) {
      const rows = yield* sql<AdmissionRow>`SELECT thread.owner_id AS "ownerId",
          COALESCE(legacy.actor, protocol.actor) AS actor,
          assignment.executor_kind AS "executorKind",
          CASE WHEN assignment.executor_kind = 'runner'
            THEN registration.repository ->> 'identity'
            WHEN assignment.checkout IS NOT NULL
            THEN assignment.checkout ->> 'repositoryId'
            ELSE NULL END AS "repositoryIdentity",
          CASE WHEN assignment.executor_kind = 'runner'
            THEN COALESCE(
              registration.repository ->> 'branch',
              CASE WHEN registration.repository ? 'headRevision'
                THEN concat('detached:', registration.repository ->> 'headRevision') END
            )
            WHEN assignment.checkout IS NOT NULL
            THEN concat('detached:', assignment.checkout ->> 'commitSha')
            ELSE NULL END AS branch
        FROM rika_hosted_threads thread
        JOIN rika_hosted_owners owner_record ON owner_record.id = thread.owner_id
        JOIN rika_hosted_workspaces workspace ON workspace.id = thread.workspace_id AND workspace.owner_id = thread.owner_id
        JOIN rika_hosted_executor_assignments assignment
          ON assignment.thread_id = thread.id AND assignment.owner_id = thread.owner_id
        LEFT JOIN rika_hosted_runner_registrations registration
          ON assignment.executor_kind = 'runner'
          AND registration.device_id = assignment.placement ->> 'deviceId'
          AND registration.checkout_fingerprint = assignment.placement ->> 'checkoutFingerprint'
        LEFT JOIN LATERAL (
          SELECT command.actor FROM rika_hosted_thread_commands command
          WHERE command.owner_id = thread.owner_id AND command.thread_id = thread.id AND command.turn_id = ${input.turnId}
          LIMIT 1
        ) legacy ON TRUE
        LEFT JOIN LATERAL (
          SELECT command.actor FROM rika_hosted_thread_protocol_commands command
          WHERE command.owner_id = thread.owner_id AND command.thread_id = thread.id
            AND command.command_id = ${input.turnId} AND command.command ->> '_tag' = 'SubmitPrompt'
          LIMIT 1
        ) protocol ON TRUE
        LEFT JOIN rika_hosted_clients client
          ON client.id = COALESCE(legacy.actor, protocol.actor) ->> 'clientId'
          AND client.user_id = COALESCE(legacy.actor, protocol.actor) ->> 'userId'
          AND client.revoked_at IS NULL AND client.expires_at > clock_timestamp()
        LEFT JOIN rika_hosted_client_authorities client_authority
          ON client_authority.client_id = client.id AND client_authority.owner_id = thread.owner_id
          AND client_authority.revoked_at IS NULL AND client_authority.expires_at > clock_timestamp()
        LEFT JOIN rika_hosted_devices device
          ON device.id = COALESCE(legacy.actor, protocol.actor) ->> 'deviceId'
          AND device.user_id = COALESCE(legacy.actor, protocol.actor) ->> 'userId' AND device.revoked_at IS NULL
        LEFT JOIN "member" membership
          ON owner_record.kind = 'organization' AND membership.id = COALESCE(legacy.actor, protocol.actor) ->> 'membershipId'
          AND membership.organization_id = owner_record.organization_id
          AND membership.user_id = COALESCE(legacy.actor, protocol.actor) ->> 'userId'
        LEFT JOIN rika_hosted_thread_grants thread_grant
          ON thread_grant.owner_id = thread.owner_id AND thread_grant.thread_id = thread.id
          AND thread_grant.membership_id = membership.id
        LEFT JOIN rika_hosted_project_grants project_grant
          ON project_grant.owner_id = thread.owner_id AND project_grant.project_id = thread.project_id
          AND project_grant.membership_id = membership.id
        WHERE thread.id = ${input.threadId} AND workspace.id = ${input.workspaceId}
          AND assignment.id = ${input.access.fence.assignmentId}
          AND assignment.executor_kind = ${input.access.fence.target}
          AND assignment.generation = ${input.access.fence.assignmentGeneration}::bigint
          AND assignment.lease_epoch = ${input.access.leaseEpoch}::bigint
          AND assignment.provider_instance_id = ${input.access.fence.instanceId}
          AND assignment.executor_instance_id = ${input.access.fence.executorId}
          AND assignment.process_incarnation = ${input.access.fence.processIncarnation}
          AND assignment.lifecycle = 'active' AND assignment.lease_expires_at > clock_timestamp()
          AND COALESCE(legacy.actor, protocol.actor) IS NOT NULL
          AND client.id IS NOT NULL AND client_authority.client_id IS NOT NULL AND device.id IS NOT NULL
          AND (
            (owner_record.kind = 'personal'
              AND owner_record.user_id = COALESCE(legacy.actor, protocol.actor) ->> 'userId')
            OR
            (owner_record.kind = 'organization' AND membership.id IS NOT NULL AND (
              thread.created_by_user_id = membership.user_id
              OR thread_grant.role IN ('operator', 'owner')
              OR (thread.executor_kind = 'orb' AND thread.inherit_project_grants
                AND project_grant.role IN ('operator', 'owner'))
            ))
          )`.pipe(Effect.mapError(unavailable))
      const row = rows[0]
      if (row === undefined)
        return yield* HostedToolPolicyError.make({
          kind: "forbidden",
          message: "Tool admission no longer has authenticated Thread and executor authority",
        })
      const actor = yield* Schema.decodeUnknownEffect(ActorAttribution)(row.actor).pipe(Effect.mapError(unavailable))
      const repository = row.repositoryIdentity === null ? null : { identity: row.repositoryIdentity }
      const executor = executorOf(input.access, row.executorKind)
      const auditGroupId = yield* digest(
        canonical({
          ownerId: row.ownerId,
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
          repository,
          branch: row.branch,
          executor,
        }),
      )
      const context: ToolAdmissionContext = {
        auditGroupId,
        ownerId: row.ownerId,
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
        repository,
        branch: row.branch,
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
      yield* insert({
        context: input,
        phase: "outcome",
        ...(input.authorizationId === undefined ? {} : { authorizationId: input.authorizationId }),
        decision: input.policy.approval === "exact" ? "pending" : "not-required",
        outcome: input.outcome,
      })
    })

    const checkpoint = Effect.fn("HostedToolPolicy.checkpoint")(function* (
      value: ExecutionProjection.Checkpoint,
    ): Effect.fn.Return<ToolAuditCheckpoint> {
      return {
        version: value.version,
        cursor: value.cursor,
        digest: yield* digest(canonical(value)),
      }
    })

    const recordDecision: HostedToolPolicyService["recordDecision"] = Effect.fn("HostedToolPolicy.recordDecision")(
      function* (input) {
        const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ToolAuthorizationRequest))(
          input.authorizationRequest,
        ).pipe(
          Effect.mapError(() =>
            HostedToolPolicyError.make({ kind: "conflict", message: "Authorization request is not exact" }),
          ),
        )
        if (input.operation !== `rika.tool.${request.operation.module}.${request.operation.name}`)
          return yield* HostedToolPolicyError.make({
            kind: "conflict",
            message: "Authorization operation does not match its exact request",
          })
        const rows = yield* sql<AuditRow>`SELECT sequence::text AS sequence, audit_group_id AS "auditGroupId", phase,
          owner_id AS "ownerId", thread_id AS "threadId", turn_id AS "turnId", actor,
          decision_actor AS "decisionActor", policy_id AS "policyId", policy_version AS "policyVersion",
          capability, capabilities, side_effect AS "sideEffect", approval, replay_policy AS "replayPolicy",
          authorization_id AS "authorizationId",
          authorization_checkpoint AS "authorizationCheckpoint", module, operation, operation_key AS "operationKey",
          call_id AS "callId", arguments_digest AS "argumentsDigest", workspace_id AS "workspaceId", repository,
          branch, executor, decision, outcome,
          to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"
        FROM rika_hosted_tool_audit_records
        WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId} AND turn_id = ${input.turnId}
          AND phase = 'outcome' AND outcome = 'suspended'
          AND authorization_id = ${input.authorizationId}
          AND policy_id = ${request.policy.id} AND policy_version = ${request.policy.version}
          AND module = ${request.operation.module} AND operation = ${request.operation.name}
          AND capability = ${input.capability}
          AND arguments_digest = ${request.argumentsDigest} AND workspace_id = ${request.workspace}
          AND repository IS NOT DISTINCT FROM ${request.repository === null ? null : sql.json(request.repository)}
          AND branch IS NOT DISTINCT FROM ${request.branch}
          AND executor = ${sql.json(request.executor)} AND actor = ${sql.json(request.actor)}
        ORDER BY sequence DESC LIMIT 1`.pipe(Effect.mapError(unavailable))
        const row = rows[0]
        if (row === undefined)
          return yield* HostedToolPolicyError.make({
            kind: "conflict",
            message: "Authorization has no matching admitted tool operation",
          })
        const record = yield* decodeRecord(row)
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
        yield* insert({
          context,
          phase: "decision",
          decisionActor: input.actor,
          authorizationId: input.authorizationId,
          checkpoint: yield* checkpoint(input.checkpoint),
          decision: input.decision,
          outcome: input.outcome,
        })
      },
    )

    const list: HostedToolPolicyService["list"] = Effect.fn("HostedToolPolicy.list")(function* (input) {
      const ownerIdRows = yield* sql<{ readonly id: string }>`SELECT owner_record.id
        FROM rika_hosted_owners owner_record
        LEFT JOIN "member" membership ON owner_record.kind = 'organization'
          AND membership.organization_id = owner_record.organization_id AND membership.user_id = ${input.principal.userId}
        WHERE (owner_record.kind = 'personal' AND owner_record.user_id = ${
          input.owner._tag === "PersonalOwner" ? input.owner.userId : null
        } AND owner_record.user_id = ${input.principal.userId})
          OR (owner_record.kind = 'organization' AND owner_record.organization_id = ${
            input.owner._tag === "OrganizationOwner" ? input.owner.organizationId : null
          } AND membership.id IS NOT NULL)`.pipe(Effect.mapError(unavailable))
      const ownerId = ownerIdRows[0]?.id
      if (ownerId === undefined)
        return yield* HostedToolPolicyError.make({ kind: "forbidden", message: "Audit owner is unavailable" })
      const rows = yield* sql<AuditRow>`SELECT record.sequence::text AS sequence,
          record.audit_group_id AS "auditGroupId", record.phase, record.owner_id AS "ownerId",
          record.thread_id AS "threadId", record.turn_id AS "turnId", record.actor,
          record.decision_actor AS "decisionActor", record.policy_id AS "policyId",
          record.policy_version AS "policyVersion", record.capability, record.capabilities,
          record.side_effect AS "sideEffect", record.approval, record.replay_policy AS "replayPolicy",
          record.authorization_id AS "authorizationId",
          record.authorization_checkpoint AS "authorizationCheckpoint", record.module, record.operation,
          record.operation_key AS "operationKey", record.call_id AS "callId",
          record.arguments_digest AS "argumentsDigest", record.workspace_id AS "workspaceId", record.repository,
          record.branch, record.executor, record.decision, record.outcome,
          to_char(record.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"
        FROM rika_hosted_tool_audit_records record
        JOIN rika_hosted_threads thread ON thread.id = record.thread_id AND thread.owner_id = record.owner_id
        JOIN rika_hosted_owners owner_record ON owner_record.id = record.owner_id
        LEFT JOIN "member" membership ON owner_record.kind = 'organization'
          AND membership.organization_id = owner_record.organization_id AND membership.user_id = ${input.principal.userId}
        LEFT JOIN rika_hosted_thread_grants thread_grant ON thread_grant.owner_id = thread.owner_id
          AND thread_grant.thread_id = thread.id AND thread_grant.membership_id = membership.id
        LEFT JOIN rika_hosted_project_grants project_grant ON project_grant.owner_id = thread.owner_id
          AND project_grant.project_id = thread.project_id AND project_grant.membership_id = membership.id
        WHERE record.owner_id = ${ownerId} AND (
          owner_record.kind = 'personal' OR membership.role IN ('owner', 'admin')
          OR thread.created_by_user_id = ${input.principal.userId}
          OR thread_grant.role IS NOT NULL
          OR (thread.executor_kind = 'orb' AND thread.inherit_project_grants AND project_grant.role IS NOT NULL)
        ) ORDER BY record.sequence DESC LIMIT ${Math.min(Math.max(input.limit, 1), 500)}`.pipe(
        Effect.mapError(unavailable),
      )
      return yield* Effect.forEach(rows, decodeRecord)
    })

    return HostedToolPolicy.of({ begin, outcome, recordDecision, list })
  }),
)

export const personalOwner = (userId: string): HostedOwner => ({
  _tag: "PersonalOwner",
  userId: BetterAuthUserId.make(userId),
})

export const organizationOwner = (organizationId: string): HostedOwner => ({
  _tag: "OrganizationOwner",
  organizationId: OrganizationId.make(organizationId),
})
