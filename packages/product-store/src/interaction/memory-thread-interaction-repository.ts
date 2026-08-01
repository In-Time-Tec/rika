import { TurnResult } from "@rika/product/thread-result"
import { Service } from "@rika/product/thread-interaction-repository"
export { Service }
import { Effect, Layer, Ref } from "effect"
import { Thread, ThreadId } from "@rika/product/thread-record"
import { Turn, TurnId } from "@rika/product/turn-record"
import * as ExecutionStatus from "@rika/product/execution-status"

import {
  ReceiptKind,
  RepositoryError,
  InvocationConflict,
  AdmissionRejected,
  QueueFull,
  ResultNotReady,
} from "@rika/product/thread-interaction-repository"
import type {
  CreateThreadInput,
  AppendThreadMessageInput,
  BindThreadControlInput,
  AcceptedThreadTurn,
  BoundThreadControl,
  DeliveredThreadResult,
  RootResult,
  ResultRoute,
  ThreadRelationship,
} from "@rika/product/thread-interaction-repository"

type Failure = RepositoryError | InvocationConflict | AdmissionRejected | QueueFull
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
const terminal = ExecutionStatus.isTerminalStatus
const active = (turn: Turn) => TurnResult.isAgentExecution(turn) && !terminal(turn.status) && turn.status !== "queued"
const clone = <A>(value: A): A => structuredClone(value)
const initialState = (threads: ReadonlyArray<Thread>, turns: ReadonlyArray<Turn>): State => ({
  threads: new Map(threads.map((x) => [x.id, clone(x)])),
  turns: new Map(turns.map((x) => [x.id, clone(x)])),
  receipts: new Map(),
  routes: new Map(),
  results: new Map(),
  relationships: [],
  revisions: new Map(),
})
const reject = (reason: AdmissionRejected["reason"], message: string) => AdmissionRejected.make({ reason, message })

export interface MemoryInput {
  readonly threads?: ReadonlyArray<Thread>
  readonly turns?: ReadonlyArray<Turn>
}

export const makeMemory = (seed: MemoryInput = {}) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState(seed.threads ?? [], seed.turns ?? []))
    const admit = (kind: "create" | "message", input: CreateThreadInput | AppendThreadMessageInput) =>
      Ref.modify(state, (current): [Effect.Effect<AcceptedThreadTurn, Failure>, State] => {
        const old = current.receipts.get(input.invocationDigest)
        if (old !== undefined)
          return old.input === input.schemaInputDigest && old.kind === kind
            ? [Effect.succeed(clone(old.value as AcceptedThreadTurn)), current]
            : [Effect.fail(InvocationConflict.make({ invocationDigest: input.invocationDigest })), current]
        const source = current.threads.get(input.sourceThreadId)
        if (source === undefined || source.archived)
          return [Effect.fail(reject("source-unavailable", "Source Thread is unavailable")), current]
        if (input.threadCreationDepth > input.maximumDepth)
          return [Effect.fail(reject("depth", "Thread creation depth exceeded")), current]
        const related = [...current.turns.values()].filter(
          (x) => x.author._tag === "Agent" && x.author.sourceRootTurnId === input.sourceRootTurnId,
        ).length
        if (related >= input.maximumAdmissions)
          return [Effect.fail(reject("admission-limit", "Admission limit exceeded")), current]
        const workspaceActive = [...current.turns.values()].filter(
          (x) =>
            TurnResult.isAgentExecution(x) &&
            x.author._tag === "Agent" &&
            !terminal(x.status) &&
            current.threads.get(x.threadId)?.workspace === source.workspace,
        ).length
        if (workspaceActive >= input.maximumWorkspaceActive)
          return [Effect.fail(reject("workspace-active-limit", "Workspace active limit exceeded")), current]
        const targetId =
          kind === "create" ? (input as CreateThreadInput).threadId : (input as AppendThreadMessageInput).targetThreadId
        const target = kind === "create" ? undefined : current.threads.get(targetId)
        if (kind === "message" && targetId === input.sourceThreadId)
          return [Effect.fail(reject("self", "A Thread cannot message itself")), current]
        if (kind === "message" && target === undefined)
          return [Effect.fail(reject("target-unavailable", "Target Thread does not exist")), current]
        if (target?.archived === true) return [Effect.fail(reject("archived", "Target Thread is archived")), current]
        if (target !== undefined && target.workspace !== source.workspace)
          return [Effect.fail(reject("workspace", "Threads must share a Workspace")), current]
        const existingActive = [...current.turns.values()].some((x) => x.threadId === targetId && active(x))
        const queued = [...current.turns.values()].filter(
          (x) => x.threadId === targetId && x.status === "queued",
        ).length
        if (existingActive && queued >= input.queueCapacity)
          return [
            Effect.fail(QueueFull.make({ threadId: targetId, capacity: input.queueCapacity, count: queued })),
            current,
          ]
        const status = existingActive ? ("queued" as const) : ("accepted" as const)
        const revision = (current.revisions.get(targetId) ?? 0) + (status === "queued" ? 1 : 0)
        const turn: Turn = {
          _tag: "AgentExecution",
          id: input.turnId,
          threadId: targetId,
          prompt: input.prompt,
          status,
          stopIntent: "none",
          executionRoute: clone(input.executionRoute),
          author: {
            _tag: "Agent",
            sourceThreadId: input.sourceThreadId,
            sourceRootTurnId: input.sourceRootTurnId,
            threadCreationDepth: input.threadCreationDepth,
          },
          lineage: { _tag: "Original" },
          createdAt: input.now,
          updatedAt: input.now,
        }
        const accepted: AcceptedThreadTurn = {
          threadId: targetId,
          turnId: input.turnId,
          status,
          ...(status === "queued" ? { queueRevision: revision } : {}),
        }
        const nextThreads = new Map(current.threads)
        if (kind === "create")
          nextThreads.set(targetId, {
            id: targetId,
            workspace: source.workspace,
            title: (input as CreateThreadInput).title,
            labels: [],
            pinned: false,
            archived: false,
            lineage: { _tag: "Original" },
            createdAt: input.now,
            updatedAt: input.now,
          })
        const route: ResultRoute = {
          targetTurnId: input.turnId,
          kind: input.resultDelivery,
          ...(input.resultDelivery === "reply"
            ? { sourceThreadId: input.sourceThreadId, sourceTurnId: input.sourceRootTurnId }
            : {}),
          delivery: "awaiting-result",
          createdAt: input.now,
          updatedAt: input.now,
        }
        const relationship: ThreadRelationship = {
          kind: kind === "create" ? "created" : "message",
          sourceThreadId: input.sourceThreadId,
          sourceTurnId: input.sourceRootTurnId,
          targetThreadId: targetId,
          targetTurnId: input.turnId,
          createdAt: input.now,
        }
        return [
          Effect.succeed(clone(accepted)),
          {
            ...current,
            threads: nextThreads,
            turns: new Map(current.turns).set(turn.id, turn),
            receipts: new Map(current.receipts).set(input.invocationDigest, {
              digest: input.invocationDigest,
              input: input.schemaInputDigest,
              kind,
              value: accepted,
            }),
            routes: new Map(current.routes).set(turn.id, route),
            relationships: [...current.relationships, relationship],
            revisions: status === "queued" ? new Map(current.revisions).set(targetId, revision) : current.revisions,
          },
        ]
      }).pipe(Effect.flatten)
    const bind = (kind: "steer" | "cancel" | "stop", input: BindThreadControlInput) =>
      Ref.modify(state, (current): [Effect.Effect<BoundThreadControl, RepositoryError | InvocationConflict>, State] => {
        const old = current.receipts.get(input.invocationDigest)
        if (old !== undefined)
          return old.input === input.schemaInputDigest && old.kind === kind
            ? [Effect.succeed(clone(old.value as BoundThreadControl)), current]
            : [Effect.fail(InvocationConflict.make({ invocationDigest: input.invocationDigest })), current]
        const root = [...current.turns.values()]
          .filter((x) => x.threadId === input.targetThreadId && active(x))
          .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
        let value: BoundThreadControl =
          root === undefined
            ? { targetThreadId: input.targetThreadId, outcome: "no-active" }
            : { targetThreadId: input.targetThreadId, targetTurnId: root.id, outcome: "bound" }
        let next = current
        if (kind === "stop") {
          const stopped = [...current.turns.values()]
            .filter(TurnResult.isAgentExecution)
            .filter((x) => x.threadId === input.targetThreadId && x.status === "queued")
          const revision = (current.revisions.get(input.targetThreadId) ?? 0) + (stopped.length > 0 ? 1 : 0)
          const changed = new Map(current.turns)
          for (const item of stopped) changed.set(item.id, { ...item, status: "cancelled", updatedAt: input.now })
          value = { ...value, queueRevision: revision, stoppedTurnIds: stopped.map((x) => x.id) }
          next = {
            ...current,
            turns: changed,
            revisions: new Map(current.revisions).set(input.targetThreadId, revision),
          }
        }
        return [
          Effect.succeed(clone(value)),
          {
            ...next,
            receipts: new Map(next.receipts).set(input.invocationDigest, {
              digest: input.invocationDigest,
              input: input.schemaInputDigest,
              kind,
              value,
            }),
          },
        ]
      }).pipe(Effect.flatten)
    return Service.of({
      createThread: (input) => admit("create", input),
      appendMessage: (input) => admit("message", input),
      bindSteer: (input) => bind("steer", input),
      bindCancel: (input) => bind("cancel", input),
      bindStop: (input) => bind("stop", input),
      settleResult: (input) =>
        Ref.modify(state, (current) => {
          const route = current.routes.get(input.targetTurnId)
          if (route === undefined || route.delivery !== "awaiting-result") return [undefined, current]
          const settled: ResultRoute =
            input.result.status === "completed"
              ? {
                  ...route,
                  delivery: "ready",
                  readySequence: input.result.sequence,
                  updatedAt: input.now,
                }
              : { ...route, delivery: input.result.status, updatedAt: input.now }
          return [
            clone(settled),
            {
              ...current,
              routes: new Map(current.routes).set(input.targetTurnId, settled),
              results: new Map(current.results).set(input.targetTurnId, clone(input.result)),
            },
          ]
        }),
      deliverResult: (input) =>
        Ref.modify(state, (current): [Effect.Effect<DeliveredThreadResult, QueueFull | ResultNotReady>, State] => {
          const route = current.routes.get(input.targetTurnId)
          if (route?.delivery === "delivered")
            return [
              Effect.succeed({
                targetTurnId: input.targetTurnId,
                delivery: "delivered",
                ...(route.deliveredTurnId === undefined ? {} : { deliveredTurnId: route.deliveredTurnId }),
              }),
              current,
            ]
          if (route === undefined || route.delivery !== "ready")
            return [Effect.fail(ResultNotReady.make({ targetTurnId: input.targetTurnId })), current]
          if (route.kind === "manual")
            return [Effect.fail(ResultNotReady.make({ targetTurnId: input.targetTurnId })), current]
          const result = current.results.get(input.targetTurnId)
          if (result?.status !== "completed")
            return [Effect.fail(ResultNotReady.make({ targetTurnId: input.targetTurnId })), current]
          const source = route.sourceThreadId === undefined ? undefined : current.threads.get(route.sourceThreadId)
          if (source === undefined || source.archived) {
            const unavailable: ResultRoute = { ...route, delivery: "source-unavailable", updatedAt: input.now }
            return [
              Effect.succeed({ targetTurnId: input.targetTurnId, delivery: "source-unavailable" }),
              { ...current, routes: new Map(current.routes).set(input.targetTurnId, unavailable) },
            ]
          }
          const running = [...current.turns.values()].some((x) => x.threadId === source.id && active(x))
          const count = [...current.turns.values()].filter(
            (x) => TurnResult.isAgentExecution(x) && x.threadId === source.id && x.status === "queued",
          ).length
          if (running && count >= input.queueCapacity)
            return [Effect.fail(QueueFull.make({ threadId: source.id, capacity: input.queueCapacity, count })), current]
          const target = current.turns.get(input.targetTurnId)!
          if (!TurnResult.isAgentExecution(target))
            return [Effect.fail(ResultNotReady.make({ targetTurnId: input.targetTurnId })), current]
          const depth = target.author._tag === "Agent" ? target.author.threadCreationDepth : 0
          const turn: Turn = {
            _tag: "AgentExecution",
            id: input.deliveredTurnId,
            threadId: source.id,
            prompt: result.output,
            status: running ? "queued" : "accepted",
            stopIntent: "none",
            executionRoute: target.executionRoute,
            author: {
              _tag: "Agent",
              sourceThreadId: target.threadId,
              sourceRootTurnId: target.id,
              threadCreationDepth: depth,
            },
            lineage: { _tag: "Original" },
            createdAt: input.now,
            updatedAt: input.now,
          }
          const delivered: ResultRoute = {
            ...route,
            delivery: "delivered",
            deliveredTurnId: turn.id,
            updatedAt: input.now,
          }
          const relationship: ThreadRelationship = {
            kind: "reply",
            sourceThreadId: target.threadId,
            sourceTurnId: target.id,
            targetThreadId: source.id,
            targetTurnId: turn.id,
            createdAt: input.now,
          }
          return [
            Effect.succeed({ targetTurnId: input.targetTurnId, delivery: "delivered", deliveredTurnId: turn.id }),
            {
              ...current,
              turns: new Map(current.turns).set(turn.id, turn),
              routes: new Map(current.routes).set(input.targetTurnId, delivered),
              relationships: [...current.relationships, relationship],
              revisions: running
                ? new Map(current.revisions).set(source.id, (current.revisions.get(source.id) ?? 0) + 1)
                : current.revisions,
            },
          ]
        }).pipe(Effect.flatten),
      getStatus: (id) =>
        Ref.get(state).pipe(
          Effect.map((x) => x.threads.get(id)),
          Effect.map((x) => (x === undefined ? undefined : clone(x))),
        ),
      getMessages: (id) =>
        Ref.get(state).pipe(
          Effect.map((x) =>
            [...x.turns.values()]
              .filter((t) => t.threadId === id)
              .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
              .map(clone),
          ),
        ),
      getResultRoute: (id) =>
        Ref.get(state).pipe(
          Effect.map((x) => x.routes.get(id)),
          Effect.map((x) => (x === undefined ? undefined : clone(x))),
        ),
      getRootResult: (id) =>
        Ref.get(state).pipe(
          Effect.map((x) => x.results.get(id)),
          Effect.map((x) => (x === undefined ? undefined : clone(x))),
        ),
      listRelationships: (id, limit = 20, before) =>
        Ref.get(state).pipe(
          Effect.map((x) =>
            x.relationships
              .filter((relationship) => relationship.sourceThreadId === id || relationship.targetThreadId === id)
              .filter(
                (relationship) =>
                  before === undefined ||
                  relationship.createdAt < before.createdAt ||
                  (relationship.createdAt === before.createdAt && relationship.targetTurnId > before.targetTurnId),
              )
              .toSorted(
                (left, right) =>
                  right.createdAt - left.createdAt || left.targetTurnId.localeCompare(right.targetTurnId),
              )
              .slice(0, Math.max(1, limit))
              .map(clone),
          ),
        ),
      listUndeliveredResults: (limit = 50, after) =>
        Ref.get(state).pipe(
          Effect.map((x) =>
            [...x.routes.values()]
              .filter((r) => r.delivery === "awaiting-result" || (r.kind === "reply" && r.delivery === "ready"))
              .filter((r) => after === undefined || r.targetTurnId > after.targetTurnId)
              .toSorted((a, b) => a.targetTurnId.localeCompare(b.targetTurnId))
              .slice(0, Math.max(1, limit))
              .map(clone),
          ),
        ),
      listReadyResults: (limit = 50) =>
        Ref.get(state).pipe(
          Effect.map((x) =>
            [...x.routes.values()]
              .filter((r) => r.kind === "reply" && r.delivery === "ready")
              .toSorted((a, b) => a.updatedAt - b.updatedAt || a.targetTurnId.localeCompare(b.targetTurnId))
              .slice(0, Math.max(1, limit))
              .map(clone),
          ),
        ),
    })
  })
export const memoryLayer = (input: MemoryInput = {}) => Layer.effect(Service, makeMemory(input))
