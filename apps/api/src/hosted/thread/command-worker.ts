import { Context, Crypto, DateTime, Effect, Layer, Schema } from "effect"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { HostedWorkerRuntime, type HostedWorkerStatus } from "../worker-runtime"
import { commandApplication, commandControlFailure } from "./command-application"

export { commandControlFailure }

export class HostedThreadCommandWorkerError extends Schema.TaggedError<HostedThreadCommandWorkerError>()(
  "HostedThreadCommandWorkerError",
  { message: Schema.String },
) {}

export interface HostedThreadCommandWorkerService {
  readonly ready: Effect.Effect<void, HostedThreadCommandWorkerError>
  readonly status: Effect.Effect<HostedThreadCommandWorkerStatus>
}

export class HostedThreadCommandWorker extends Context.Service<
  HostedThreadCommandWorker,
  HostedThreadCommandWorkerService
>()("@rika/api/hosted/thread/command-worker/HostedThreadCommandWorker") {}

export type HostedThreadCommandWorkerStatus = HostedWorkerStatus

export const layer = (options: {
  readonly claimMillis: number
  readonly fallbackIntervalMillis: number
  readonly concurrency?: number
}) =>
  Layer.effect(
    HostedThreadCommandWorker,
    Effect.gen(function* () {
      const protocol = yield* ThreadProtocolStore
      const crypto = yield* Crypto.Crypto
      const runtime = yield* HostedWorkerRuntime
      const execute = yield* commandApplication(options)
      const worker = yield* runtime.register({
        domain: "command",
        concurrency: options.concurrency ?? 1,
        fallbackIntervalMillis: options.fallbackIntervalMillis,
        scanFailureMessage: "Thread command worker scan failed",
        executionFailureMessage: "Thread command application failed",
        scan: (control) =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt < control.availableCapacity; attempt += 1) {
              const claimToken = yield* crypto.randomUUIDv4
              const command = yield* protocol.claimNextCommand({ claimToken, claimMillis: options.claimMillis })
              if (command === undefined) break
              const started = yield* control.start({
                key: `${command.threadId}:${command.commandId}`,
                runnableAt: DateTime.toEpochMillis(DateTime.makeUnsafe(command.admittedAt)),
                effect: execute(command, claimToken),
              })
              if (!started)
                yield* protocol.releaseCommandClaim({
                  ownerId: command.ownerId,
                  threadId: command.threadId,
                  commandId: command.commandId,
                  claimToken,
                })
            }
            return { oldestRunnableAt: yield* protocol.oldestRunnableCommandAt }
          }),
      })
      return HostedThreadCommandWorker.of({
        status: worker.status,
        ready: worker.ready.pipe(
          Effect.mapError((error) => HostedThreadCommandWorkerError.make({ message: error.message })),
        ),
      })
    }),
  )
