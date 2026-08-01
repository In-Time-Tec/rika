import type * as ExecutionBackend from "@rika/product/execution-service"
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
    input: StrictUsageCost.RootExecution & { readonly event: ExecutionBackend.Event },
  ) => unwrap(StrictUsageCost.observe(snapshot, input)),
  deserialize: (json: string) => unwrap(StrictUsageCost.deserialize(json)),
}

const usage = (cursor: string, costUsd: number): ExecutionBackend.Event => ({
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

const attemptCompleted = (cursor: string, attemptId: string, executionId = "execution"): ExecutionBackend.Event => ({
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
): ExecutionBackend.Event => ({
  executionId: "execution",
  cursor,
  sequence: 0,
  type: "model.usage.reported",
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
): ExecutionBackend.Event => ({ executionId, cursor: id, sequence, type, createdAt, timestampSource: "server" })

const unstampedLifecycle = (
  executionId: string,
  id: string,
  type: "execution.started" | "wait.created" | "wait.woken" | "execution.completed",
  createdAt: number,
  sequence: number,
): ExecutionBackend.Event => ({ executionId, cursor: id, sequence, type, createdAt })

const work = (executionId: string, cursor: string, type: string, createdAt: number, sequence: number) =>
  ({ executionId, cursor, sequence, type, createdAt }) as ExecutionBackend.Event

const usageIn = (executionId: string, cursor: string, costUsd: number): ExecutionBackend.Event => ({
  ...usage(cursor, costUsd),
  executionId,
})

const fold = (
  events: ReadonlyArray<ExecutionBackend.Event>,
  input: { readonly threadId: string; readonly turnId: string } = { threadId: "thread", turnId: "turn" },
  snapshot: StrictUsageCost.Snapshot = UsageCost.empty,
): StrictUsageCost.Snapshot =>
  events.reduce((current, event) => UsageCost.observe(current, { ...input, event }), snapshot)

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
