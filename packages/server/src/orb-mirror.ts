import { Database, OrbStore, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { SandboxClient } from "@rika/orb"
import { Client } from "@rika/sdk"
import { Ids, Orb } from "@rika/schema"
import { Context, Duration, Effect, FiberMap, Layer, Schedule, Schema, Stream } from "effect"
import * as ThreadLive from "./thread-live"

export class OrbMirrorError extends Schema.TaggedErrorClass<OrbMirrorError>()("OrbMirrorError", {
  message: Schema.String,
  operation: Schema.String,
  orb_id: Schema.optional(Ids.OrbId),
  thread_id: Schema.optional(Ids.ThreadId),
}) {}

export type RunError =
  | Client.SdkError
  | Database.DatabaseError
  | OrbMirrorError
  | OrbStore.OrbStoreError
  | SandboxClient.RunError
  | ThreadEventLog.ThreadEventLogError
  | ThreadProjection.ThreadProjectionError

export type ClientFactory = (endpointUrl: string, token: string) => Client.Interface

export interface Interface {
  readonly mirror: (orbId: Ids.OrbId) => Effect.Effect<void, RunError>
  readonly mirrorRunningOrbsOnce: () => Effect.Effect<void, RunError>
  readonly syncRunning: () => Effect.Effect<void, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/server/OrbMirror") {}

const reconnectSchedule = Schedule.exponential("1 second", 2).pipe(
  Schedule.modifyDelay((_output, delay) => Effect.succeed(Duration.min(delay, Duration.seconds(30)))),
  Schedule.collectWhile((metadata) => metadata.input instanceof Client.SdkError),
)

export const layerWithClientFactory = (clientFactory: ClientFactory) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const eventLog = yield* ThreadEventLog.Service
      const projection = yield* ThreadProjection.Service
      const orbs = yield* OrbStore.Service
      const sandbox = yield* SandboxClient.Service
      const live = yield* ThreadLive.Service
      const fibers = yield* FiberMap.make<Ids.OrbId, void, RunError>()
      const withDatabase = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
        effect.pipe(Effect.provideService(Database.Service, database))
      const latestSequence = (threadId: Ids.ThreadId) =>
        withDatabase(eventLog.readThread({ thread_id: threadId, after_sequence: 0 })).pipe(
          Effect.map((events) => events.at(-1)?.sequence ?? 0),
        )
      const appendLocal = Effect.fn("OrbMirror.appendLocal")(function* (event: OrbMirroredEvent) {
        const result = yield* withDatabase(eventLog.appendIfAbsent(event))
        if (result.status === "skipped") return
        yield* withDatabase(projection.apply(event))
        yield* live.publish(event)
      })
      const appendOrbEvent = Effect.fn("OrbMirror.appendOrbEvent")(function* (
        orb: Orb.OrbRecord,
        event: OrbMirroredEvent,
      ) {
        if (event.thread_id !== orb.thread_id) {
          return yield* new OrbMirrorError({
            message: `Orb ${orb.orb_id} emitted event ${event.id} for thread ${event.thread_id}`,
            operation: "append",
            orb_id: orb.orb_id,
            thread_id: orb.thread_id,
          })
        }
        return yield* appendLocal(event)
      })
      const mirrorOrbOnce = Effect.fn("OrbMirror.mirrorOrbOnce")(function* (orb: Orb.OrbRecord) {
        const endpoint = yield* orbs.endpointCredentials(orb.orb_id)
        if (endpoint === undefined) {
          return yield* new OrbMirrorError({
            message: `Orb ${orb.orb_id} has no endpoint`,
            operation: "endpoint",
            orb_id: orb.orb_id,
            thread_id: orb.thread_id,
          })
        }
        const client = clientFactory(endpoint.endpoint_url, endpoint.token)
        const runAttempt = latestSequence(orb.thread_id).pipe(
          Effect.flatMap((afterSequence) =>
            client
              .subscribeThreadEvents({ thread_id: orb.thread_id, after_sequence: afterSequence })
              .pipe(Stream.runForEach((event) => appendOrbEvent(orb, event))),
          ),
        )
        return yield* runAttempt.pipe(
          Effect.catchTag("SdkError", (error) => handleStreamFailure(orbs, sandbox, orb, error)),
          Effect.retry(reconnectSchedule),
        )
      })
      const mirror = Effect.fn("OrbMirror.mirror")(function* (orbId: Ids.OrbId) {
        const orb = yield* orbs.get(orbId)
        if (orb === undefined || orb.status !== "running") return
        yield* FiberMap.run(fibers, orbId, { onlyIfMissing: true })(mirrorOrbOnce(orb))
      })
      const syncRunning = Effect.fn("OrbMirror.syncRunning")(function* () {
        const running = yield* orbs.list({ status: "running" })
        yield* Effect.forEach(running, (orb) => mirror(orb.orb_id), { concurrency: "unbounded", discard: true })
      })

      return Service.of({
        mirror,
        mirrorRunningOrbsOnce: Effect.fn("OrbMirror.mirrorRunningOrbsOnce")(function* () {
          const running = yield* orbs.list({ status: "running" })
          yield* Effect.forEach(running, mirrorOrbOnce, { concurrency: "unbounded", discard: true })
        }),
        syncRunning,
      })
    }),
  )

const handleStreamFailure = Effect.fn("OrbMirror.handleStreamFailure")(function* (
  orbs: OrbStore.Interface,
  sandbox: SandboxClient.Interface,
  orb: Orb.OrbRecord,
  error: Client.SdkError,
) {
  const lifecycle = yield* inspectSandbox(sandbox, orb)
  if (lifecycle === "running") return yield* Effect.fail(error)
  return yield* setLifecycleStatus(orbs, orb, lifecycle)
})

const inspectSandbox = Effect.fn("OrbMirror.inspectSandbox")(function* (
  sandbox: SandboxClient.Interface,
  orb: Orb.OrbRecord,
) {
  if (orb.sandbox_id === null) return "running" as const
  const sandboxes = yield* sandbox.list({
    metadata: {
      thread_id: orb.thread_id,
      project_id: orb.project_id,
    },
  })
  const current = sandboxes.find((summary) => summary.sandboxId === orb.sandbox_id)
  if (current === undefined) return "killed" as const
  return current.state
})

const setLifecycleStatus = Effect.fn("OrbMirror.setLifecycleStatus")(function* (
  orbs: OrbStore.Interface,
  orb: Orb.OrbRecord,
  status: "paused" | "killed",
) {
  yield* orbs
    .setStatus(orb.orb_id, status)
    .pipe(
      Effect.catch((error) =>
        error instanceof OrbStore.OrbStoreError && error.reason === "invalid_transition"
          ? Effect.void
          : Effect.fail(error),
      ),
    )
})

export const layer = layerWithClientFactory((endpointUrl, token) =>
  Client.make(Client.fetchTransport({ base_url: endpointUrl, token })),
)

export const mirrorRunningOrbsOnce = Effect.fn("OrbMirror.mirrorRunningOrbsOnce.call")(function* () {
  const service = yield* Service
  return yield* service.mirrorRunningOrbsOnce()
})

export const mirror = Effect.fn("OrbMirror.mirror.call")(function* (orbId: Ids.OrbId) {
  const service = yield* Service
  return yield* service.mirror(orbId)
})

export const syncRunning = Effect.fn("OrbMirror.syncRunning.call")(function* () {
  const service = yield* Service
  return yield* service.syncRunning()
})

type OrbMirroredEvent = Parameters<ThreadEventLog.Interface["appendIfAbsent"]>[0]
