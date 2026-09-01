import { Effect, FileSystem, Option, Schema } from "effect"
import type { SessionWire } from "../protocol/messages"
import { SessionWire as SessionWireSchema } from "../protocol/messages"
import { HostError } from "./error"

const directoryMode = 0o700
const fileMode = 0o600
const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionWireSchema))
const encodeSession = Schema.encodeEffect(Schema.fromJsonString(SessionWireSchema))

export interface SessionStore {
  readonly load: Effect.Effect<Option.Option<SessionWire>, HostError>
  readonly save: (session: SessionWire) => Effect.Effect<void, HostError>
}

export const sessionStore = (stateDirectory: string): Effect.Effect<SessionStore, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const filename = `${stateDirectory}/session.json`
    const restrictDirectory = fileSystem.makeDirectory(stateDirectory, { recursive: true, mode: directoryMode }).pipe(
      Effect.andThen(fileSystem.chmod(stateDirectory, directoryMode)),
      Effect.mapError(() => HostError.make({ message: "Could not secure executor session state" })),
    )
    const load = restrictDirectory.pipe(
      Effect.andThen(
        fileSystem
          .exists(filename)
          .pipe(Effect.mapError(() => HostError.make({ message: "Could not inspect executor session state" }))),
      ),
      Effect.flatMap((exists) =>
        exists
          ? fileSystem.chmod(filename, fileMode).pipe(
              Effect.andThen(fileSystem.readFileString(filename)),
              Effect.mapError(() => HostError.make({ message: "Could not read executor session state" })),
              Effect.flatMap((text) =>
                decodeSession(text).pipe(
                  Effect.mapError(() => HostError.make({ message: "Executor session state is invalid" })),
                  Effect.map(Option.some),
                ),
              ),
            )
          : Effect.succeedNone,
      ),
    )
    const save = Effect.fn("Host.sessionStore.save")(function* (session: SessionWire) {
      const temporary = `${filename}.tmp-${process.pid}`
      const text = yield* encodeSession(session).pipe(
        Effect.mapError(() => HostError.make({ message: "Could not encode executor session state" })),
      )
      yield* restrictDirectory
      yield* fileSystem.writeFileString(temporary, text, { mode: fileMode }).pipe(
        Effect.andThen(fileSystem.chmod(temporary, fileMode)),
        Effect.andThen(fileSystem.rename(temporary, filename)),
        Effect.andThen(fileSystem.chmod(filename, fileMode)),
        Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(() => HostError.make({ message: "Could not persist executor session state" })),
      )
    })
    return { load, save } satisfies SessionStore
  })
