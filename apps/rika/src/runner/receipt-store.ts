import {
  ForegroundRunnerError,
  ForegroundRunnerSnapshot,
  type ForegroundRunnerReceiptStore,
} from "@rika/remote-execution/foreground"
import { Effect, Option, Schema } from "effect"
import type { SecretVault } from "../hosted/credential-store"

const service = "com.rika.cli.runner"
const SnapshotDisk = Schema.Struct({ formatVersion: Schema.Literal(1), snapshot: ForegroundRunnerSnapshot })
const liveVault: SecretVault = Bun.secrets
const failure = (message: string) => ForegroundRunnerError.make({ message })

export const makeRunnerReceiptStore = (options: {
  readonly origin: string
  readonly deviceId: string
  readonly vault?: SecretVault
}) => {
  const vault = options.vault ?? liveVault
  const prefix = `${new URL(options.origin).origin}/${options.deviceId}`
  const name = (scope: string) => `${prefix}/${scope}`
  const load = Effect.fn("RunnerReceiptStore.load")(function* (scope: string) {
    const stored = yield* Effect.tryPromise({
      try: () => vault.get({ service, name: name(scope) }),
      catch: () => failure("Runner recovery storage is unavailable"),
    })
    if (stored === null) return Option.none<ForegroundRunnerSnapshot>()
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(SnapshotDisk))(stored).pipe(
      Effect.mapError(() => failure("Runner recovery state is corrupt")),
    )
    return Option.some(decoded.snapshot)
  })
  const save: ForegroundRunnerReceiptStore["save"] = (scope, snapshot) =>
    Schema.encodeEffect(Schema.fromJsonString(SnapshotDisk))({ formatVersion: 1, snapshot }).pipe(
      Effect.mapError(() => failure("Runner recovery state could not be encoded")),
      Effect.flatMap((value) =>
        Effect.tryPromise({
          try: () => vault.set({ service, name: name(scope), value }),
          catch: () => failure("Runner recovery storage is unavailable"),
        }),
      ),
    )
  const remove = (scope: string) =>
    Effect.tryPromise({
      try: () => vault.delete({ service, name: name(scope) }),
      catch: () => failure("Runner recovery storage is unavailable"),
    }).pipe(Effect.asVoid)
  return { load, save, remove }
}
