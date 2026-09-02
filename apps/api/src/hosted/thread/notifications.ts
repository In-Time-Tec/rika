import { Context, Data, Effect, Layer, Redacted } from "effect"
import { Client, type Notification } from "pg"

const channel = "rika_thread_protocol"
class ThreadProtocolListenerError extends Data.TaggedError("ThreadProtocolListenerError")<{
  readonly message: string
  readonly cause: unknown
}> {}
const listenerFailure = (cause: unknown) =>
  new ThreadProtocolListenerError({
    message: cause instanceof Error ? cause.message : "Thread protocol listener failed",
    cause,
  })

export interface ThreadProtocolNotifications {
  readonly publish: (threadId: string) => void
  readonly recover: () => void
  readonly generation: (threadId: string) => ThreadProtocolNotificationGeneration
  readonly wait: (
    threadId: string,
    generation: ThreadProtocolNotificationGeneration,
  ) => Effect.Effect<ThreadProtocolNotificationGeneration>
}

export interface ThreadProtocolNotificationGeneration {
  readonly thread: number
  readonly recovery: number
}

export class ThreadProtocolNotificationService extends Context.Service<
  ThreadProtocolNotificationService,
  ThreadProtocolNotifications
>()("@rika/api/hosted/thread/notifications/ThreadProtocolNotificationService") {
  static readonly layer = Layer.sync(this, makeThreadProtocolNotifications)
}

export function makeThreadProtocolNotifications(): ThreadProtocolNotifications {
  let recoveryGeneration = 0
  const threadGenerations = new Map<string, number>()
  const threadWaiters = new Map<string, Set<(generation: ThreadProtocolNotificationGeneration) => void>>()
  const recoveryWaiters = new Set<(generation: ThreadProtocolNotificationGeneration) => void>()
  const generation = (threadId: string): ThreadProtocolNotificationGeneration => ({
    thread: threadGenerations.get(threadId) ?? 0,
    recovery: recoveryGeneration,
  })
  const publish = (threadId: string) => {
    threadGenerations.set(threadId, (threadGenerations.get(threadId) ?? 0) + 1)
    const current = [...(threadWaiters.get(threadId) ?? [])]
    threadWaiters.delete(threadId)
    const next = generation(threadId)
    for (const resume of current) {
      recoveryWaiters.delete(resume)
      resume(next)
    }
  }
  const recover = () => {
    recoveryGeneration += 1
    threadGenerations.clear()
    const current = [...recoveryWaiters]
    recoveryWaiters.clear()
    threadWaiters.clear()
    for (const resume of current) resume({ thread: 0, recovery: recoveryGeneration })
  }
  return {
    publish,
    recover,
    generation,
    wait: (threadId, observed) =>
      Effect.callback<ThreadProtocolNotificationGeneration>((resume) => {
        const current = generation(threadId)
        if (current.thread > observed.thread || current.recovery > observed.recovery) {
          resume(Effect.succeed(current))
          return Effect.void
        }
        const complete = (next: ThreadProtocolNotificationGeneration) => resume(Effect.succeed(next))
        const waiters = threadWaiters.get(threadId) ?? new Set()
        waiters.add(complete)
        threadWaiters.set(threadId, waiters)
        recoveryWaiters.add(complete)
        return Effect.sync(() => {
          recoveryWaiters.delete(complete)
          waiters.delete(complete)
          if (waiters.size === 0) threadWaiters.delete(threadId)
        })
      }),
  }
}

const listenOnce = (databaseUrl: Redacted.Redacted<string>, changes: ThreadProtocolNotifications) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Client({ connectionString: Redacted.value(databaseUrl) })).pipe(
      Effect.tap((client) => Effect.tryPromise({ try: () => client.connect(), catch: listenerFailure })),
      Effect.tap((client) =>
        Effect.tryPromise({ try: () => client.query(`LISTEN ${channel}`), catch: listenerFailure }),
      ),
      Effect.tap(() => Effect.sync(changes.recover)),
    ),
    (client) =>
      Effect.callback<void, ThreadProtocolListenerError>((resume) => {
        let completed = false
        const notification = (message: Notification) => {
          if (message.channel === channel && message.payload !== undefined) changes.publish(message.payload)
        }
        const error = (cause: Error) => {
          if (completed) return
          completed = true
          resume(Effect.fail(listenerFailure(cause)))
        }
        const end = () => {
          if (completed) return
          completed = true
          resume(Effect.void)
        }
        client.on("notification", notification)
        client.on("error", error)
        client.once("end", end)
        return Effect.sync(() => {
          client.off("notification", notification)
          client.off("error", error)
          client.off("end", end)
        })
      }),
    (client) => Effect.tryPromise(() => client.end()).pipe(Effect.ignore),
  )

export const listenForThreadChanges = (options: {
  readonly databaseUrl: Redacted.Redacted<string>
  readonly changes: ThreadProtocolNotifications
}) =>
  listenOnce(options.databaseUrl, options.changes).pipe(
    Effect.catch((cause) =>
      Effect.logDebug("thread-protocol-listener.disconnected").pipe(
        Effect.annotateLogs("rika.error.message", cause.message),
      ),
    ),
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever,
  )
