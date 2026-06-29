import { Schedule, Stream } from "effect"
import { AiError } from "effect/unstable/ai"
import type { StreamMiddleware } from "./provider"

export const isTransient = (error: unknown): boolean =>
  AiError.isAiError(error) && error.isRetryable && error.reason._tag !== "InvalidOutputError"

const transientSchedule = Schedule.exponential("250 millis", 2).pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(3)),
  Schedule.collectWhile((metadata) => isTransient(metadata.input)),
)

export const middleware: StreamMiddleware = () => (stream) => Stream.retry(stream, transientSchedule)
