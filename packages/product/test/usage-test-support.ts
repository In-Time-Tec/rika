import * as ExecutionEvent from "@rika/product/execution-event"
import { Result } from "effect"
import * as StrictUsageCostProjection from "../src/usage/usage-projection"
import * as StrictUsageCostActiveTime from "../src/usage/usage-active-time"
import * as StrictUsageCostCodec from "../src/usage/usage-snapshot-codec"
import * as StrictUsageCostEvent from "../src/usage/usage-event"
import * as StrictUsageCostFold from "../src/usage/usage-fold"
import * as StrictUsageCostSnapshot from "../src/usage/usage-snapshot"
import * as StrictUsageCostTotal from "../src/usage/usage-total"

const StrictUsageCost = {
  ...StrictUsageCostProjection,
  ...StrictUsageCostActiveTime,
  ...StrictUsageCostCodec,
  ...StrictUsageCostEvent,
  ...StrictUsageCostFold,
  ...StrictUsageCostSnapshot,
  ...StrictUsageCostTotal,
}

export const unwrap = <A>(result: Result.Result<A, StrictUsageCost.ProjectionFailure>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

export const UsageCost = {
  ...StrictUsageCost,
  observe: (
    snapshot: StrictUsageCost.Snapshot,
    input: StrictUsageCost.RootExecution & { readonly event: ExecutionEvent.Event },
  ) => unwrap(StrictUsageCost.observe(snapshot, input)),
  deserialize: (json: string) => unwrap(StrictUsageCost.deserialize(json)),
}

const observeCompat = (
  snapshot: StrictUsageCost.Snapshot,
  input: StrictUsageCost.RootExecution & { readonly event: ExecutionEvent.Event },
): StrictUsageCost.Snapshot => {
  const result = StrictUsageCost.observe(snapshot, input)
  return Result.isFailure(result) ? snapshot : result.success
}

const usage = (cursor: string, costUsd: number): ExecutionEvent.Event => ({
  executionId: "execution",
  cursor,
  sequence: 0,
  type: "model.attempt.completed",
  createdAt: 1,
  data: {
    model_call_id: `call-${cursor}`,
    model_attempt_id: `attempt-${cursor}`,
    attempt: 1,
    cost: { amount: costUsd, currency: "USD" },
  },
})

const attemptCompleted = (cursor: string, attemptId: string, executionId = "execution"): ExecutionEvent.Event => ({
  executionId,
  cursor,
  sequence: 0,
  type: "model.attempt.completed",
  createdAt: 1,
  data: { model_call_id: `call-${cursor}`, model_attempt_id: attemptId, attempt: 1 },
})

const reportedTokens = (
  cursor: string,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
  data: Readonly<Record<string, unknown>> = {},
): ExecutionEvent.Event => ({
  executionId: "execution",
  cursor,
  sequence: 0,
  type: "model.attempt.completed",
  createdAt: 1,
  data: {
    model_call_id: `call-${cursor}`,
    model_attempt_id: `attempt-${cursor}`,
    attempt: 1,
    provider: "openai",
    model,
    input_tokens: inputTokens,
    input_tokens_uncached: inputTokens,
    input_tokens_cache_read: 0,
    input_tokens_cache_write: 0,
    output_tokens: outputTokens,
    ...data,
  },
})

const lifecycle = (
  executionId: string,
  id: string,
  type:
    | "execution.accepted"
    | "execution.started"
    | "wait.created"
    | "wait.woken"
    | "wait.timed_out"
    | "execution.completed"
    | "execution.failed"
    | "execution.cancelled",
  createdAt: number,
  sequence: number,
): ExecutionEvent.Event => ({ executionId, cursor: id, sequence, type, createdAt, timestampSource: "baton" })

const unstampedLifecycle = (
  executionId: string,
  id: string,
  type: "execution.started" | "wait.created" | "wait.woken" | "execution.completed",
  createdAt: number,
  sequence: number,
): ExecutionEvent.Event => ({ executionId, cursor: id, sequence, type, createdAt })

const work = (executionId: string, cursor: string, type: string, createdAt: number, sequence: number) =>
  ({ executionId, cursor, sequence, type, createdAt }) as ExecutionEvent.Event

const usageIn = (executionId: string, cursor: string, costUsd: number): ExecutionEvent.Event => ({
  ...usage(cursor, costUsd),
  executionId,
})

const fold = (
  events: ReadonlyArray<ExecutionEvent.Event>,
  input: { readonly threadId: string; readonly turnId: string } = { threadId: "thread", turnId: "turn" },
  snapshot: StrictUsageCost.Snapshot = UsageCost.empty,
): StrictUsageCost.Snapshot => events.reduce((current, event) => observeCompat(current, { ...input, event }), snapshot)

export const RawUsageCost = StrictUsageCost

export const Fixtures = {
  usage,
  attemptCompleted,
  reportedTokens,
  lifecycle,
  unstampedLifecycle,
  work,
  usageIn,
  fold,
}
