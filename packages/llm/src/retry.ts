import { Effect, Schedule, Stream } from "effect"
import { AiError } from "effect/unstable/ai"
import type { CompleteMiddleware, CompleteStructuredMiddleware, StreamMiddleware } from "./provider"

export const isTransient = (error: unknown): boolean =>
  AiError.isAiError(error) && error.isRetryable && error.reason._tag !== "InvalidOutputError"

const retryAfter = (error: unknown) => (AiError.isAiError(error) ? error.retryAfter : undefined)

const transientSchedule = Schedule.exponential("250 millis", 2).pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(3)),
  Schedule.collectWhile((metadata) => isTransient(metadata.input)),
  Schedule.passthrough,
  Schedule.modifyDelay((error, delay) => Effect.succeed(retryAfter(error) ?? delay)),
)

export const completeMiddleware: CompleteMiddleware = () => (effect) => Effect.retry(effect, transientSchedule)

export const completeStructuredMiddleware: CompleteStructuredMiddleware = () => (effect) =>
  Effect.retry(effect, transientSchedule)

export const middleware: StreamMiddleware = () => (stream) => Stream.retry(stream, transientSchedule)
