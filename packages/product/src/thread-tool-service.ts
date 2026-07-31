import { createHash, randomUUID } from "node:crypto"
import * as ThreadInteractionRepository from "@rika/product/thread-interaction-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { ExecutionStatus, ThreadTools, ToolInvocation } from "@rika/coding-tools/coding-tool-catalog"
import { Clock, Context, Effect, Ref, Schema } from "effect"
import type * as RootTurnOwner from "./root-turn-owner"
import { clampThreadTitle } from "./thread-title"
import * as ThreadState from "@rika/product/thread-state"
import { ModeId } from "@rika/configuration/behavior-mode"

export interface Options {
  readonly scheduler: Pick<RootTurnOwner.Interface, "accepted">
  readonly id?: () => string
}

export class Configuration extends Context.Service<Configuration, Options>()(
  "@rika/product/thread-tool-service/Configuration",
) {}

type Failure = { readonly _tag: string }

export interface Interface {
  readonly createThread: (
    invocation: ToolInvocation.Value,
    input: typeof ThreadTools.CreateThreadInput.Type,
  ) => Effect.Effect<typeof ThreadTools.AcceptedSuccess.Type, Failure>
  readonly interact: (
    invocation: ToolInvocation.Value,
    input: typeof ThreadTools.ThreadInteractInput.Type,
  ) => Effect.Effect<typeof ThreadTools.ThreadInteractSuccess.Type, Failure>
  readonly waitForThreads: (
    invocation: ToolInvocation.Value,
    input: typeof ThreadTools.WaitForThreadsInput.Type,
  ) => Effect.Effect<typeof ThreadTools.WaitForThreadsSuccess.Type, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@rika/product/thread-tool-service/Service") {}

export class GatewayUnavailable extends Schema.TaggedErrorClass<GatewayUnavailable>()("ThreadToolGatewayUnavailable", {
  state: Schema.Literals(["uninstalled", "installed", "closed"]),
}) {}

export interface Gateway {
  readonly install: (service: Interface) => Effect.Effect<void, GatewayUnavailable>
  readonly createThread: Interface["createThread"]
  readonly interact: Interface["interact"]
  readonly waitForThreads: Interface["waitForThreads"]
}

type GatewayState =
  | { readonly _tag: "Uninstalled" }
  | { readonly _tag: "Installed"; readonly service: Interface }
  | { readonly _tag: "Closed" }

export const makeGateway = Effect.gen(function* () {
  const state = yield* Ref.make<GatewayState>({ _tag: "Uninstalled" })
  yield* Effect.addFinalizer(() => Ref.set(state, { _tag: "Closed" }))
  const service = Ref.get(state).pipe(
    Effect.flatMap((current) =>
      current._tag === "Installed"
        ? Effect.succeed(current.service)
        : Effect.fail(GatewayUnavailable.make({ state: current._tag === "Closed" ? "closed" : "uninstalled" })),
    ),
  )
  return {
    install: (implementation) =>
      Ref.modify(state, (current): [Effect.Effect<void, GatewayUnavailable>, GatewayState] =>
        current._tag === "Uninstalled"
          ? [Effect.void, { _tag: "Installed", service: implementation }]
          : [
              Effect.fail(GatewayUnavailable.make({ state: current._tag === "Closed" ? "closed" : "installed" })),
              current,
            ],
      ).pipe(Effect.flatten),
    createThread: (invocation, input) =>
      service.pipe(Effect.flatMap((implementation) => implementation.createThread(invocation, input))),
    interact: (invocation, input) =>
      service.pipe(Effect.flatMap((implementation) => implementation.interact(invocation, input))),
    waitForThreads: (invocation, input) =>
      service.pipe(Effect.flatMap((implementation) => implementation.waitForThreads(invocation, input))),
  } satisfies Gateway
})

const limits = { maximumDepth: 3, maximumAdmissions: 8, maximumWorkspaceActive: 8, queueCapacity: 8 }
const delivery = (value: "reply" | "manual" | undefined) => value ?? "reply"
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const terminal = ExecutionStatus.isTerminalStatus
const state = (turns: ReadonlyArray<Turn.Turn>): ThreadTools.ThreadState =>
  ThreadState.threadState(turns.map((turn) => turn.status))

export const make = Effect.fn("ThreadToolService.make")(function* (options: Options) {
  const interactions = yield* ThreadInteractionRepository.Service
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const forInvocation = (invocation: ToolInvocation.Value) =>
    Effect.gen(function* () {
      const source = yield* backend.resolveInvocationSource(invocation.executionId)
      const sourceTurnId = Turn.TurnId.make(source.rootTurnId)
      const sourceThreadId = Thread.ThreadId.make(source.threadId)
      const sourceTurn = yield* turns.get(sourceTurnId)
      if (sourceTurn === undefined || !Turn.isAgentExecution(sourceTurn) || sourceTurn.threadId !== sourceThreadId)
        return yield* Effect.fail({ _tag: "InvocationAuthorityUnavailable" } as const)
      const id = options.id ?? randomUUID
      const invocationInput = (input: unknown) => ({
        invocationDigest: invocation.idempotencyKeyDigest,
        schemaInputDigest: digest(input),
        sourceThreadId,
        sourceRootTurnId: sourceTurnId,
        now: invocation.createdAt,
      })
      const executionRoute = (mode?: ModeId) =>
        mode === undefined ? sourceTurn.executionRoute : { ...sourceTurn.executionRoute, mode }
      const schedule = (accepted: ThreadInteractionRepository.AcceptedThreadTurn) =>
        accepted.status === "accepted"
          ? options.scheduler
              .accepted(accepted.turnId)
              .pipe(Effect.mapError(() => ({ _tag: "ThreadSchedulingFailed" }) as const))
          : Effect.void
      const createThread = (input: typeof ThreadTools.CreateThreadInput.Type) =>
        Effect.gen(function* () {
          const resultDelivery = delivery(input.resultDelivery)
          const accepted = yield* interactions.createThread({
            ...invocationInput(input),
            ...limits,
            threadId: Thread.ThreadId.make(id()),
            turnId: Turn.TurnId.make(id()),
            prompt: input.prompt,
            title: clampThreadTitle(input.prompt),
            executionRoute: executionRoute(input.mode),
            resultDelivery,
            threadCreationDepth: source.threadCreationDepth + 1,
          })
          yield* schedule(accepted)
          return {
            schemaVersion: 2 as const,
            threadId: accepted.threadId,
            turnId: accepted.turnId,
            resultDelivery,
            state: accepted.status === "queued" ? ("queued" as const) : ("running" as const),
          }
        })
      const interact = (input: typeof ThreadTools.ThreadInteractInput.Type) =>
        Effect.gen(function* () {
          if ((input.action === "message" || input.action === "steer") && input.message === undefined)
            return yield* Effect.fail({ _tag: "ThreadInteractMessageRequired" } as const)
          const messageText = input.message ?? ""
          const threadId = Thread.ThreadId.make(input.threadId)
          if (input.action === "message") {
            const resultDelivery = delivery(input.resultDelivery)
            const accepted = yield* interactions.appendMessage({
              ...invocationInput(input),
              ...limits,
              targetThreadId: threadId,
              turnId: Turn.TurnId.make(id()),
              prompt: messageText,
              executionRoute: executionRoute(input.mode),
              resultDelivery,
              threadCreationDepth: source.threadCreationDepth + 1,
            })
            yield* schedule(accepted)
            return {
              schemaVersion: 2 as const,
              threadId,
              turnId: accepted.turnId,
              resultDelivery,
              state: accepted.status === "queued" ? ("queued" as const) : ("running" as const),
            }
          }
          const messages = yield* interactions.getMessages(threadId)
          const target = yield* interactions.getStatus(threadId)
          if (target === undefined) return yield* Effect.fail({ _tag: "ThreadNotFound" } as const)
          const sourceThread = yield* interactions.getStatus(sourceThreadId)
          if (sourceThread === undefined || sourceThread.workspace !== target.workspace)
            return yield* Effect.fail({ _tag: "ThreadWorkspaceMismatch" } as const)
          if (input.action === "status")
            return {
              schemaVersion: 2 as const,
              action: "status" as const,
              selector: {
                threadId,
                ...(messages.find((x) => !terminal(x.status) && x.status !== "queued")?.id === undefined
                  ? {}
                  : { turnId: messages.find((x) => !terminal(x.status) && x.status !== "queued")!.id }),
              },
              state: state(messages),
              detail: `${messages.filter((x) => x.status === "queued").length} queued`,
              truncated: false,
            }
          if (input.action === "preview_messages") {
            const limit = input.limit ?? ThreadTools.previewDefaultLimit
            const end =
              input.cursor === undefined
                ? messages.length
                : messages.findIndex((message) => message.id === input.cursor)
            if (end < 0) return yield* Effect.fail({ _tag: "ThreadMessageCursorInvalid" } as const)
            const start = Math.max(0, end - limit)
            const page = messages.slice(start, end).toReversed()
            return {
              schemaVersion: 2 as const,
              action: "preview_messages" as const,
              selector: { threadId },
              state: state(messages),
              messages: page.map((item) => ({
                messageId: item.id,
                role: item.author._tag === "Human" ? "human" : "agent",
                text: item.prompt.slice(0, 256),
                truncated: item.prompt.length > 256,
              })),
              ...(start === 0 || page.at(-1) === undefined ? {} : { nextCursor: page.at(-1)!.id }),
              truncated: start > 0,
            }
          }
          const controlInput = { ...invocationInput(input), targetThreadId: threadId }
          let control
          if (input.action === "steer") control = interactions.bindSteer(controlInput)
          else if (input.action === "cancel") control = interactions.bindCancel(controlInput)
          else control = interactions.bindStop(controlInput)
          const bound = yield* control
          if (input.action === "steer" && bound.targetTurnId !== undefined)
            yield* backend.steer(bound.targetTurnId, messageText, invocation.idempotencyKeyDigest)
          if (input.action !== "steer" && bound.targetTurnId !== undefined) {
            const cancelledBeforeStart = yield* turns.cancelAccepted(bound.targetTurnId, invocation.createdAt)
            if (!cancelledBeforeStart) yield* backend.cancel(bound.targetTurnId)
          }
          return {
            schemaVersion: 2 as const,
            action: input.action,
            selector: { threadId, ...(bound.targetTurnId === undefined ? {} : { turnId: bound.targetTurnId }) },
            state: state(yield* interactions.getMessages(threadId)),
            detail: bound.outcome === "bound" ? `bound ${bound.targetTurnId}` : bound.outcome,
            truncated: false,
          }
        })
      const waitForThreads = (input: typeof ThreadTools.WaitForThreadsInput.Type) =>
        Effect.gen(function* () {
          const inspectTargets = Effect.forEach(input.targets, (target) =>
            Effect.gen(function* () {
              const turnId = Turn.TurnId.make(target.turnId)
              if (turnId === sourceTurnId) return yield* Effect.fail({ _tag: "ThreadWaitSelfTarget" } as const)
              const thread = yield* interactions.getStatus(Thread.ThreadId.make(target.threadId))
              const sourceThread = yield* interactions.getStatus(sourceThreadId)
              const items = thread === undefined ? [] : yield* interactions.getMessages(thread.id)
              const turn = items.find((item) => item.id === turnId)
              if (
                thread === undefined ||
                sourceThread?.workspace !== thread.workspace ||
                turn === undefined ||
                turn.threadId !== thread.id
              )
                return yield* Effect.fail({ _tag: "ThreadWorkspaceMismatch" } as const)
              const resultRoute = yield* interactions.getResultRoute(turnId)
              if (resultRoute === undefined)
                return yield* Effect.fail({ _tag: "ThreadResultRouteUnavailable" } as const)
              const rootResult = yield* interactions.getRootResult(turnId)
              let text = "Waiting"
              let pending = true
              if (rootResult?.status === "completed") {
                text = rootResult.output
                pending = false
              } else if (rootResult?.status === "failed") {
                text = rootResult.reason ?? "failed"
                pending = false
              } else if (rootResult?.status === "cancelled") {
                text = rootResult.reason ?? "cancelled"
                pending = false
              }
              const truncated = text.length > 3_000
              return {
                pending,
                result: {
                  threadId: target.threadId,
                  turnId: target.turnId,
                  state: state(items),
                  resultDelivery: resultRoute.kind,
                  text: text.slice(0, 3_000),
                  truncated,
                },
              }
            }),
          )
          const deadline = invocation.createdAt + (input.timeoutSeconds ?? 300) * 1_000
          let results = yield* inspectTargets
          while (results.some((result) => result.pending) && (yield* Clock.currentTimeMillis) < deadline) {
            yield* Effect.sleep("100 millis")
            results = yield* inspectTargets
          }
          return {
            schemaVersion: 2 as const,
            targets: results.map((result) => result.result),
            timedOut: results.some((result) => result.pending),
            truncated: false,
          }
        })
      return { createThread, interact, waitForThreads }
    })
  return Service.of({
    createThread: (invocation, input) =>
      forInvocation(invocation).pipe(Effect.flatMap((service) => service.createThread(input))),
    interact: (invocation, input) =>
      forInvocation(invocation).pipe(Effect.flatMap((service) => service.interact(input))),
    waitForThreads: (invocation, input) =>
      forInvocation(invocation).pipe(Effect.flatMap((service) => service.waitForThreads(input))),
  })
})
