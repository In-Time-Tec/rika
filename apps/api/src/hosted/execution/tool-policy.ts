import {
  BindingResponse,
  type AccessWire,
  type BindingRequest,
  type BindingOutcome,
} from "@rika/remote-execution/protocol"
import { NestedOperation, ToolContext } from "tenetkit"
import type { HostBindingRegistry } from "tenetkit/repl"
import { approvalTarget } from "@rika/execution"
import {
  ActorAttribution,
  BetterAuthUserId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  OrganizationId,
  OwnerId,
  ThreadId,
  WorkspaceId,
  type HostedOwner,
} from "@rika/product/hosted-model"
import type * as ExecutionProjection from "@rika/product/execution-projection"
import {
  ToolPolicyStore,
  type AuditAppend,
  type AuditRecord,
  layer as toolPolicyStoreLayer,
} from "@rika/product-store/execution-tool-policy"
import { Cause, Context, Crypto, Effect, Encoding, Exit, Layer, Match, Option, Schema } from "effect"
import type { AuthenticatedPrincipal } from "../product"

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

const ProcessStartInput = Schema.Struct({ command: Schema.String })

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
      const command = Option.match(Schema.decodeUnknownOption(ProcessStartInput)(request.input), {
        onNone: () => "",
        onSome: (input) => input.command,
      })
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

const JsonRecord = Schema.Record(Schema.String, Schema.Json)
const decodeBindingResponse: (
  input: HostBindingRegistry.Response,
) => Effect.Effect<BindingResponse, HostedToolPolicyError> = (input) => {
  const decoded = Schema.decodeUnknownExit(BindingResponse)(input)
  return Exit.isSuccess(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(HostedToolPolicyError.make({ kind: "unavailable", message: "Tool response is invalid" }))
}
interface AuthorizationTarget {
  readonly runId: string
  readonly approvalId: string
}

type CanonicalValue = Schema.Json | ActorAttribution | ToolAuditCheckpoint | AuthorizationTarget

const canonical = (value: CanonicalValue): string =>
  Match.value(value).pipe(
    Match.when(Schema.is(Schema.Array(Schema.Json)), (items) => `[${items.map(canonical).join(",")}]`),
    Match.when(
      Schema.is(JsonRecord),
      (record) =>
        `{${Object.entries(record)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
          .join(",")}}`,
    ),
    Match.orElse((scalar) => JSON.stringify(scalar)),
  )

const sha256: (value: string) => Effect.Effect<string, never, Crypto.Crypto> = Effect.fn("HostedToolPolicy.sha256")(
  function* (value) {
    const crypto = yield* Crypto.Crypto
    return Encoding.encodeHex(yield* crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.orDie))
  },
)

export const argumentsDigest: (input: BindingRequest["input"]) => Effect.Effect<string, never, Crypto.Crypto> = (
  input,
) => sha256(canonical(input ?? null))

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
  readonly decision: "approved" | "denied"
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
  "@rika/api/hosted/execution/tool-policy/HostedToolPolicy",
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
  const replayPolicy: "pure" | "never" | "provider-idempotent" =
    policy.replayPolicy === "none" ? "pure" : policy.replayPolicy
  const operation =
    policy.approval === "exact"
      ? {
          kind,
          payload: exactRequest,
          replayPolicy,
          approval: { capability: policy.capability, request: exactRequest },
        }
      : { kind, payload: exactRequest, replayPolicy }
  const admitted = NestedOperation.run(operation, invocation)
  const result = yield* Effect.exit(admitted)
  if (result._tag === "Success") {
    const response = yield* decodeBindingResponse(result.value)
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

const decodeStoreRecord = (record: AuditRecord) =>
  Schema.decodeUnknownEffect(ToolAuditRecord)(record).pipe(Effect.mapError(unavailable))

interface AuditOptional {
  decisionActor?: ActorAttribution
  authorizationId?: string
  authorizationCheckpoint?: ToolAuditCheckpoint
}

const hostedToolPolicyLayer = Layer.effect(
  HostedToolPolicy,
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
        return yield* HostedToolPolicyError.make({
          kind: "forbidden",
          message: "Tool admission no longer has authenticated Thread and executor authority",
        })
      const repository = admission.repositoryIdentity === null ? null : { identity: admission.repositoryIdentity }
      const executor = executorOf(input.access, admission.executorKind)
      const auditGroupId = yield* digest(
        canonical({
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
      return { version: value.version, cursor: value.cursor, digest: yield* digest(canonical(value)) }
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
          return yield* HostedToolPolicyError.make({
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
          return yield* HostedToolPolicyError.make({
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
          return yield* HostedToolPolicyError.make({
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
        return yield* HostedToolPolicyError.make({ kind: "forbidden", message: "Audit owner is unavailable" })
      const records = yield* store
        .listInspectionRecords({ ownerId, principalUserId, limit: input.limit })
        .pipe(Effect.mapError(unavailable))
      return yield* Effect.forEach(records, decodeStoreRecord)
    })

    return HostedToolPolicy.of({ begin, outcome, recordDecision, list })
  }),
)

export const layer = hostedToolPolicyLayer.pipe(Layer.provide(toolPolicyStoreLayer))

export const personalOwner = (userId: string): HostedOwner => ({
  _tag: "PersonalOwner",
  userId: BetterAuthUserId.make(userId),
})

export const organizationOwner = (organizationId: string): HostedOwner => ({
  _tag: "OrganizationOwner",
  organizationId: OrganizationId.make(organizationId),
})
