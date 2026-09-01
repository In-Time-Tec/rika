import { Option, Schema } from "effect"
import * as Diagnostic from "./file-logging-contract"

export type DiagnosticAnnotation = string | number | boolean

const annotation = <A extends DiagnosticAnnotation>(schema: Schema.Codec<A>) => {
  const decode = Schema.decodeUnknownOption(schema)
  return (value: DiagnosticAnnotation) => Option.getOrUndefined(decode(value))
}

const oneOf = <A extends string>(...values: ReadonlyArray<A>) => annotation(Schema.Literals(values))

const boundedNumber = annotation(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))

const boolean = annotation(Schema.Boolean)

const matching = (pattern: RegExp, maximum = 256) =>
  annotation(Schema.String.check(Schema.isMaxLength(maximum), Schema.isPattern(pattern)))

const uuid = matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 36)
const executionId = matching(
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?:run|turn)-[a-z0-9][a-z0-9._-]{0,223})$/i,
  256,
)
const eventCursor = matching(
  /^(?:start|(?:cursor|event|follow)[-:][a-z0-9][a-z0-9._:%-]{0,223}|[a-z0-9_-]{1,64}~[a-z0-9_-]{20})$/i,
  256,
)
const toolCallId = matching(/^(?:call[-_:]|id_)[a-z0-9][a-z0-9._:%-]{0,127}$/i, 160)
const hostedCorrelationId = matching(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/, 128)
const runnerOperationKey = matching(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,191})$/, 192)
const runnerMessageTag = matching(/^[A-Z][A-Za-z0-9]{0,48}$/, 64)

const knownFailureKinds = oneOf(...Diagnostic.failureKinds)

const annotationSchemas = {
  "rika.duration.ms": boundedNumber,
  "rika.duration.millis": boundedNumber,
  "rika.event.cursor": eventCursor,
  "rika.event.type": matching(/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/, 100),
  "rika.execution.id": executionId,
  "rika.failure.category": oneOf(
    "invalid_input",
    "not_found",
    "conflict",
    "access_denied",
    "dependency_unavailable",
    "rate_limited",
    "timeout",
    "operation",
  ),
  "rika.failure.interrupted": boolean,
  "rika.failure.kind": knownFailureKinds,
  "rika.failure.outcome": oneOf("known", "unknown"),
  "rika.follow.cursor": eventCursor,
  "rika.follow.reason": oneOf("thread-open", "reattach", "resume", "recovery"),
  "rika.follow.scope": oneOf("execution", "tree"),
  "rika.hosted.outcome": oneOf("success", "failure", "interrupted", "unknown"),
  "rika.hosted.stage": oneOf(
    "process_start",
    "first_draw",
    "connection_ready",
    "connection_ticket",
    "connection_socket",
    "target_resolution",
    "attach",
    "attach_response",
    "attach_projection",
    "attach_refresh",
    "attach_ack",
    "admission",
    "turn_claim",
    "run_created",
    "run_claim",
    "model_start",
    "model_terminal",
    "tool_execution",
    "terminal",
  ),
  "rika.http.status": boundedNumber,
  "rika.host.status": oneOf("started", "returned", "failed"),
  "rika.model_attempt.id": hostedCorrelationId,
  "rika.model.selection": oneOf("main", "oracle", "title", "compaction", "librarian", "painter", "surgeon", "task"),
  "rika.model.backend.kind": oneOf(...Diagnostic.modelBackendKinds),
  "rika.error.kind": oneOf(
    "authorization",
    "execution",
    "fenced",
    "workspace",
    "persistence",
    "transport",
    "timeout",
    "cancelled",
    "unknown",
  ),
  "rika.lifecycle.frame": runnerMessageTag,
  "rika.machine.id": runnerOperationKey,
  "rika.operation.attempt": boundedNumber,
  "rika.operation.id": hostedCorrelationId,
  "rika.operation.key": runnerOperationKey,
  "rika.outcome": matching(/^[A-Za-z][A-Za-z0-9_]{0,48}$/, 48),
  "rika.runner.message": runnerMessageTag,
  "rika.session.id": runnerOperationKey,
  "rika.process.instance": matching(/^\d{1,16}-\d{1,10}$/, 32),
  "rika.process.pid": boundedNumber,
  "rika.process.role": oneOf("client", "server"),
  "rika.reconciliation.certified": boolean,
  "rika.reconciliation.children.confirmed": boundedNumber,
  "rika.reconciliation.children.inspected": boundedNumber,
  "rika.reconciliation.children.pending": boundedNumber,
  "rika.reconciliation.children.replayed": boundedNumber,
  "rika.reconciliation.cursor.confirmed": boolean,
  "rika.reconciliation.cursor.initial": eventCursor,
  "rika.reconciliation.cursor.replayed": eventCursor,
  "rika.reconciliation.history.complete": boolean,
  "rika.reconciliation.inspection.confirmed": boolean,
  "rika.reconciliation.status.stable": boolean,
  "rika.reconciliation.status.terminal": boolean,
  "rika.reconciliation.terminal": boolean,
  "rika.reconciliation.tree.verified": boolean,
  "rika.reconnect.attempt": boundedNumber,
  "rika.reconnect.delay.ms": boundedNumber,
  "rika.retry_after.ms": boundedNumber,
  "rika.run.id": hostedCorrelationId,
  "rika.server.client.kind": oneOf("interactive", "run", "thread-continue", "product"),
  "rika.server.command.sequence": boundedNumber,
  "rika.server.connection.duration.ms": boundedNumber,
  "rika.server.connection.failures": boundedNumber,
  "rika.server.connection.id": uuid,
  "rika.server.connection.retry": boundedNumber,
  "rika.server.connection.retry_delay.ms": boundedNumber,
  "rika.server.connection.role": oneOf("launch", "reattach"),
  "rika.server.feed.fragments": boundedNumber,
  "rika.server.feed.overflowed": boolean,
  "rika.server.feed.queued": boundedNumber,
  "rika.server.feed.sent": boundedNumber,
  "rika.server.feed.sequence": boundedNumber,
  "rika.server.generation": boundedNumber,
  "rika.server.port": boundedNumber,
  "rika.server.previous.pid": boundedNumber,
  "rika.server.rejection.reason": oneOf("AuthenticationFailed", "BuildMismatch", "IdentityMismatch"),
  "rika.server.request.id": uuid,
  "rika.server.session.id": uuid,
  "rika.server.startup.pid": boundedNumber,
  "rika.server.startup.role": oneOf("owner", "child", "reclaimer"),
  "rika.thread.id": hostedCorrelationId,
  "rika.tool.call.id": toolCallId,
  "rika.tool_call.id": hostedCorrelationId,
  "rika.tool.deadline.ms": boundedNumber,
  "rika.tool.dependency": oneOf("parallel", "sequential"),
  "rika.tool.name": oneOf(
    "bash",
    "code_mode",
    "edit",
    "grep",
    "read",
    "read_web_page",
    "run_child",
    "run_child_group",
    "shell_command_status",
    "view_media",
    "web_search",
    "write",
  ),
  "rika.tool.retry.attempt": boundedNumber,
  "rika.tool.retry.delay.ms": boundedNumber,
  "rika.turn.id": hostedCorrelationId,
  "rika.version": matching(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 64),
} satisfies Readonly<Record<string, (value: DiagnosticAnnotation) => DiagnosticAnnotation | undefined>>
export const annotationSchemaMap = new Map<string, (value: DiagnosticAnnotation) => DiagnosticAnnotation | undefined>(
  Object.entries(annotationSchemas),
)
