import {
  BindingResponse,
  type AccessWire,
  type BindingRequest,
  type BindingOutcome,
} from "@rika/remote-execution/protocol"
import { NestedOperation, ToolContext } from "generalist"
import type { HostBindings } from "generalist/repl"
import { ActorAttribution, type HostedOwner } from "@rika/product/hosted-model"
import type * as ExecutionProjection from "@rika/product/execution-projection"
import { Cause, Context, Crypto, Effect, Encoding, Exit, Match, Option, Schema } from "effect"
import type { AuthenticatedPrincipal } from "../product"
import { auditLayer, organizationOwner, personalOwner } from "./tool-policy-audit"

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

const fixedPolicies = new Map<string, (name: string) => ToolPolicy>([
  ...[
    "workspace.search",
    "workspace.list",
    "workspace.read",
    "processes.status",
    "threads.search",
    "threads.find",
    "threads.read",
    "context.current",
    "context.historyPage",
    "context.searchHistory",
    "context.compactions",
    "harness.snapshot",
    "harness.overview",
    "goal.get",
    "mcp.servers",
    "mcp.tools",
    "artifacts.get",
  ].map((name) => [name, read] as const),
  ...["workspace.write", "workspace.replace", "edits.apply"].map(
    (name) => [name, (value: string) => effect(value, "workspace", "exact", "never")] as const,
  ),
  ...["web.search", "web.readPage", "media.attach"].map(
    (name) => [name, (value: string) => effect(value, "external", "none", "provider-idempotent")] as const,
  ),
  ...[
    "harness.createMemory",
    "harness.createSkill",
    "harness.createSubagent",
    "harness.createPromptNote",
    "harness.updateMemory",
    "harness.updateSkill",
    "harness.updateSubagent",
    "harness.updatePromptNote",
    "harness.deleteMemory",
    "harness.deleteSkill",
    "harness.deleteSubagent",
    "harness.deletePromptNote",
    "harness.recordRefinement",
    "harness.rollback",
    "goal.create",
    "goal.complete",
  ].map((name) => [name, (value: string) => effect(value, "hosted-state", "none", "never")] as const),
  ["processes.stop", () => effect("terminal.control", "terminal", "exact", "never")],
  ["mcp.call", (name) => effect(name, "external", "exact", "never")],
  ["artifacts.put", (name) => effect(name, "hosted-state", "none", "provider-idempotent")],
])

const processStartPolicy = (input: BindingRequest["input"]): ToolPolicy => {
  const command = Option.match(Schema.decodeUnknownOption(ProcessStartInput)(input), {
    onNone: () => "",
    onSome: (value) => value.command,
  })
  const capabilities = commandCapabilities(command)
  const priority = [
    ["publishing.execute", "publishing"],
    ["secret.access", "secret"],
    ["git.execute", "git"],
    ["terminal.execute", "terminal"],
  ] as const
  const selected = priority.find(([capability]) => capabilities.includes(capability)) ?? priority[3]
  return effect(selected[0], selected[1], "exact", "never", capabilities)
}

export const policyFor = (request: Pick<BindingRequest, "module" | "operation" | "input">): ToolPolicy => {
  const name = `${request.module}.${request.operation}`
  if (name === "processes.start") return processStartPolicy(request.input)
  const policy = fixedPolicies.get(name)
  if (policy !== undefined) return policy(name)
  throw HostedToolPolicyError.make({
    kind: "unknown-tool",
    message: `Tool ${name} is not admitted by the active policy`,
  })
}

const JsonRecord = Schema.Record(Schema.String, Schema.Json)
const decodeBindingResponse: (input: HostBindings.Response) => Effect.Effect<BindingResponse, HostedToolPolicyError> = (
  input,
) => {
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
          .toSorted(([left], [right]) => left.localeCompare(right))
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
  if (failure._tag === "generalist/core/NestedOperationDivergence")
    return {
      _tag: "NestedOperationFailed" as const,
      reason: "divergence" as const,
      kind,
      message: `nested operation ${failure.ordinal} recorded ${failure.recordedKind} and was requested as ${failure.requestedKind}`,
    }
  if (failure._tag === "generalist/core/NestedOperationUnknown")
    return {
      _tag: "NestedOperationFailed" as const,
      reason: "unknown" as const,
      kind,
      message: `nested operation ${failure.operationId} crossed its boundary with an unobserved outcome`,
    }
  if (failure._tag === "generalist/core/NestedOperationDenied")
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

export { organizationOwner, personalOwner }

const directOperations = NestedOperation.Operations.of({
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
  readonly invoke: Effect.Effect<HostBindings.Response, HostBindings.BindingFailure>
}

export const invokeAdmittedTool: (
  input: InvokeAdmittedToolInput,
) => Effect.Effect<
  BindingOutcome,
  HostedToolPolicyError,
  Crypto.Crypto | NestedOperation.Operations | ToolContext.ToolContext
> = Effect.fn("HostedToolPolicy.invoke")(function* (input) {
  const policy = yield* Effect.try({
    try: () => policyFor(input.request),
    catch: (error) =>
      Schema.is(HostedToolPolicyError)(error)
        ? error
        : HostedToolPolicyError.make({ kind: "unknown-tool", message: "Tool is not admitted by the active policy" }),
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
  const invocation = input.invoke.pipe(Effect.provideService(NestedOperation.Operations, directOperations))
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
  if (failure._tag === "generalist/core/NestedOperationSuspended") {
    yield* input.policyService.outcome({
      ...context,
      authorizationId: failure.token,
      outcome: "suspended",
    })
    return { _tag: "Suspend", token: failure.token }
  }
  const isNested =
    failure._tag === "generalist/core/NestedOperationDenied" ||
    failure._tag === "generalist/core/NestedOperationDivergence" ||
    failure._tag === "generalist/core/NestedOperationUnknown"
  let outcome: "denied" | "unknown" | "failed" = "failed"
  if (isNested) outcome = "unknown"
  if (failure._tag === "generalist/core/NestedOperationDenied") outcome = "denied"
  yield* input.policyService.outcome({
    ...context,
    outcome,
  })
  switch (failure._tag) {
    case "generalist/core/NestedOperationDenied":
    case "generalist/core/NestedOperationDivergence":
    case "generalist/core/NestedOperationUnknown":
      return {
        _tag: "Returned",
        response: { _tag: "Failure", failure: nestedFailure(kind, failure) },
      }
    default:
      return { _tag: "Rejected", failure }
  }
})

export const layer = auditLayer({
  tag: HostedToolPolicy,
  error: HostedToolPolicyError,
  recordSchema: ToolAuditRecord,
  canonical,
})
