import { entityKind } from "./relay-thread-host-constants"
import { Client, Ids, type Resident } from "@relayfx/sdk"
import { Duration, Effect, Schedule } from "effect"

export const makeThreadHostLifecycle = (input: {
  readonly client: Client.Interface
  readonly hostReady: Effect.Effect<void, Client.ClientError>
  readonly hostInstances: Map<string, Resident.Instance>
}) => {
  const { client, hostReady, hostInstances } = input
  const entityFor = Effect.fn("ExecutionBackend.entityFor")(function* (threadId: string, now: number) {
    let recovering = false
    const existing = yield* client.residents.get({
      kind: entityKind,
      key: Ids.ResidentKey.make(threadId),
    })
    if (existing?.status === "active") {
      const inspection = yield* client.executions.inspect(existing.execution_id)
      if (inspection.status === "completed" || inspection.status === "failed" || inspection.status === "cancelled") {
        recovering = true
        yield* Effect.logWarning("thread_host.recovery.started").pipe(
          Effect.annotateLogs({
            "rika.thread.id": threadId,
            "rika.execution.id": existing.execution_id,
            "rika.execution.status": inspection.status,
            "rika.thread_host.generation": existing.generation,
          }),
        )
        yield* client.residents.destroy({
          kind: entityKind,
          key: Ids.ResidentKey.make(threadId),
          reason: "thread host execution ended; recreating a fresh generation",
          destroyed_at: now,
        })
        hostInstances.delete(threadId)
      }
    }
    const instance = yield* client.residents.spawn({
      kind: entityKind,
      key: Ids.ResidentKey.make(threadId),
      metadata: { rika_thread_id: threadId },
      created_at: now,
    })
    if (recovering)
      yield* Effect.logInfo("thread_host.recovery.completed").pipe(
        Effect.annotateLogs({
          "rika.thread.id": threadId,
          "rika.execution.id": instance.execution_id,
          "rika.thread_host.generation": instance.generation,
        }),
      )
    return instance
  })
  const hostInstance = Effect.fn("ExecutionBackend.hostInstance")(function* (threadId: string, now: number) {
    yield* hostReady
    const cached = hostInstances.get(threadId)
    if (cached !== undefined && cached.status === "active") return cached
    const instance = yield* entityFor(threadId, now)
    hostInstances.set(threadId, instance)
    return instance
  })
  const awaitParkedHost = Effect.fn("ExecutionBackend.awaitParkedHost")(function* (
    threadId: string,
    instance: Resident.Instance,
    now: number,
  ) {
    const outcome = yield* Effect.gen(function* () {
      const inspection = yield* client.executions.inspect(instance.execution_id)
      if (inspection.status === "completed" || inspection.status === "failed" || inspection.status === "cancelled")
        return "terminal" as const
      if (inspection.waiting_on.length === 0)
        return yield* Client.ClientError.make({ message: `Thread host for ${threadId} is not parked yet` })
      return "parked" as const
    }).pipe(
      Effect.retry({ schedule: Schedule.spaced(Duration.millis(50)), times: 100 }),
      Effect.orElseSucceed(() => "unknown" as const),
    )
    if (outcome !== "terminal") return instance
    yield* client.residents.destroy({
      kind: entityKind,
      key: Ids.ResidentKey.make(threadId),
      reason: "thread host execution ended; recreating a fresh generation",
      destroyed_at: now,
    })
    hostInstances.delete(threadId)
    const recreated = yield* entityFor(threadId, now)
    hostInstances.set(threadId, recreated)
    return recreated
  })
  return { hostInstance, awaitParkedHost }
}
