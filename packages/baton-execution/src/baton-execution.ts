import { ModelRegistry, SandboxExecutor } from "@batonfx/core"
import { Run, RunTree, Runtime } from "@batonfx/runtime"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import type { Status } from "@rika/product/execution-status"
import { Cause, Context, Effect, Layer, Stream } from "effect"
import type { AgentToolHandlers } from "./baton-route"
import { configure, makeResolver } from "./baton-route"
export { projectEvent } from "./baton-event-projection"
import { projectEvent, titleInvocationId } from "./baton-event-projection"

export type AgentToolServices = AgentToolHandlers

export type SandboxService = (typeof SandboxExecutor.SandboxExecutor)["Identifier"]

export interface Options {
  readonly filename: string
  readonly agentServices?: (workspace: string) => Layer.Layer<AgentToolServices, never, never>
  readonly modelServices?: Layer.Layer<ModelRegistry.ModelRegistry, never, never>
  readonly subscriberQueueCapacity?: number
}

const message = (cause: unknown) => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  const encoded = JSON.stringify(cause)
  return encoded === undefined || encoded === "{}" ? String(cause) : encoded
}
const prompt = (input: ExecutionGateway.StartTurn) =>
  input.promptParts === undefined
    ? input.prompt
    : [
        {
          role: "user" as const,
          content: input.promptParts.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : {
                  type: "file" as const,
                  mediaType: part.mediaType,
                  data: part.data,
                  ...(part.filename === undefined ? {} : { fileName: part.filename }),
                },
          ),
        },
      ]

const status = (value: Run.RunStatus): Status => {
  switch (value) {
    case "queued":
      return "queued"
    case "waiting":
      return "waiting"
    case "succeeded":
      return "completed"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "running":
    case "needs-resolution":
    case "cancelling":
      return "running"
  }
}

const make = (options: Options, sandbox: SandboxExecutor.Interface) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime

    return ExecutionGateway.Service.of({
      startTurn: (input) =>
        Effect.gen(function* () {
          const configured = yield* configure({
            executionRoute: input.executionRoute,
            workspace: input.workspace,
            sandbox,
            ...(options.agentServices === undefined ? {} : { agentServices: options.agentServices(input.workspace) }),
            ...(options.modelServices === undefined ? {} : { modelServices: options.modelServices }),
          })
          const receipt = yield* runtime.start({
            executable: configured.executable,
            registrations: configured.registrations,
            sessionId: input.threadId,
            idempotencyKey: input.turnId,
            prompt: prompt(input),
            metadata: { threadId: input.threadId, turnId: input.turnId },
            ...(input.titleIntent === undefined
              ? {}
              : {
                  initialChildren: [
                    {
                      invocationId: titleInvocationId,
                      selection: "Title",
                      prompt: `Generate a title for this request:\n\n${input.prompt}`,
                      idempotencyKey: `${input.turnId}:title`,
                      sessionId: input.threadId,
                      metadata: {
                        threadId: input.threadId,
                        turnId: input.turnId,
                        productIntent: "thread-title",
                        expectedTitle: input.titleIntent.expectedTitle,
                      },
                    },
                  ],
                }),
            ...(input.reviewIntent === undefined
              ? {}
              : {
                  initialFanOuts: [
                    {
                      idempotencyKey: `${input.turnId}:review`,
                      members: input.reviewIntent.lanes.map((lane) => ({
                        key: lane.key,
                        selection: "Review",
                        prompt: lane.prompt,
                        sessionId: input.threadId,
                        metadata: {
                          threadId: input.threadId,
                          turnId: input.turnId,
                          productIntent: "review",
                          reviewLane: lane.key,
                        },
                      })),
                      concurrency: input.reviewIntent.concurrency,
                      join: { _tag: "AllSettled" },
                      remainder: "await",
                    },
                  ],
                }),
          })
          return { runId: receipt.runId, turnId: input.turnId, threadId: input.threadId }
        }).pipe(Effect.mapError((cause) => ExecutionGateway.StartTurnFailure.make({ message: message(cause) }))),
      cancelTurn: (link, reason) =>
        runtime
          .cancel({ runId: link.runId, reason: reason ?? "Cancelled by Rika" })
          .pipe(Effect.mapError((cause) => ExecutionGateway.CancelTurnFailure.make({ message: message(cause) }))),
      steerTurn: (link, input) =>
        runtime
          .steer({ runId: link.runId, idempotencyKey: input.idempotencyKey, prompt: input.text })
          .pipe(Effect.mapError((cause) => ExecutionGateway.SteeringFailure.make({ message: message(cause) }))),
      watchTurn: (link, cursor) =>
        RunTree.watch({
          rootRunId: link.runId,
          settlement: "root-blocked",
          ...(cursor === undefined ? {} : { cursor: RunTree.TreeCursor.make(cursor) }),
        }).pipe(
          Stream.provideService(Runtime.Runtime, runtime),
          Stream.flatMap(({ event, cursor: eventCursor, invocationId, parentRunId }) =>
            Stream.fromIterable(projectEvent({ source: event, cursor: eventCursor, invocationId, parentRunId })),
          ),
          Stream.mapError((cause) => ExecutionGateway.WatchTurnFailure.make({ message: message(cause) })),
        ),
      inspectTurn: (link) =>
        RunTree.inspect(link.runId).pipe(
          Effect.provideService(Runtime.Runtime, runtime),
          Effect.map((inspection) => {
            const root = inspection.runs.find(({ run }) => run.runId === link.runId)
            return root === undefined
              ? { status: "unavailable" as const }
              : { status: status(root.run.status), cursor: inspection.cursor }
          }),
          Effect.catchTag("@batonfx/runtime/RunNotFound", () => Effect.succeed({ status: "unavailable" as const })),
          Effect.mapError((cause) => ExecutionGateway.InspectTurnFailure.make({ message: message(cause) })),
        ),
    })
  })

export const layer = (
  options: Options,
): Layer.Layer<ExecutionGateway.Service, ExecutionGateway.StartTurnFailure, SandboxService> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const context = yield* Effect.context<SandboxService>()
      const sandbox = Context.get(context, SandboxExecutor.SandboxExecutor)
      const runtimeLayer = Runtime.layerSqlite({
        filename: options.filename,
        resolver: makeResolver({ ...options, sandbox }),
        addresses: [],
        ...(options.subscriberQueueCapacity === undefined
          ? {}
          : { subscriberQueueCapacity: options.subscriberQueueCapacity }),
      })
      return Layer.effect(ExecutionGateway.Service, make(options, sandbox)).pipe(
        Layer.provide(runtimeLayer),
        Layer.catchCause((cause) =>
          Layer.effectContext(
            Effect.fail(ExecutionGateway.StartTurnFailure.make({ message: message(Cause.squash(cause)) })),
          ),
        ),
      )
    }),
  )
