import { Service } from "@rika/product/thread-interaction-repository"
export { Service }
import { Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Thread, ThreadId } from "@rika/product/thread-record"
import * as TurnRepository from "../turn/sqlite-turn-repository"
import { ExecutionRoutePin, Turn, TurnId, isAgentExecution } from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"

export const ReceiptKind = Schema.Literals(["create", "message", "steer", "cancel", "stop"])
export type ReceiptKind = typeof ReceiptKind.Type
export const ResultDelivery = Schema.Literals([
  "awaiting-result",
  "ready",
  "delivered",
  "failed",
  "cancelled",
  "source-unavailable",
])
export type ResultDelivery = typeof ResultDelivery.Type

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("ThreadInteractionRepositoryError", {
  message: Schema.String,
}) {}
export class InvocationConflict extends Schema.TaggedErrorClass<InvocationConflict>()("ThreadInvocationConflict", {
  invocationDigest: Schema.String,
}) {}
export class AdmissionRejected extends Schema.TaggedErrorClass<AdmissionRejected>()("ThreadAdmissionRejected", {
  reason: Schema.Literals([
    "source-unavailable",
    "target-unavailable",
    "self",
    "workspace",
    "archived",
    "depth",
    "admission-limit",
    "workspace-active-limit",
  ]),
  message: Schema.String,
}) {}
export class QueueFull extends Schema.TaggedErrorClass<QueueFull>()("ThreadInteractionQueueFull", {
  threadId: ThreadId,
  capacity: Schema.Int,
  count: Schema.Int,
}) {}
export class ResultNotReady extends Schema.TaggedErrorClass<ResultNotReady>()("ThreadResultNotReady", {
  targetTurnId: TurnId,
}) {}

export interface Invocation {
  readonly invocationDigest: string
  readonly schemaInputDigest: string
  readonly sourceThreadId: ThreadId
  readonly sourceRootTurnId: TurnId
  readonly now: number
}
export interface Limits {
  readonly maximumDepth: number
  readonly maximumAdmissions: number
  readonly maximumWorkspaceActive: number
  readonly queueCapacity: number
}
export interface TurnInput {
  readonly turnId: TurnId
  readonly prompt: string
  readonly executionRoute: ExecutionRoutePin
}
export interface CreateThreadInput extends Invocation, Limits, TurnInput {
  readonly threadId: ThreadId
  readonly title: string
  readonly resultDelivery: "manual" | "reply"
  readonly threadCreationDepth: number
}
export interface AppendThreadMessageInput extends Invocation, Limits, TurnInput {
  readonly targetThreadId: ThreadId
  readonly resultDelivery: "manual" | "reply"
  readonly threadCreationDepth: number
}
export interface BindThreadControlInput extends Invocation {
  readonly targetThreadId: ThreadId
}
export interface DeliverThreadResultInput {
  readonly targetTurnId: TurnId
  readonly deliveredTurnId: TurnId
  readonly queueCapacity: number
  readonly now: number
}
export interface SettleThreadResultInput {
  readonly targetTurnId: TurnId
  readonly result: RootResult
  readonly now: number
}
export interface AcceptedThreadTurn {
  readonly threadId: ThreadId
  readonly turnId: TurnId
  readonly status: "accepted" | "queued"
  readonly queueRevision?: number
}
export interface BoundThreadControl {
  readonly targetThreadId: ThreadId
  readonly targetTurnId?: TurnId
  readonly outcome: "bound" | "no-active" | "already-terminal"
  readonly queueRevision?: number
  readonly stoppedTurnIds?: ReadonlyArray<TurnId>
}
export interface DeliveredThreadResult {
  readonly targetTurnId: TurnId
  readonly delivery: "delivered" | "source-unavailable"
  readonly deliveredTurnId?: TurnId
}
export type RootResult =
  | { readonly status: "completed"; readonly cursor: string; readonly sequence: number; readonly output: string }
  | { readonly status: "failed"; readonly cursor: string; readonly sequence: number; readonly reason?: string }
  | ((
      | { readonly cursor: string; readonly sequence: number }
      | { readonly cursor?: never; readonly sequence?: never }
    ) & { readonly status: "cancelled"; readonly reason?: string })
interface ResultRouteBase {
  readonly targetTurnId: TurnId
  readonly kind: "manual" | "reply"
  readonly sourceThreadId?: ThreadId
  readonly sourceTurnId?: TurnId
  readonly createdAt: number
  readonly updatedAt: number
}
export type ResultRoute =
  | (ResultRouteBase & { readonly delivery: "awaiting-result" | "failed" | "cancelled" })
  | (ResultRouteBase & { readonly delivery: "ready"; readonly readySequence: number })
  | (ResultRouteBase & {
      readonly delivery: "delivered" | "source-unavailable"
      readonly readySequence: number
      readonly deliveredTurnId?: TurnId
    })
export interface ThreadRelationship {
  readonly kind: "created" | "message" | "reply" | "fork"
  readonly sourceThreadId: ThreadId
  readonly sourceTurnId: TurnId
  readonly targetThreadId: ThreadId
  readonly targetTurnId: TurnId
  readonly createdAt: number
}
export interface RelationshipCursor {
  readonly createdAt: number
  readonly targetTurnId: TurnId
}
export interface ResultRouteCursor {
  readonly targetTurnId: TurnId
}

type Failure = RepositoryError | InvocationConflict | AdmissionRejected | QueueFull
export interface Interface {
  readonly createThread: (input: CreateThreadInput) => Effect.Effect<AcceptedThreadTurn, Failure>
  readonly appendMessage: (input: AppendThreadMessageInput) => Effect.Effect<AcceptedThreadTurn, Failure>
  readonly bindSteer: (
    input: BindThreadControlInput,
  ) => Effect.Effect<BoundThreadControl, RepositoryError | InvocationConflict>
  readonly bindCancel: (
    input: BindThreadControlInput,
  ) => Effect.Effect<BoundThreadControl, RepositoryError | InvocationConflict>
  readonly bindStop: (
    input: BindThreadControlInput,
  ) => Effect.Effect<BoundThreadControl, RepositoryError | InvocationConflict>
  readonly settleResult: (input: SettleThreadResultInput) => Effect.Effect<ResultRoute | undefined, RepositoryError>
  readonly deliverResult: (
    input: DeliverThreadResultInput,
  ) => Effect.Effect<DeliveredThreadResult, RepositoryError | QueueFull | ResultNotReady>
  readonly getStatus: (threadId: ThreadId) => Effect.Effect<Thread | undefined, RepositoryError>
  readonly getMessages: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly getResultRoute: (targetTurnId: TurnId) => Effect.Effect<ResultRoute | undefined, RepositoryError>
  readonly getRootResult: (targetTurnId: TurnId) => Effect.Effect<RootResult | undefined, RepositoryError>
  readonly listRelationships: (
    threadId: ThreadId,
    limit?: number,
    before?: RelationshipCursor,
  ) => Effect.Effect<ReadonlyArray<ThreadRelationship>, RepositoryError>
  readonly listUndeliveredResults: (
    limit?: number,
    after?: ResultRouteCursor,
  ) => Effect.Effect<ReadonlyArray<ResultRoute>, RepositoryError>
  readonly listReadyResults: (limit?: number) => Effect.Effect<ReadonlyArray<ResultRoute>, RepositoryError>
}

interface Receipt {
  readonly digest: string
  readonly input: string
  readonly kind: ReceiptKind
  readonly value: AcceptedThreadTurn | BoundThreadControl
}
interface State {
  readonly threads: ReadonlyMap<ThreadId, Thread>
  readonly turns: ReadonlyMap<TurnId, Turn>
  readonly receipts: ReadonlyMap<string, Receipt>
  readonly routes: ReadonlyMap<TurnId, ResultRoute>
  readonly results: ReadonlyMap<TurnId, RootResult>
  readonly relationships: ReadonlyArray<ThreadRelationship>
  readonly revisions: ReadonlyMap<ThreadId, number>
}
const error = (cause: unknown) => RepositoryError.make({ message: String(cause) })
const reject = (reason: AdmissionRejected["reason"], message: string) => AdmissionRejected.make({ reason, message })
const Json = Schema.fromJsonString(Schema.Unknown)
const encodeJson = (value: unknown) => Schema.encodeEffect(Json)(value).pipe(Effect.mapError(error))
const decodeJson = <A>(value: unknown) =>
  Schema.decodeUnknownEffect(Json)(value).pipe(
    Effect.map((decoded) => decoded as A),
    Effect.mapError(error),
  )
const admissionFailure = (cause: unknown): Failure => {
  if (Schema.is(InvocationConflict)(cause) || Schema.is(AdmissionRejected)(cause) || Schema.is(QueueFull)(cause))
    return cause
  return error(typeof cause === "object" ? JSON.stringify(cause) : cause)
}
const controlFailure = (cause: unknown): RepositoryError | InvocationConflict =>
  Schema.is(InvocationConflict)(cause) ? cause : error(cause)
const deliveryFailure = (cause: unknown): RepositoryError | QueueFull | ResultNotReady =>
  Schema.is(QueueFull)(cause) || Schema.is(ResultNotReady)(cause) ? cause : error(cause)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const receipt = (digest: string) => sql<{
      readonly schema_input_digest: string
      readonly kind: ReceiptKind
      readonly outcome: string
    }>`
    SELECT schema_input_digest, kind, outcome FROM rika_thread_invocation_receipts WHERE invocation_digest = ${digest}`
    const resolveReceipt = <A>(input: Invocation, kind: ReceiptKind) =>
      Effect.gen(function* () {
        const rows = yield* receipt(input.invocationDigest)
        if (rows.length === 0) return undefined
        const row = rows[0]!
        if (row.schema_input_digest !== input.schemaInputDigest || row.kind !== kind)
          return yield* InvocationConflict.make({ invocationDigest: input.invocationDigest })
        return yield* decodeJson<A>(row.outcome)
      })
    const storeReceipt = (
      input: Invocation,
      kind: ReceiptKind,
      value: unknown,
      targetThreadId?: ThreadId,
      targetTurnId?: TurnId,
      queueRevision?: number,
    ) =>
      Effect.gen(function* () {
        const outcome = yield* encodeJson(value)
        yield* sql`INSERT INTO rika_thread_invocation_receipts
        (invocation_digest, schema_input_digest, kind, outcome, source_thread_id, source_root_turn_id, target_thread_id, target_turn_id, queue_revision, created_at)
        VALUES (${input.invocationDigest}, ${input.schemaInputDigest}, ${kind}, ${outcome}, ${input.sourceThreadId}, ${input.sourceRootTurnId},
          ${targetThreadId ?? null}, ${targetTurnId ?? null}, ${queueRevision ?? null}, ${input.now})`
      })
    const admit = (kind: "create" | "message", input: CreateThreadInput | AppendThreadMessageInput) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const prior = yield* resolveReceipt<AcceptedThreadTurn>(input, kind)
            if (prior !== undefined) return prior
            const sources = yield* sql<{
              readonly workspace: string
              readonly archived: number
            }>`SELECT workspace, archived FROM rika_threads WHERE id = ${input.sourceThreadId}`
            const source = sources[0]
            if (source === undefined || source.archived === 1)
              return yield* reject("source-unavailable", "Source Thread is unavailable")
            if (input.threadCreationDepth > input.maximumDepth)
              return yield* reject("depth", "Thread creation depth exceeded")
            const admissions = yield* sql<{
              readonly count: number
            }>`SELECT COUNT(*) AS count FROM rika_thread_invocation_receipts
      WHERE source_root_turn_id = ${input.sourceRootTurnId} AND kind IN ('create', 'message')`
            if (admissions[0]!.count >= input.maximumAdmissions)
              return yield* reject("admission-limit", "Admission limit exceeded")
            const workspaceActive = yield* sql<{
              readonly count: number
            }>`SELECT COUNT(*) AS count FROM rika_turns t JOIN rika_threads h ON h.id = t.thread_id
      WHERE h.workspace = ${source.workspace} AND t.turn_kind = 'AgentExecution'
        AND t.status IN ('accepted', 'queued', 'running', 'waiting') AND json_extract(t.author_json, '$._tag') = 'Agent'`
            if (workspaceActive[0]!.count >= input.maximumWorkspaceActive)
              return yield* reject("workspace-active-limit", "Workspace active limit exceeded")
            const targetId =
              kind === "create"
                ? (input as CreateThreadInput).threadId
                : (input as AppendThreadMessageInput).targetThreadId
            if (kind === "message" && targetId === input.sourceThreadId)
              return yield* reject("self", "A Thread cannot message itself")
            if (kind === "create") {
              yield* sql`INSERT INTO rika_threads (id, workspace, title, labels_json, pinned, archived, lineage_json, created_at, updated_at)
        VALUES (${targetId}, ${source.workspace}, ${(input as CreateThreadInput).title}, '[]', 0, 0, '{"_tag":"Original"}', ${input.now}, ${input.now})`
            } else {
              const targets = yield* sql<{
                readonly workspace: string
                readonly archived: number
              }>`SELECT workspace, archived FROM rika_threads WHERE id = ${targetId}`
              const target = targets[0]
              if (target === undefined) return yield* reject("target-unavailable", "Target Thread does not exist")
              if (target.archived === 1) return yield* reject("archived", "Target Thread is archived")
              if (target.workspace !== source.workspace)
                return yield* reject("workspace", "Threads must share a Workspace")
            }
            const activeRows = yield* sql<{
              readonly count: number
            }>`SELECT COUNT(*) AS count FROM rika_turns WHERE thread_id = ${targetId} AND turn_kind = 'AgentExecution' AND status IN ('accepted', 'running', 'waiting')`
            const queuedRows = yield* sql<{
              readonly count: number
            }>`SELECT COUNT(*) AS count FROM rika_turns WHERE thread_id = ${targetId} AND turn_kind = 'AgentExecution' AND status = 'queued'`
            const isActive = activeRows[0]!.count > 0
            if (isActive && queuedRows[0]!.count >= input.queueCapacity)
              return yield* QueueFull.make({
                threadId: targetId,
                capacity: input.queueCapacity,
                count: queuedRows[0]!.count,
              })
            const status = isActive ? ("queued" as const) : ("accepted" as const)
            let queueRevision: number | undefined
            if (status === "queued") {
              yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${targetId}) ON CONFLICT (thread_id) DO NOTHING`
              const revisions = yield* sql<{
                readonly revision: number
              }>`UPDATE rika_thread_queue_state SET revision = revision + 1, queued_count = queued_count + 1 WHERE thread_id = ${targetId} RETURNING revision`
              queueRevision = revisions[0]!.revision
            }
            const route = yield* encodeJson(input.executionRoute)
            const author = yield* encodeJson({
              _tag: "Agent",
              sourceThreadId: input.sourceThreadId,
              sourceRootTurnId: input.sourceRootTurnId,
              threadCreationDepth: input.threadCreationDepth,
            })
            yield* sql`INSERT INTO rika_turns (id, thread_id, turn_kind, prompt, status, execution_route_json, author_json, lineage_json, created_at, updated_at)
      VALUES (${input.turnId}, ${targetId}, 'AgentExecution', ${input.prompt}, ${status}, ${route}, ${author}, '{"_tag":"Original"}', ${input.now}, ${input.now})`
            yield* sql`INSERT INTO rika_thread_relationships (id, kind, source_thread_id, source_turn_id, target_thread_id, target_turn_id, created_at)
      VALUES (${input.invocationDigest}, ${kind === "create" ? "created" : "message"}, ${input.sourceThreadId}, ${input.sourceRootTurnId}, ${targetId}, ${input.turnId}, ${input.now})`
            yield* sql`INSERT INTO rika_thread_result_routes (id, kind, source_thread_id, source_turn_id, target_thread_id, target_turn_id, delivery, created_at, updated_at)
      VALUES (${input.turnId}, ${input.resultDelivery}, ${input.resultDelivery === "reply" ? input.sourceThreadId : null},
        ${input.resultDelivery === "reply" ? input.sourceRootTurnId : null}, ${targetId}, ${input.turnId}, 'awaiting-result', ${input.now}, ${input.now})`
            const accepted: AcceptedThreadTurn = {
              threadId: targetId,
              turnId: input.turnId,
              status,
              ...(queueRevision === undefined ? {} : { queueRevision }),
            }
            yield* storeReceipt(input, kind, accepted, targetId, input.turnId, queueRevision)
            return accepted
          }),
        )
        .pipe(Effect.mapError(admissionFailure))
    const bind = (kind: "steer" | "cancel" | "stop", input: BindThreadControlInput) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const prior = yield* resolveReceipt<BoundThreadControl>(input, kind)
            if (prior !== undefined) return prior
            const roots = yield* sql<{
              readonly id: string
            }>`SELECT id FROM rika_turns WHERE thread_id = ${input.targetThreadId}
      AND turn_kind = 'AgentExecution' AND status IN ('accepted', 'running', 'waiting') ORDER BY created_at ASC, id ASC LIMIT 1`
            const root = roots[0]
            let queueRevision: number | undefined
            let stoppedTurnIds: ReadonlyArray<TurnId> | undefined
            if (kind === "stop") {
              const stopped = yield* sql<{
                readonly id: string
              }>`SELECT id FROM rika_turns WHERE thread_id = ${input.targetThreadId} AND turn_kind = 'AgentExecution' AND status = 'queued' ORDER BY created_at ASC, id ASC`
              stoppedTurnIds = stopped.map((row) => TurnId.make(row.id))
              yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${input.targetThreadId}) ON CONFLICT (thread_id) DO NOTHING`
              if (stopped.length > 0) {
                const revisions = yield* sql<{
                  readonly revision: number
                }>`UPDATE rika_thread_queue_state SET revision = revision + 1, queued_count = 0 WHERE thread_id = ${input.targetThreadId} RETURNING revision`
                queueRevision = revisions[0]!.revision
                yield* sql`UPDATE rika_turns SET status = 'cancelled', updated_at = ${input.now}, queue_claim_token = NULL WHERE thread_id = ${input.targetThreadId} AND turn_kind = 'AgentExecution' AND status = 'queued'`
              } else {
                const revisions = yield* sql<{
                  readonly revision: number
                }>`SELECT revision FROM rika_thread_queue_state WHERE thread_id = ${input.targetThreadId}`
                queueRevision = revisions[0]!.revision
              }
            }
            const value: BoundThreadControl =
              root === undefined
                ? {
                    targetThreadId: input.targetThreadId,
                    outcome: "no-active",
                    ...(queueRevision === undefined ? {} : { queueRevision }),
                    ...(stoppedTurnIds === undefined ? {} : { stoppedTurnIds }),
                  }
                : {
                    targetThreadId: input.targetThreadId,
                    targetTurnId: TurnId.make(root.id),
                    outcome: "bound",
                    ...(queueRevision === undefined ? {} : { queueRevision }),
                    ...(stoppedTurnIds === undefined ? {} : { stoppedTurnIds }),
                  }
            yield* storeReceipt(input, kind, value, input.targetThreadId, value.targetTurnId, queueRevision)
            return value
          }),
        )
        .pipe(Effect.mapError(controlFailure))
    const routeFromRow = (row: any): ResultRoute => {
      const base: ResultRouteBase = {
        targetTurnId: TurnId.make(row.target_turn_id),
        kind: row.kind,
        ...(row.source_thread_id == null ? {} : { sourceThreadId: ThreadId.make(row.source_thread_id) }),
        ...(row.source_turn_id == null ? {} : { sourceTurnId: TurnId.make(row.source_turn_id) }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
      if (row.delivery === "awaiting-result" || row.delivery === "failed" || row.delivery === "cancelled")
        return { ...base, delivery: row.delivery }
      if (row.delivery === "ready") return { ...base, delivery: "ready", readySequence: row.ready_sequence }
      return {
        ...base,
        delivery: row.delivery,
        readySequence: row.ready_sequence,
        ...(row.delivered_turn_id == null ? {} : { deliveredTurnId: TurnId.make(row.delivered_turn_id) }),
      }
    }
    const getRoute = (id: TurnId) =>
      sql<any>`SELECT * FROM rika_thread_result_routes WHERE target_turn_id = ${id}`.pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : routeFromRow(rows[0]))),
        Effect.mapError(error),
      )
    return Service.of({
      createThread: (input) => admit("create", input),
      appendMessage: (input) => admit("message", input),
      bindSteer: (input) => bind("steer", input),
      bindCancel: (input) => bind("cancel", input),
      bindStop: (input) => bind("stop", input),
      settleResult: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const route = yield* getRoute(input.targetTurnId)
              if (route === undefined || route.delivery !== "awaiting-result") return undefined
              const cursor = "cursor" in input.result ? (input.result.cursor ?? null) : null
              const sequence = "sequence" in input.result ? (input.result.sequence ?? null) : null
              const output = input.result.status === "completed" ? input.result.output : null
              const reason = input.result.status === "completed" ? null : (input.result.reason ?? null)
              const delivery = input.result.status === "completed" ? "ready" : input.result.status
              yield* sql`INSERT INTO rika_thread_root_results (turn_id, status, cursor, sequence, output, reason, updated_at) VALUES (${input.targetTurnId}, ${input.result.status}, ${cursor}, ${sequence}, ${output}, ${reason}, ${input.now}) ON CONFLICT(turn_id) DO UPDATE SET status=excluded.status, cursor=excluded.cursor, sequence=excluded.sequence, output=excluded.output, reason=excluded.reason, updated_at=excluded.updated_at`
              yield* sql`UPDATE rika_thread_result_routes SET delivery=${delivery}, ready_sequence=${input.result.status === "completed" ? input.result.sequence : null}, updated_at=${input.now} WHERE target_turn_id=${input.targetTurnId}`
              return yield* getRoute(input.targetTurnId)
            }),
          )
          .pipe(Effect.mapError(error)),
      deliverResult: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const route = yield* getRoute(input.targetTurnId)
              if (route?.delivery === "delivered")
                return {
                  targetTurnId: input.targetTurnId,
                  delivery: "delivered" as const,
                  ...(route.deliveredTurnId === undefined ? {} : { deliveredTurnId: route.deliveredTurnId }),
                }
              if (route === undefined || route.delivery !== "ready" || route.kind !== "reply")
                return yield* ResultNotReady.make({ targetTurnId: input.targetTurnId })
              const results = yield* sql<{
                readonly output: string
              }>`SELECT output FROM rika_thread_root_results WHERE turn_id=${input.targetTurnId} AND status='completed'`
              const result = results[0]
              if (result === undefined) return yield* ResultNotReady.make({ targetTurnId: input.targetTurnId })
              const sources = yield* sql<{
                readonly archived: number
              }>`SELECT archived FROM rika_threads WHERE id=${route.sourceThreadId!}`
              if (sources[0] === undefined || sources[0].archived === 1) {
                yield* sql`UPDATE rika_thread_result_routes SET delivery='source-unavailable', updated_at=${input.now} WHERE target_turn_id=${input.targetTurnId}`
                return { targetTurnId: input.targetTurnId, delivery: "source-unavailable" as const }
              }
              const activeRows = yield* sql<{
                readonly count: number
              }>`SELECT COUNT(*) AS count FROM rika_turns WHERE thread_id=${route.sourceThreadId!} AND turn_kind='AgentExecution' AND status IN ('accepted','running','waiting')`
              const queuedRows = yield* sql<{
                readonly count: number
              }>`SELECT COUNT(*) AS count FROM rika_turns WHERE thread_id=${route.sourceThreadId!} AND turn_kind='AgentExecution' AND status='queued'`
              const busy = activeRows[0]!.count > 0
              if (busy && queuedRows[0]!.count >= input.queueCapacity)
                return yield* QueueFull.make({
                  threadId: route.sourceThreadId!,
                  capacity: input.queueCapacity,
                  count: queuedRows[0]!.count,
                })
              const targets = yield* sql<{
                readonly thread_id: string
                readonly execution_route_json: string
                readonly author_json: string
              }>`SELECT thread_id, execution_route_json, author_json FROM rika_turns WHERE id=${input.targetTurnId} AND turn_kind='AgentExecution'`
              const target = targets[0]!
              const targetAuthor = yield* decodeJson<any>(target.author_json)
              const author = yield* encodeJson({
                _tag: "Agent",
                sourceThreadId: ThreadId.make(target.thread_id),
                sourceRootTurnId: input.targetTurnId,
                threadCreationDepth: targetAuthor.threadCreationDepth ?? 0,
              })
              yield* sql`INSERT INTO rika_turns (id, thread_id, turn_kind, prompt, status, execution_route_json, author_json, lineage_json, created_at, updated_at) VALUES (${input.deliveredTurnId}, ${route.sourceThreadId!}, 'AgentExecution', ${result.output}, ${busy ? "queued" : "accepted"}, ${target.execution_route_json}, ${author}, '{"_tag":"Original"}', ${input.now}, ${input.now})`
              if (busy) {
                yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${route.sourceThreadId!}) ON CONFLICT (thread_id) DO NOTHING`
                yield* sql`UPDATE rika_thread_queue_state SET revision = revision + 1, queued_count = queued_count + 1 WHERE thread_id = ${route.sourceThreadId!}`
              }
              yield* sql`INSERT INTO rika_thread_relationships (id, kind, source_thread_id, source_turn_id, target_thread_id, target_turn_id, created_at) VALUES (${input.targetTurnId}, 'reply', ${ThreadId.make(target.thread_id)}, ${input.targetTurnId}, ${route.sourceThreadId!}, ${input.deliveredTurnId}, ${input.now})`
              yield* sql`UPDATE rika_thread_result_routes SET delivery='delivered', delivered_turn_id=${input.deliveredTurnId}, updated_at=${input.now} WHERE target_turn_id=${input.targetTurnId}`
              return {
                targetTurnId: input.targetTurnId,
                delivery: "delivered" as const,
                deliveredTurnId: input.deliveredTurnId,
              }
            }),
          )
          .pipe(Effect.mapError(deliveryFailure)),
      getStatus: (id) =>
        sql<any>`SELECT * FROM rika_threads WHERE id=${id}`.pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.sync(() => undefined)
              : Effect.gen(function* () {
                  const row = rows[0]
                  return {
                    id: ThreadId.make(row.id),
                    workspace: row.workspace,
                    title: row.title,
                    labels: yield* decodeJson<ReadonlyArray<string>>(row.labels_json),
                    pinned: row.pinned === 1,
                    archived: row.archived === 1,
                    lineage: yield* decodeJson<any>(row.lineage_json),
                    createdAt: row.created_at,
                    updatedAt: row.updated_at,
                  }
                }),
          ),
          Effect.mapError(error),
        ),
      getMessages: (id) =>
        sql<any>`SELECT * FROM rika_turns WHERE thread_id=${id} ORDER BY created_at ASC, id ASC`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, TurnRepository.decodeStoredTurn)),
          Effect.mapError(error),
        ),
      getResultRoute: getRoute,
      getRootResult: (id) =>
        sql<any>`SELECT status, cursor, sequence, output, reason FROM rika_thread_root_results WHERE turn_id=${id}`.pipe(
          Effect.map((rows) => {
            const row = rows[0]
            if (row === undefined) return undefined
            if (row.status === "completed")
              return { status: "completed" as const, cursor: row.cursor, sequence: row.sequence, output: row.output }
            if (row.status === "failed")
              return {
                status: "failed" as const,
                cursor: row.cursor,
                sequence: row.sequence,
                ...(row.reason == null ? {} : { reason: row.reason }),
              }
            return row.cursor == null
              ? { status: "cancelled" as const, ...(row.reason == null ? {} : { reason: row.reason }) }
              : {
                  status: "cancelled" as const,
                  cursor: row.cursor,
                  sequence: row.sequence,
                  ...(row.reason == null ? {} : { reason: row.reason }),
                }
          }),
          Effect.mapError(error),
        ),
      listRelationships: (id, limit = 20, before) =>
        sql<any>`SELECT kind, source_thread_id, source_turn_id, target_thread_id, target_turn_id, created_at FROM rika_thread_relationships WHERE (source_thread_id=${id} OR target_thread_id=${id}) AND (${before === undefined} OR created_at < ${before?.createdAt ?? 0} OR (created_at = ${before?.createdAt ?? 0} AND target_turn_id > ${before?.targetTurnId ?? ""})) ORDER BY created_at DESC, target_turn_id ASC LIMIT ${Math.max(1, limit)}`.pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              kind: row.kind,
              sourceThreadId: ThreadId.make(row.source_thread_id),
              sourceTurnId: TurnId.make(row.source_turn_id),
              targetThreadId: ThreadId.make(row.target_thread_id),
              targetTurnId: TurnId.make(row.target_turn_id),
              createdAt: row.created_at,
            })),
          ),
          Effect.mapError(error),
        ),
      listUndeliveredResults: (limit = 50, after) =>
        sql<any>`SELECT * FROM rika_thread_result_routes WHERE (delivery='awaiting-result' OR (kind='reply' AND delivery='ready')) AND target_turn_id > ${after?.targetTurnId ?? ""} ORDER BY target_turn_id LIMIT ${Math.max(1, limit)}`.pipe(
          Effect.map((rows) => rows.map(routeFromRow)),
          Effect.mapError(error),
        ),
      listReadyResults: (limit = 50) =>
        sql<any>`SELECT * FROM rika_thread_result_routes WHERE kind='reply' AND delivery='ready' ORDER BY updated_at, target_turn_id LIMIT ${Math.max(1, limit)}`.pipe(
          Effect.map((rows) => rows.map(routeFromRow)),
          Effect.mapError(error),
        ),
    })
  }),
)

export { makeMemory, memoryLayer } from "./memory-thread-interaction-repository"
