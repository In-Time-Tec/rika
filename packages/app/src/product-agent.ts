import * as ExecutionBackend from "@rika/runtime/contract"
import type { AgentTools } from "@rika/tools"
import { Context, Effect, Layer, Schema } from "effect"

export const Profile = Schema.Literals(["Oracle", "Librarian", "Painter", "Review", "ReadThread", "Task"])
export type Profile = typeof Profile.Type

export interface InvokeInput {
  readonly parentTurnId: string
  readonly childId: string
  readonly profile: Profile
  readonly prompt: string
}

export interface ChildEvent {
  readonly parentTurnId: string
  readonly childId: string
  readonly profile: Profile
  readonly type: "accepted"
}

export interface TaskInput {
  readonly id: string
  readonly prompt: string
  readonly profile?: Profile
  readonly model?: AgentTools.Model
}

export interface ParallelInput {
  readonly parentTurnId: string
  readonly fanOutId: string
  readonly workspace?: string
  readonly executionRoute: ExecutionBackend.ExecutionRoutePin
  readonly tasks: ReadonlyArray<TaskInput>
  readonly maxConcurrency: number
  readonly join?: ExecutionBackend.JoinPolicy
  readonly quorum?: number
  readonly createdAt: number
}

export class InvocationError extends Schema.TaggedErrorClass<InvocationError>()("ProductAgentInvocationError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly invoke: (input: InvokeInput) => Effect.Effect<ChildEvent, InvocationError>
  readonly fanOut: (
    input: ExecutionBackend.FanOutInput,
  ) => Effect.Effect<ExecutionBackend.FanOutInspection, InvocationError>
  readonly inspectFanOut: (id: string) => Effect.Effect<ExecutionBackend.FanOutInspection | undefined, InvocationError>
  readonly cancelFanOut: (
    id: string,
    at: number,
    reason?: string,
  ) => Effect.Effect<ExecutionBackend.FanOutInspection, InvocationError>
  readonly runParallel: (input: ParallelInput) => Effect.Effect<ExecutionBackend.FanOutInspection, InvocationError>
  readonly runReviewLanes: (
    input: Omit<ParallelInput, "tasks"> & { readonly checks: ReadonlyArray<TaskInput> },
  ) => Effect.Effect<ExecutionBackend.FanOutInspection, InvocationError>
  readonly projectChildren: (
    inspection: ExecutionBackend.FanOutInspection,
  ) => ReadonlyArray<ExecutionBackend.ChildProjection>
  readonly cancelChild: (id: string, at: number) => Effect.Effect<ExecutionBackend.Result, InvocationError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/app/product-agent/Service") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const backend = yield* ExecutionBackend.Service
    return Service.of({
      invoke: Effect.fn("ProductAgent.invoke")((input) =>
        backend.invokeChild(input).pipe(Effect.mapError((cause) => InvocationError.make({ message: cause.message }))),
      ),
      fanOut: Effect.fn("ProductAgent.fanOut")((input) =>
        backend.createFanOut(input).pipe(Effect.mapError((cause) => InvocationError.make({ message: cause.message }))),
      ),
      inspectFanOut: Effect.fn("ProductAgent.inspectFanOut")((id) =>
        backend.inspectFanOut(id).pipe(Effect.mapError((cause) => InvocationError.make({ message: cause.message }))),
      ),
      cancelFanOut: Effect.fn("ProductAgent.cancelFanOut")((id, at, reason) =>
        backend
          .cancelFanOut(id, at, reason)
          .pipe(Effect.mapError((cause) => InvocationError.make({ message: cause.message }))),
      ),
      cancelChild: Effect.fn("ProductAgent.cancelChild")((id, at) =>
        backend
          .cancel(id, at, ExecutionBackend.executionReference)
          .pipe(Effect.mapError((cause) => InvocationError.make({ message: cause.message }))),
      ),
      runParallel: Effect.fn("ProductAgent.runParallel")((input) =>
        backend
          .createFanOut({
            parentTurnId: input.parentTurnId,
            fanOutId: input.fanOutId,
            ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
            executionRoute: input.executionRoute,
            children: input.tasks.map((task) => ({
              childId: task.id,
              profile: task.profile ?? selectProfile(task.prompt),
              prompt: task.prompt,
              ...(task.model === undefined ? {} : { model: task.model }),
            })),
            maxConcurrency: input.maxConcurrency,
            join: input.join ?? "all",
            ...(input.quorum === undefined ? {} : { quorum: input.quorum }),
            createdAt: input.createdAt,
          })
          .pipe(Effect.mapError((cause) => InvocationError.make({ message: cause.message }))),
      ),
      runReviewLanes: Effect.fn("ProductAgent.runReviewLanes")((input) =>
        backend
          .createFanOut({
            parentTurnId: input.parentTurnId,
            fanOutId: input.fanOutId,
            ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
            executionRoute: input.executionRoute,
            children: input.checks.map((check) => ({ childId: check.id, profile: "Review", prompt: check.prompt })),
            maxConcurrency: input.maxConcurrency,
            join: input.join ?? "best-effort",
            ...(input.quorum === undefined ? {} : { quorum: input.quorum }),
            createdAt: input.createdAt,
          })
          .pipe(Effect.mapError((cause) => InvocationError.make({ message: cause.message }))),
      ),
      projectChildren: (inspection) =>
        inspection.members.map((member) => ({
          parentTurnId: inspection.parentTurnId,
          fanOutId: inspection.fanOutId,
          childId: member.childId,
          ordinal: member.ordinal,
          state: member.state,
          ...(member.output === undefined ? {} : { output: member.output }),
          ...(member.error === undefined ? {} : { error: member.error }),
        })),
    })
  }),
)

export const selectProfile = (task: string): Profile => {
  const normalized = task.toLowerCase()
  if (normalized.includes("review")) return "Review"
  if (normalized.includes("research") || normalized.includes("documentation")) return "Librarian"
  if (normalized.includes("architecture") || normalized.includes("investigate")) return "Oracle"
  if (normalized.includes("image") || normalized.includes("visual")) return "Painter"
  if (normalized.includes("thread")) return "ReadThread"
  return "Task"
}
