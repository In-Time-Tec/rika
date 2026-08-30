import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as HostedObservability from "@rika/product/hosted-observability"
import { Effect } from "effect"
import type { SemanticTreeEvent } from "../projection/semantic/event"

type ModelTerminalEvent = Extract<
  SemanticTreeEvent["event"],
  { readonly _tag: "ModelAttemptCompleted" | "ModelAttemptFailed" }
>

export interface ModelTerminalObservation {
  readonly modelAttemptId: string
  readonly outcome: "success" | "failure" | "interrupted"
  readonly durationMillis: number
  readonly syntheticStart: boolean
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
}

const tokenTotal = (value: number | undefined) => {
  if (value === undefined) return undefined
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

const retainRecent = <A>(map: Map<string, A>, key: string, value: A, limit: number) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value!)
}

const terminalUsage = (event: ModelTerminalEvent): ModelTerminalObservation["usage"] => {
  const inputTokens = tokenTotal(
    event._tag === "ModelAttemptCompleted" ? event.usage.inputTokens.total : event.providerUsage?.inputTokens,
  )
  const outputTokens = tokenTotal(
    event._tag === "ModelAttemptCompleted" ? event.usage.outputTokens.total : event.providerUsage?.outputTokens,
  )
  if (inputTokens !== undefined && outputTokens !== undefined) return { inputTokens, outputTokens }
  if (inputTokens !== undefined) return { inputTokens }
  if (outputTokens !== undefined) return { outputTokens }
  return undefined
}

export const makeModelTerminalTelemetry = (limit = 256) => {
  const capacity = Math.max(1, Math.floor(limit))
  const started = new Map<string, number>()
  const observed = new Map<string, true>()
  return {
    started(modelAttemptId: string, startedAt: number) {
      if (observed.has(modelAttemptId) || started.has(modelAttemptId)) return false
      retainRecent(started, modelAttemptId, startedAt, capacity)
      return true
    },
    terminal(event: ModelTerminalEvent): ModelTerminalObservation | undefined {
      if (observed.has(event.modelAttemptId)) {
        retainRecent(observed, event.modelAttemptId, true, capacity)
        return undefined
      }
      const terminalAt = event._tag === "ModelAttemptCompleted" ? event.completedAt : event.failedAt
      const recordedStart = started.get(event.modelAttemptId)
      started.delete(event.modelAttemptId)
      retainRecent(observed, event.modelAttemptId, true, capacity)
      let outcome: ModelTerminalObservation["outcome"] = "success"
      if (event._tag === "ModelAttemptFailed") outcome = event.category === "cancellation" ? "interrupted" : "failure"
      const observation = {
        modelAttemptId: event.modelAttemptId,
        outcome,
        durationMillis: Math.max(0, terminalAt - (recordedStart ?? terminalAt)),
        syntheticStart: recordedStart === undefined,
      } satisfies ModelTerminalObservation
      const usage = terminalUsage(event)
      return usage === undefined ? observation : { ...observation, usage }
    },
  }
}

const modelStart = (link: ExecutionGateway.ExecutionLink, treeEvent: SemanticTreeEvent, modelAttemptId: string) =>
  HostedObservability.event("model_start", "success", {
    threadId: link.threadId,
    turnId: link.turnId,
    runId: treeEvent.runId,
    modelAttemptId,
  })

export const makeHostedModelObserver = (link: ExecutionGateway.ExecutionLink) => {
  const telemetry = makeModelTerminalTelemetry()
  return (treeEvent: SemanticTreeEvent) => {
    const event = treeEvent.event
    if (event._tag === "ModelAttemptStarted") {
      if (!telemetry.started(event.modelAttemptId, event.startedAt)) return Effect.void
      return modelStart(link, treeEvent, event.modelAttemptId)
    }
    if (event._tag !== "ModelAttemptCompleted" && event._tag !== "ModelAttemptFailed") return Effect.void
    const observation = telemetry.terminal(event)
    if (observation === undefined) return Effect.void
    const terminal = HostedObservability.modelObserved(
      {
        threadId: link.threadId,
        turnId: link.turnId,
        runId: treeEvent.runId,
        modelAttemptId: observation.modelAttemptId,
      },
      observation.outcome,
      observation.durationMillis,
      observation.usage,
    )
    return observation.syntheticStart
      ? modelStart(link, treeEvent, event.modelAttemptId).pipe(Effect.andThen(terminal))
      : terminal
  }
}
