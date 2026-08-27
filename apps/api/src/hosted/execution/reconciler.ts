import * as ExecutionAuthorityReconciliation from "@rika/product/execution-authority-reconciliation"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TurnRepository from "@rika/product/turn-repository"
import { Cause, Clock, Context, Effect, Layer, Schema, SubscriptionRef } from "effect"

export class HostedExecutionReconcilerError extends Schema.TaggedError<HostedExecutionReconcilerError>()(
  "HostedExecutionReconcilerError",
  { message: Schema.String },
) {}

type PollStatus =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Succeeded"; readonly at: number }
  | { readonly _tag: "Failed"; readonly at: number; readonly message: string }

export interface HostedExecutionReconcilerStatus {
  readonly poll: PollStatus
  readonly pollAgeMillis: number | undefined
  readonly lastSuccessfulPollAt: number | undefined
  readonly lastFailure: { readonly at: number; readonly message: string } | undefined
}

export interface HostedExecutionReconcilerService {
  readonly ready: Effect.Effect<void, HostedExecutionReconcilerError>
  readonly status: Effect.Effect<HostedExecutionReconcilerStatus>
}

export class HostedExecutionReconciler extends Context.Service<
  HostedExecutionReconciler,
  HostedExecutionReconcilerService
>()("@rika/api/hosted/execution/reconciler/HostedExecutionReconciler") {}

interface WorkerState {
  readonly poll: PollStatus
  readonly lastSuccessfulPollAt: number | undefined
  readonly lastFailure: { readonly at: number; readonly message: string } | undefined
}

export const layer = (options: { readonly pollIntervalMillis: number }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const turns = yield* TurnRepository.Service
      const backend = yield* ExecutionGateway.Service
      const health = yield* SubscriptionRef.make<WorkerState>({
        poll: { _tag: "Starting" },
        lastSuccessfulPollAt: undefined,
        lastFailure: undefined,
      })
      const poll = ExecutionAuthorityReconciliation.make({
        turns,
        backend,
        setTurnStatus: (id, status, now) => turns.setStatus(id, status, now),
      }).pipe(
        Effect.flatMap(() => Clock.currentTimeMillis),
        Effect.tap((at) =>
          SubscriptionRef.update(health, (state) => ({
            ...state,
            poll: { _tag: "Succeeded" as const, at },
            lastSuccessfulPollAt: at,
          })),
        ),
        Effect.andThen(Effect.sleep(options.pollIntervalMillis)),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          const message = "Execution reconciliation failed"
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((at) =>
              SubscriptionRef.update(health, (state) => ({
                ...state,
                poll: { _tag: "Failed" as const, at, message },
                lastFailure: { at, message },
              })),
            ),
            Effect.andThen(Effect.logError("hosted-execution-reconciler.failed")),
            Effect.andThen(Effect.sleep(options.pollIntervalMillis)),
          )
        }),
      )
      const status = Effect.gen(function* () {
        const state = yield* SubscriptionRef.get(health)
        const now = yield* Clock.currentTimeMillis
        return {
          ...state,
          pollAgeMillis: state.poll._tag === "Starting" ? undefined : now - state.poll.at,
        }
      })
      const service = HostedExecutionReconciler.of({
        status,
        ready: status.pipe(
          Effect.flatMap((state) => {
            if (state.poll._tag === "Starting")
              return Effect.fail(
                HostedExecutionReconcilerError.make({
                  message: "Execution reconciler has not completed its first poll",
                }),
              )
            if (state.poll._tag === "Failed")
              return Effect.fail(HostedExecutionReconcilerError.make({ message: state.poll.message }))
            if (state.pollAgeMillis !== undefined && state.pollAgeMillis > options.pollIntervalMillis * 4)
              return Effect.fail(HostedExecutionReconcilerError.make({ message: "Execution reconciliation is stale" }))
            return Effect.void
          }),
        ),
      })
      return Layer.merge(
        Layer.succeed(HostedExecutionReconciler, service),
        Layer.effectDiscard(Effect.forkScoped(Effect.forever(poll))),
      )
    }),
  )
