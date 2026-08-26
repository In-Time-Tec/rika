import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Goal } from "@rika/product/goal-record"

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("GoalRepositoryError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly get: (threadId: string) => Effect.Effect<Goal | undefined, RepositoryError>
  /** Takes the Thread's single goal row, or reports undefined when an active goal already holds it. */
  readonly claim: (goal: Goal) => Effect.Effect<Goal | undefined, RepositoryError>
  readonly replace: (goal: Goal) => Effect.Effect<void, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/product/thread/repository/goal/Service") {}

const clone = (goal: Goal): Goal => structuredClone(goal)

export const makeMemory: Effect.Effect<Interface> = Effect.map(Ref.make(new Map<string, Goal>()), (goals) =>
  Service.of({
    get: (threadId) => Effect.map(Ref.get(goals), (current) => current.get(threadId)),
    claim: (goal) =>
      Ref.modify(goals, (current) => {
        const existing = current.get(goal.threadId)
        return existing !== undefined && existing.status === "active"
          ? ([undefined, current] as const)
          : ([clone(goal), new Map(current).set(goal.threadId, clone(goal))] as const)
      }),
    replace: (goal) => Ref.update(goals, (current) => new Map(current).set(goal.threadId, clone(goal))),
  }),
)

export const memoryLayer: Layer.Layer<Service> = Layer.effect(Service, makeMemory)
