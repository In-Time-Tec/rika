import * as ResidentHandshake from "@rika/product/resident-service-handshake"
import * as ResidentService from "@rika/product/resident-service"
import { Clock, Crypto, Deferred, Effect, Exit, FileSystem, Function, Path, Schema, Scope } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Socket from "effect/unstable/socket/Socket"
import { readOrCreateToken, resolve } from "../../resident/process/resident-endpoint"
import * as ResidentProcessStartup from "../../resident/process/resident-process"
import { claimStartup } from "../../resident/process/resident-startup"
import { transportError } from "../protocol/resident-message-codec"

const mapResidentSocketFailure = (cause: unknown, accepted: boolean): ResidentService.ResidentServiceError => {
  if (Socket.SocketError.is(cause) && cause.reason._tag === "SocketCloseError") {
    if (cause.reason.code === 4409 || cause.reason.code === 1001)
      return transportError("Resident service is draining", "resident-draining")
    if (cause.reason.code === 4406)
      return transportError(
        cause.reason.closeReason ||
          "A listener reported an unsigned resident incompatibility; stop it, then run rika again",
        "foreign-listener",
      )
    if (cause.reason.code === 4401)
      return transportError(
        cause.reason.closeReason ??
          "A Rika resident with different credentials is still running; close other Rika clients, then run rika again",
        "foreign-listener",
      )
  }
  return transportError(String(cause), accepted ? "transport-failed" : "resident-absent")
}
export const residentSocketFailure: {
  (accepted: boolean): (cause: unknown) => ResidentService.ResidentServiceError
  (cause: unknown, accepted: boolean): ResidentService.ResidentServiceError
} = Function.dual(2, mapResidentSocketFailure)
import { connect } from "./resident-client-connection"
import { makeInteractiveSupervisor } from "./resident-client-reconnect"
export const make = Effect.fn("ResidentTransport.make")(() =>
  Effect.succeed(
    ResidentService.Service.of({
      getOrCreate: (input) =>
        Effect.gen(function* () {
          const endpoint = yield* resolve(input.profile, input.dataRoot)
          const token = yield* readOrCreateToken(endpoint.tokenPath)
          const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const crypto = yield* Crypto.Crypto
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const connectionScope = yield* Scope.make()
          yield* Effect.addFinalizer((exit) => Scope.close(connectionScope, exit))
          const attach = (connectRole: ResidentHandshake.ConnectRole) =>
            Effect.gen(function* () {
              const attemptScope = yield* Scope.fork(connectionScope)
              const result = yield* Effect.exit(
                connect({ ...endpoint, ...input, token, connectRole, role: "attached" }).pipe(
                  Scope.provide(attemptScope),
                ),
              )
              if (result._tag === "Failure") {
                yield* Scope.close(attemptScope, result)
                return yield* Effect.failCause(result.cause)
              }
              return result.value
            }).pipe(
              Effect.mapError((error) =>
                Schema.is(ResidentService.ResidentServiceError)(error)
                  ? error
                  : transportError(`Resident connection attempt failed: ${String(error)}`),
              ),
            )
          yield* Effect.logInfo("resident.connection.acquiring").pipe(
            Effect.annotateLogs("rika.resident.client.kind", input.clientKind),
          )
          const acquire = Effect.fn("ResidentTransport.acquireConnection")(function* (policy: "launch" | "reattach") {
            const yieldToIncompatible = (failure: ResidentService.ResidentServiceError) =>
              ResidentService.ResidentRestartRequired.make({ message: failure.message })
            const startedAt = yield* Clock.currentTimeMillis
            const deadline = startedAt + 30_000
            const first = yield* Effect.result(attach(policy))
            if (first._tag === "Success") return first.success
            if (policy === "reattach" && first.failure.reason === "incompatible-resident")
              return yield* yieldToIncompatible(first.failure)
            if (
              first.failure.reason !== "resident-absent" &&
              first.failure.reason !== "resident-draining" &&
              first.failure.reason !== "incompatible-resident"
            )
              return yield* first.failure
            if (input.startHost === undefined) return yield* first.failure
            if (input.startHost !== undefined) {
              let attempt = 0
              let lastFailure = first.failure
              while (true) {
                const connected = yield* Effect.result(attach(policy))
                if (connected._tag === "Success") {
                  yield* Effect.logInfo("resident.startup.ready").pipe(
                    Effect.annotateLogs("rika.duration.ms", (yield* Clock.currentTimeMillis) - startedAt),
                  )
                  return connected.success
                }
                lastFailure = connected.failure
                if (policy === "reattach" && lastFailure.reason === "incompatible-resident")
                  return yield* yieldToIncompatible(lastFailure)
                if (
                  lastFailure.reason !== "resident-absent" &&
                  lastFailure.reason !== "resident-draining" &&
                  lastFailure.reason !== "incompatible-resident"
                )
                  return yield* lastFailure
                if (lastFailure.reason === "resident-absent" || lastFailure.reason === "incompatible-resident") {
                  const claim = yield* claimStartup(endpoint.startupPath, endpoint.identity, deadline)
                  if (claim._tag === "Owner") {
                    const existing = yield* Effect.result(attach(policy))
                    if (existing._tag === "Success") {
                      yield* claim.release
                      yield* Effect.logInfo("resident.startup.ready").pipe(
                        Effect.annotateLogs("rika.duration.ms", (yield* Clock.currentTimeMillis) - startedAt),
                      )
                      return existing.success
                    }
                    lastFailure = existing.failure
                    if (policy === "reattach" && lastFailure.reason === "incompatible-resident") {
                      yield* claim.release
                      return yield* yieldToIncompatible(lastFailure)
                    }
                    if (lastFailure.reason === "resident-absent" || lastFailure.reason === "incompatible-resident") {
                      if (yield* ResidentProcessStartup.listenerIsLive(endpoint.port)) {
                        if (lastFailure.reason !== "incompatible-resident" || lastFailure.residentPid === undefined) {
                          yield* claim.release
                          return yield* transportError(
                            `A process is listening on Rika resident port ${endpoint.port}, but it could not be authenticated. Stop that process, then run rika again`,
                            "foreign-listener",
                          )
                        }
                        const listeners = yield* ResidentProcessStartup.listenerProcessIds(endpoint.port, [
                          lastFailure.residentPid,
                        ])
                        if (listeners.length !== 1) {
                          yield* claim.release
                          return yield* transportError(
                            `The stale Rika resident on port ${endpoint.port} was authenticated, but its PID could not be verified. Stop it, then run rika again`,
                            "foreign-listener",
                          )
                        }
                        yield* Effect.logWarning("resident.startup.superseding").pipe(
                          Effect.annotateLogs({
                            "rika.resident.previous.pid": listeners[0]!,
                            "rika.resident.port": endpoint.port,
                          }),
                        )
                        const superseded = yield* Effect.result(
                          ResidentProcessStartup.supersede(listeners[0]!, endpoint.port),
                        )
                        if (superseded._tag === "Failure") {
                          yield* claim.release
                          return yield* superseded.failure
                        }
                      }
                      const spawned = yield* Effect.result(input.startHost())
                      if (spawned._tag === "Failure") {
                        yield* claim.release
                        return yield* spawned.failure
                      }
                      const adopted = yield* Effect.result(claim.adopt(spawned.success.pid))
                      if (adopted._tag === "Failure") {
                        yield* spawned.success.abort
                        yield* claim.release
                        return yield* adopted.failure
                      }
                      const started = yield* Effect.result(spawned.success.startup)
                      if (started._tag === "Failure") {
                        yield* spawned.success.abort
                        yield* claim.release
                        return yield* started.failure
                      }
                      const attached = yield* Effect.result(attach(policy))
                      if (attached._tag === "Failure") {
                        yield* spawned.success.abort
                        yield* claim.release
                        lastFailure = attached.failure
                        yield* Effect.logWarning("resident.startup.attach_retry").pipe(
                          Effect.annotateLogs({
                            "rika.failure.kind": attached.failure._tag,
                            "rika.failure.reason": attached.failure.reason,
                          }),
                        )
                      } else {
                        const detached = yield* Effect.result(spawned.success.detach)
                        if (detached._tag === "Failure") {
                          yield* spawned.success.abort
                          yield* claim.release
                          return yield* detached.failure
                        }
                        yield* claim.release
                        yield* Effect.logInfo("resident.startup.ready").pipe(
                          Effect.annotateLogs("rika.duration.ms", (yield* Clock.currentTimeMillis) - startedAt),
                        )
                        return attached.success
                      }
                    } else {
                      yield* claim.release
                      if (lastFailure.reason !== "resident-draining") return yield* lastFailure
                    }
                  }
                }
                const now = yield* Clock.currentTimeMillis
                if (now >= deadline)
                  return yield* transportError(
                    `Resident did not become ready within 30 seconds: ${lastFailure.message}`,
                    "transport-failed",
                  )
                const ceiling = Math.min(250, 10 * 2 ** Math.min(attempt, 5))
                const jitter = (process.pid * 17 + attempt * 31) % Math.max(1, ceiling)
                attempt += 1
                yield* Effect.sleep(Math.min(deadline - now, ceiling + jitter))
              }
            }
            return yield* first.failure
          })
          const acquireReady = (policy: "launch" | "reattach") =>
            acquire(policy).pipe(
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () =>
                  Effect.fail(
                    transportError("Resident acquisition exceeded its 30-second deadline", "transport-failed"),
                  ),
              }),
              Scope.provide(connectionScope),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.mapError((error) =>
                Schema.is(ResidentService.ResidentServiceError)(error) ||
                Schema.is(ResidentService.ResidentRestartRequired)(error)
                  ? error
                  : transportError(String(error)),
              ),
              Effect.tapError((error) =>
                Effect.logWarning("resident.connection.failed").pipe(
                  Effect.annotateLogs({
                    "rika.failure.kind": error._tag,
                    "rika.failure.reason": Schema.is(ResidentService.ResidentServiceError)(error)
                      ? error.reason
                      : "restart-required",
                    "rika.resident.client.kind": input.clientKind,
                  }),
                ),
              ),
            )
          const initial = yield* acquireReady(input.allowSupersede === false ? "reattach" : "launch")
          const logicalClosed = yield* Deferred.make<void>()
          const supervise = makeInteractiveSupervisor({ initial, acquireReady, logicalClosed })
          return {
            ...initial,
            run: (operationInput, options) =>
              operationInput._tag === "Interactive" && options?.interactive !== undefined
                ? supervise(operationInput, options.interactive)
                : initial.run(operationInput, options),
            closed: Deferred.await(logicalClosed),
            close: Deferred.succeed(logicalClosed, undefined).pipe(
              Effect.andThen(Scope.close(connectionScope, Exit.void)),
            ),
          } satisfies ResidentService.Connection
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(ResidentService.ResidentServiceError)(cause) ||
            Schema.is(ResidentService.ResidentRestartRequired)(cause)
              ? cause
              : transportError(String(cause)),
          ),
        ),
    }),
  ),
)
