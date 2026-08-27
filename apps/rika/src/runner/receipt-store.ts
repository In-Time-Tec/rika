import {
  ForegroundRunnerError,
  ForegroundRunnerSnapshot,
  type ForegroundRunnerReceiptStore,
} from "@rika/remote-execution/foreground"
import { Effect, FileSystem, Option, Schema } from "effect"

const SnapshotDisk = Schema.Struct({ formatVersion: Schema.Literal(1), snapshot: ForegroundRunnerSnapshot })
const failure = (message: string) => ForegroundRunnerError.make({ message })

export const makeRunnerReceiptStore = Effect.fn("RunnerReceiptStore.make")(function* (options: {
  readonly origin: string
  readonly deviceId: string
  readonly directory: string
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const expectedUid = process.getuid?.()
  let writeSequence = 0
  const prefix = `${encodeURIComponent(new URL(options.origin).origin)}-${encodeURIComponent(options.deviceId)}`
  const filename = (scope: string) => `${options.directory}/${prefix}-${encodeURIComponent(scope)}.json`
  const unavailable = () => failure("Runner recovery storage is unavailable")
  const directoryReady = Effect.fn("RunnerReceiptStore.directoryReady")(function* (create: boolean) {
    const exists = yield* fileSystem.exists(options.directory).pipe(Effect.mapError(unavailable))
    if (!exists) {
      if (!create) return false
      yield* fileSystem
        .makeDirectory(options.directory, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(unavailable))
    }
    if ((yield* Effect.result(fileSystem.readLink(options.directory)))._tag === "Success") return yield* unavailable()
    const info = yield* fileSystem.stat(options.directory).pipe(Effect.mapError(unavailable))
    if (info.type !== "Directory" || (expectedUid !== undefined && Option.getOrUndefined(info.uid) !== expectedUid))
      return yield* unavailable()
    if (create && (info.mode & 0o777) !== 0o700)
      yield* fileSystem.chmod(options.directory, 0o700).pipe(Effect.mapError(unavailable))
    else if ((info.mode & 0o777) !== 0o700) return yield* unavailable()
    return true
  })
  const filePresent = Effect.fn("RunnerReceiptStore.filePresent")(function* (target: string) {
    const exists = yield* fileSystem.exists(target).pipe(Effect.mapError(unavailable))
    if (!exists) return false
    if (!(yield* directoryReady(false))) return false
    if ((yield* Effect.result(fileSystem.readLink(target)))._tag === "Success") return yield* unavailable()
    const info = yield* fileSystem.stat(target).pipe(Effect.mapError(unavailable))
    if (
      info.type !== "File" ||
      (expectedUid !== undefined && Option.getOrUndefined(info.uid) !== expectedUid) ||
      (info.mode & 0o777) !== 0o600
    )
      return yield* unavailable()
    return true
  })
  const load = Effect.fn("RunnerReceiptStore.load")(function* (scope: string) {
    const target = filename(scope)
    if (!(yield* filePresent(target))) return Option.none<ForegroundRunnerSnapshot>()
    const stored = yield* fileSystem.readFileString(target).pipe(Effect.mapError(unavailable))
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(SnapshotDisk))(stored).pipe(
      Effect.mapError(() => failure("Runner recovery state is corrupt")),
    )
    return Option.some(decoded.snapshot)
  })
  const save: ForegroundRunnerReceiptStore["save"] = (scope, snapshot) =>
    Effect.gen(function* () {
      const value = yield* Schema.encodeEffect(Schema.fromJsonString(SnapshotDisk))({
        formatVersion: 1,
        snapshot,
      }).pipe(Effect.mapError(() => failure("Runner recovery state could not be encoded")))
      yield* directoryReady(true)
      writeSequence += 1
      const target = filename(scope)
      yield* filePresent(target)
      const temporary = `${target}.tmp-${process.pid}-${writeSequence}`
      yield* fileSystem
        .writeFileString(temporary, value, { flag: "wx", mode: 0o600 })
        .pipe(
          Effect.andThen(fileSystem.chmod(temporary, 0o600)),
          Effect.andThen(fileSystem.rename(temporary, target)),
          Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
          Effect.mapError(unavailable),
        )
    })
  const remove = (scope: string) => {
    const target = filename(scope)
    return filePresent(target).pipe(
      Effect.flatMap((present) => (present ? fileSystem.remove(target) : Effect.void)),
      Effect.mapError(unavailable),
    )
  }
  return { load, save, remove }
})
