import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionIdentifier from "@rika/product/execution-identifier"
import * as ExecutionChildRun from "@rika/product/execution-child-run"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { AgentProfile } from "./agent-profile"
import { Context, Effect, Layer, Schema } from "effect"

export const Profile = AgentProfile
type Profile = typeof Profile.Type

interface InvokeInput {
  readonly parentTurnId: string
  readonly childId: string
  readonly profile: Profile
  readonly prompt: string
}

interface ChildEvent {
  readonly parentTurnId: string
  readonly childId: string
  readonly profile: Profile
  readonly type: "accepted"
}

interface TaskInput {
  readonly id: string
  readonly prompt: string
  readonly profile?: Profile
}

interface ParallelInput {
  readonly parentTurnId: string
  readonly fanOutId: string
  readonly workspace?: string
  readonly executionRoute: ExecutionRouteSnapshot.ExecutionRoutePin
  readonly tasks: ReadonlyArray<TaskInput>
  readonly maxConcurrency: number
  readonly join?: ExecutionChildRun.JoinPolicy
  readonly quorum?: number
  readonly createdAt: number
}

export class InvocationError extends Schema.TaggedErrorClass<InvocationError>()("ProductAgentInvocationError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly invoke: (input: InvokeInput) => Effect.Effect<ChildEvent, InvocationError>
  readonly fanOut: (
    input: ExecutionChildRun.FanOutInput,
  ) => Effect.Effect<ExecutionChildRun.FanOutInspection, InvocationError>
  readonly inspectFanOut: (id: string) => Effect.Effect<ExecutionChildRun.FanOutInspection | undefined, InvocationError>
  readonly cancelFanOut: (
    id: string,
    at: number,
    reason?: string,
  ) => Effect.Effect<ExecutionChildRun.FanOutInspection, InvocationError>
  readonly runParallel: (input: ParallelInput) => Effect.Effect<ExecutionChildRun.FanOutInspection, InvocationError>
  readonly runReviewLanes: (
    input: Omit<ParallelInput, "tasks"> & { readonly checks: ReadonlyArray<TaskInput> },
  ) => Effect.Effect<ExecutionChildRun.FanOutInspection, InvocationError>
  readonly projectChildren: (
    inspection: ExecutionChildRun.FanOutInspection,
  ) => ReadonlyArray<ExecutionChildRun.ChildProjection>
  readonly cancelChild: (id: string, at: number) => Effect.Effect<ExecutionEvent.Result, InvocationError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/product/product-agent/Service") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const backend = yield* ExecutionBackend.Service
    return Service.of({
      invoke: Effect.fn("ProductAgent.invoke")((input) =>
        backend.invokeChild(input).pipe(
          Effect.map((event) => ({ ...event, profile: input.profile })),
          Effect.mapError((cause) => InvocationError.make({ message: cause.message })),
        ),
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
      cancelChild: Effect.fn("ProductAgent.cancelChild")((id, _at) =>
        backend
          .cancel(id, ExecutionIdentifier.executionReference)
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
              profile: task.profile ?? "Task",
              prompt: task.prompt,
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

export const ProductAgent = { Profile, Service, layer }
