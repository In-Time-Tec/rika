import {
  Cause,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  FiberMap,
  FiberSet,
  Layer,
  Queue,
  Ref,
  Schedule,
  Schema,
  Scope,
  SubscriptionRef,
} from "effect"
import { HostedWorkerListener } from "./worker-listener"

export const workerNotificationChannel = "rika_worker"
export const WorkerDomain = Schema.Literals(["command", "turn", "projection", "reconciliation"])
export type WorkerDomain = typeof WorkerDomain.Type

export type WorkerScan =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Succeeded"; readonly at: number }
  | { readonly _tag: "Failed"; readonly at: number; readonly message: string }

export type WorkerWakeup =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Ready"; readonly at: number; readonly connections: number }

export interface HostedWorkerStatus {
  readonly scan: WorkerScan
  readonly wakeup: WorkerWakeup
  readonly lastFallbackAt: number | undefined
  readonly lastFailure: { readonly at: number; readonly message: string } | undefined
  readonly active: number
  readonly capacity: number
  readonly availableCapacity: number
  readonly oldestActiveAt: number | undefined
  readonly oldestRunnableAt: number | undefined
  readonly scanAgeMillis: number | undefined
  readonly wakeupAgeMillis: number | undefined
  readonly lastFallbackAgeMillis: number | undefined
  readonly lastFailureAgeMillis: number | undefined
  readonly oldestActiveAgeMillis: number | undefined
  readonly oldestRunnableAgeMillis: number | undefined
}

export class HostedWorkerUnavailable extends Schema.TaggedError<HostedWorkerUnavailable>()("HostedWorkerUnavailable", {
  message: Schema.String,
}) {}

export interface HostedWorkerHandle {
  readonly ready: Effect.Effect<void, HostedWorkerUnavailable>
  readonly status: Effect.Effect<HostedWorkerStatus>
  readonly wake: Effect.Effect<void>
}

export interface HostedWorkerControl {
  readonly availableCapacity: number
  readonly isActive: (key: string) => Effect.Effect<boolean>
  readonly start: <E>(input: HostedWorkerStartInput<E>) => Effect.Effect<boolean>
}

export interface HostedWorkerStartInput<E> {
  readonly key: string
  readonly runnableAt?: number
  readonly effect: Effect.Effect<void, E>
}

export interface HostedWorkerScanResult {
  readonly oldestRunnableAt: number | undefined
}

export interface HostedWorkerRegistration<E> {
  readonly domain: WorkerDomain
  readonly concurrency: number
  readonly fallbackIntervalMillis: number
  readonly scanFailureMessage: string
  readonly executionFailureMessage: string
  readonly scan: (control: HostedWorkerControl) => Effect.Effect<HostedWorkerScanResult, E>
}

export interface HostedWorkerRuntimeService {
  readonly register: <E>(registration: HostedWorkerRegistration<E>) => Effect.Effect<HostedWorkerHandle>
}

export class HostedWorkerRuntime extends Context.Service<HostedWorkerRuntime, HostedWorkerRuntimeService>()(
  "@rika/api/hosted/worker-runtime/HostedWorkerRuntime",
) {}

interface ActiveWork {
  readonly token: symbol
  readonly startedAt: number
  readonly runnableAt: number | undefined
}

interface WorkerState {
  readonly scan: WorkerScan
  readonly lastFallbackAt: number | undefined
  readonly lastFailure: { readonly at: number; readonly message: string } | undefined
  readonly oldestRunnableAt: number | undefined
}

class HostedWorkerScanFailure extends Data.TaggedError("HostedWorkerScanFailure")<{
  readonly message: string
}> {}

const age = (now: number, at: number | undefined) => (at === undefined ? undefined : Math.max(0, now - at))

export const layer = Layer.effect(
  HostedWorkerRuntime,
  Effect.gen(function* () {
    const listener = yield* HostedWorkerListener
    const ownerScope = yield* Effect.scope
    const runFork = yield* FiberSet.makeRuntime<never>().pipe(Effect.provideService(Scope.Scope, ownerScope))
    const wakeups = new Map<WorkerDomain, Queue.Queue<void>>()
    const wakeup = yield* SubscriptionRef.make<WorkerWakeup>({ _tag: "Starting" })
    const wake = (domain: WorkerDomain) => {
      const queue = wakeups.get(domain)
      if (queue !== undefined) void Queue.offerUnsafe(queue, undefined)
    }
    const wakeAll = () => {
      for (const queue of wakeups.values()) void Queue.offerUnsafe(queue, undefined)
    }
    const onListen = () => {
      runFork(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          yield* SubscriptionRef.update(wakeup, (current) => ({
            _tag: "Ready" as const,
            at,
            connections: current._tag === "Ready" ? current.connections + 1 : 1,
          }))
          wakeAll()
        }),
      )
    }
    yield* listener.listen(
      workerNotificationChannel,
      (payload) => {
        if (Schema.is(WorkerDomain)(payload)) wake(payload)
      },
      onListen,
    )

    const register = <E>(registration: HostedWorkerRegistration<E>): Effect.Effect<HostedWorkerHandle> =>
      Effect.gen(function* () {
        if (wakeups.has(registration.domain))
          return yield* Effect.die(`Hosted worker ${registration.domain} was registered twice`)
        const domainWakeups = yield* Queue.sliding<void>(1)
        yield* Scope.addFinalizer(ownerScope, Queue.shutdown(domainWakeups))
        const active = yield* FiberMap.make<string>().pipe(Effect.provideService(Scope.Scope, ownerScope))
        const activeWork = yield* Ref.make<ReadonlyMap<string, ActiveWork>>(new Map())
        const state = yield* SubscriptionRef.make<WorkerState>({
          scan: { _tag: "Starting" },
          lastFallbackAt: undefined,
          lastFailure: undefined,
          oldestRunnableAt: undefined,
        })
        wakeups.set(registration.domain, domainWakeups)
        yield* Scope.addFinalizer(
          ownerScope,
          Effect.sync(() => {
            wakeups.delete(registration.domain)
          }),
        )

        const recordFailure = (message: string) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((at) =>
              SubscriptionRef.update(state, (current) => ({ ...current, lastFailure: { at, message } })),
            ),
          )
        const start = <ExecutionError>(input: HostedWorkerStartInput<ExecutionError>): Effect.Effect<boolean> =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis
              const token = Symbol("hosted-worker-execution")
              const admitted = yield* Ref.modify(activeWork, (current) => {
                if (current.has(input.key) || current.size >= registration.concurrency) return [false, current]
                return [true, new Map(current).set(input.key, { token, startedAt, runnableAt: input.runnableAt })]
              })
              if (!admitted) return false
              const remove = Ref.update(activeWork, (current) => {
                if (current.get(input.key)?.token !== token) return current
                const updated = new Map(current)
                updated.delete(input.key)
                return updated
              })
              const completed = remove.pipe(
                Effect.andThen(Effect.sync(() => void Queue.offerUnsafe(domainWakeups, undefined))),
              )
              yield* FiberMap.run(
                active,
                input.key,
                input.effect.pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.interrupt
                      : recordFailure(registration.executionFailureMessage).pipe(
                          Effect.andThen(
                            Effect.logError("hosted-worker.execution-failed").pipe(
                              Effect.annotateLogs({
                                "rika.worker.domain": registration.domain,
                                "rika.failure.message": Cause.pretty(cause),
                              }),
                            ),
                          ),
                        ),
                  ),
                  Effect.ensuring(completed),
                ),
                { startImmediately: true },
              )
              return true
            }),
          )

        const scanAttempt = Effect.gen(function* () {
          const activeCount = (yield* Ref.get(activeWork)).size
          const result = yield* registration.scan({
            availableCapacity: Math.max(0, registration.concurrency - activeCount),
            isActive: (key) => Ref.get(activeWork).pipe(Effect.map((current) => current.has(key))),
            start,
          })
          const at = yield* Clock.currentTimeMillis
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            scan: { _tag: "Succeeded", at } as const,
            oldestRunnableAt: result.oldestRunnableAt,
          }))
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.interrupt
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((at) =>
                SubscriptionRef.update(state, (current) => ({
                  ...current,
                  scan: { _tag: "Failed", at, message: registration.scanFailureMessage } as const,
                  lastFailure: { at, message: registration.scanFailureMessage },
                })),
              ),
              Effect.andThen(
                Effect.logError("hosted-worker.scan-failed").pipe(
                  Effect.annotateLogs({
                    "rika.worker.domain": registration.domain,
                    "rika.failure.message": Cause.pretty(cause),
                  }),
                ),
              ),
              Effect.andThen(Effect.fail(new HostedWorkerScanFailure({ message: registration.scanFailureMessage }))),
            )
          }),
        )
        const maximumRetryDelay = Duration.millis(registration.fallbackIntervalMillis)
        const retrySchedule = Schedule.exponential("250 millis").pipe(
          Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, maximumRetryDelay))),
        )
        const scan = scanAttempt.pipe(Effect.retry(retrySchedule))
        const awaitWakeup = Effect.raceFirst(
          Queue.take(domainWakeups).pipe(Effect.as("wakeup" as const)),
          Effect.sleep(registration.fallbackIntervalMillis).pipe(Effect.as("fallback" as const)),
        ).pipe(
          Effect.tap((reason) =>
            reason === "wakeup"
              ? Effect.void
              : Clock.currentTimeMillis.pipe(
                  Effect.flatMap((at) =>
                    SubscriptionRef.update(state, (current) => ({ ...current, lastFallbackAt: at })),
                  ),
                ),
          ),
        )
        yield* Effect.forever(awaitWakeup.pipe(Effect.andThen(scan))).pipe(Effect.forkIn(ownerScope))
        void Queue.offerUnsafe(domainWakeups, undefined)

        const status: Effect.Effect<HostedWorkerStatus> = Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state)
          const listenerStatus = yield* SubscriptionRef.get(wakeup)
          const now = yield* Clock.currentTimeMillis
          const activeEntries = yield* Ref.get(activeWork)
          let oldestActiveAt: number | undefined
          for (const entry of activeEntries.values()) {
            const at = entry.runnableAt ?? entry.startedAt
            if (oldestActiveAt === undefined || at < oldestActiveAt) oldestActiveAt = at
          }
          return {
            scan: current.scan,
            wakeup: listenerStatus,
            lastFallbackAt: current.lastFallbackAt,
            lastFailure: current.lastFailure,
            active: activeEntries.size,
            capacity: registration.concurrency,
            availableCapacity: Math.max(0, registration.concurrency - activeEntries.size),
            oldestActiveAt,
            oldestRunnableAt: current.oldestRunnableAt,
            scanAgeMillis: age(now, current.scan._tag === "Starting" ? undefined : current.scan.at),
            wakeupAgeMillis: age(now, listenerStatus._tag === "Starting" ? undefined : listenerStatus.at),
            lastFallbackAgeMillis: age(now, current.lastFallbackAt),
            lastFailureAgeMillis: age(now, current.lastFailure?.at),
            oldestActiveAgeMillis: age(now, oldestActiveAt),
            oldestRunnableAgeMillis: age(now, current.oldestRunnableAt),
          }
        })
        return {
          status,
          wake: Effect.sync(() => void Queue.offerUnsafe(domainWakeups, undefined)),
          ready: status.pipe(
            Effect.flatMap((current) => {
              if (current.wakeup._tag === "Starting")
                return Effect.fail(HostedWorkerUnavailable.make({ message: "Worker listener is not ready" }))
              if (current.scan._tag === "Starting")
                return Effect.fail(HostedWorkerUnavailable.make({ message: "Worker has not completed its first scan" }))
              if (current.scan._tag === "Failed")
                return Effect.fail(HostedWorkerUnavailable.make({ message: current.scan.message }))
              if (
                current.scanAgeMillis !== undefined &&
                current.scanAgeMillis > registration.fallbackIntervalMillis * 4
              )
                return Effect.fail(HostedWorkerUnavailable.make({ message: "Worker durable scan is stale" }))
              return Effect.void
            }),
          ),
        } satisfies HostedWorkerHandle
      })
    return HostedWorkerRuntime.of({ register })
  }),
)

export const layerTest = layer.pipe(Layer.provide(HostedWorkerListener.layerTest))
