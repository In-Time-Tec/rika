import { Context, Effect, Layer, Schedule } from "effect"
import { Client as RivetClient, RivetError } from "@rivetkit/effect"
import {
  AcceptTurnPayload,
  EnsureThreadPayload,
  ThreadActor,
  ThreadActorError,
  ThreadActorSnapshot,
  ThreadIdPayload,
} from "./thread-actor"

export type RunError = ThreadActorError | RivetError.RivetError

export interface Interface {
  readonly ensureThread: (input: EnsureThreadPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly acceptTurn: (input: AcceptTurnPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly replayThread: (input: ThreadIdPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly getSnapshot: (input: ThreadIdPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/rivet-host/ThreadClient") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const accessor = yield* ThreadActor.client
    return Service.of({
      ensureThread: Effect.fn("ThreadClient.ensureThread")(function* (input: EnsureThreadPayload) {
        return yield* accessor.getOrCreate(input.thread_id).EnsureThread(input).pipe(retryTransientRivetErrors)
      }),
      acceptTurn: Effect.fn("ThreadClient.acceptTurn")(function* (input: AcceptTurnPayload) {
        return yield* accessor.getOrCreate(input.thread_id).AcceptTurn(input).pipe(retryTransientRivetErrors)
      }),
      replayThread: Effect.fn("ThreadClient.replayThread")(function* (input: ThreadIdPayload) {
        return yield* accessor.getOrCreate(input.thread_id).ReplayThread(input).pipe(retryTransientRivetErrors)
      }),
      getSnapshot: Effect.fn("ThreadClient.getSnapshot")(function* (input: ThreadIdPayload) {
        return yield* accessor.getOrCreate(input.thread_id).GetSnapshot(input).pipe(retryTransientRivetErrors)
      }),
    })
  }),
)

export const ensureThread = Effect.fn("ThreadClient.ensureThread.call")(function* (input: EnsureThreadPayload) {
  const service = yield* Service
  return yield* service.ensureThread(input)
})

export const acceptTurn = Effect.fn("ThreadClient.acceptTurn.call")(function* (input: AcceptTurnPayload) {
  const service = yield* Service
  return yield* service.acceptTurn(input)
})

export const replayThread = Effect.fn("ThreadClient.replayThread.call")(function* (input: ThreadIdPayload) {
  const service = yield* Service
  return yield* service.replayThread(input)
})

export const getSnapshot = Effect.fn("ThreadClient.getSnapshot.call")(function* (input: ThreadIdPayload) {
  const service = yield* Service
  return yield* service.getSnapshot(input)
})

const isRetryableRivetError = (error: unknown): error is RivetError.RivetError =>
  RivetError.isRivetError(error) && error.isRetryable

const retryAfter = (error: unknown) => (RivetError.isRivetError(error) ? error.retryAfter : undefined)

const transientRivetSchedule = Schedule.exponential("50 millis", 2).pipe(
  Schedule.both(Schedule.recurs(3)),
  Schedule.collectWhile((metadata) => isRetryableRivetError(metadata.input)),
  Schedule.passthrough,
  Schedule.modifyDelay((error, delay) => Effect.succeed(retryAfter(error) ?? delay)),
)

const retryTransientRivetErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.retry(effect, transientRivetSchedule)

export type Requirements = RivetClient.Client
