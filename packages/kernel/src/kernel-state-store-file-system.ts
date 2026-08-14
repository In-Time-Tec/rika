import { KernelStateStore } from "@batonfx/repl"
import type { Cell } from "@batonfx/repl"
import { Effect, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect"

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(KernelStateStore.Manifest))
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(KernelStateStore.Manifest))

const unavailable = (
  sessionId: string,
  reason: "missing" | "corrupt" | "io",
  message: string,
): KernelStateStore.KernelStateUnavailable =>
  KernelStateStore.KernelStateUnavailable.make({ sessionId, reason, message })

const isNotFound = (error: PlatformError.PlatformError): boolean => error.reason._tag === "NotFound"

const safeName = (sessionId: string): string => encodeURIComponent(sessionId)

/**
 * Best-effort namespace persistence under the profile data root, keyed by Session.
 *
 * This is never durable authority: Baton operations, events, Session entries, and children remain
 * the only truth, so a missing snapshot is simply absent and a corrupt one is a typed, non-fatal
 * report rather than a failure of the cell. Files are owner-only and land through a same-directory
 * temporary plus rename, so a reader never observes a half-written payload.
 */
export const make = (
  dataRoot: string,
): Effect.Effect<KernelStateStore.Interface, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = path.join(dataRoot, "kernel-state")
    const payloadFile = (sessionId: Cell.SessionId) => path.join(directory, `${safeName(sessionId)}.payload`)
    const manifestFile = (sessionId: Cell.SessionId) => path.join(directory, `${safeName(sessionId)}.manifest.json`)

    const writeAtomic = (
      sessionId: Cell.SessionId,
      file: string,
      write: (temporary: string) => Effect.Effect<void, PlatformError.PlatformError>,
    ): Effect.Effect<void, KernelStateStore.KernelStateUnavailable> =>
      Effect.gen(function* () {
        const temporary = `${file}.tmp`
        yield* write(temporary)
        yield* fileSystem.rename(temporary, file)
      }).pipe(
        Effect.mapError((error) =>
          unavailable(sessionId, "io", `kernel state is unwritable at ${file}: ${error.message}`),
        ),
      )

    const readManifest = (
      sessionId: Cell.SessionId,
    ): Effect.Effect<Option.Option<KernelStateStore.Manifest>, KernelStateStore.KernelStateUnavailable> =>
      fileSystem.readFileString(manifestFile(sessionId)).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            isNotFound(error)
              ? Effect.succeedNone
              : Effect.fail(unavailable(sessionId, "io", `kernel state manifest is unreadable: ${error.message}`)),
          onSuccess: (text) =>
            decodeManifest(text).pipe(
              Effect.mapError(() => unavailable(sessionId, "corrupt", "kernel state manifest is not readable")),
              Effect.map(Option.some),
            ),
        }),
      )

    return {
      load: (sessionId) =>
        Effect.gen(function* () {
          const manifest = yield* readManifest(sessionId)
          if (Option.isNone(manifest)) return undefined
          const payload = yield* fileSystem
            .readFile(payloadFile(sessionId))
            .pipe(Effect.mapError(() => unavailable(sessionId, "corrupt", "kernel state payload is unreadable")))
          return { manifest: manifest.value, payload }
        }),
      save: (snapshot) =>
        Effect.gen(function* () {
          const sessionId = snapshot.manifest.sessionId
          yield* fileSystem
            .makeDirectory(directory, { recursive: true, mode: DIRECTORY_MODE })
            .pipe(
              Effect.mapError((error) =>
                unavailable(sessionId, "io", `kernel state root is unwritable: ${error.message}`),
              ),
            )
          const manifestText = yield* encodeManifest(snapshot.manifest).pipe(
            Effect.mapError(() => unavailable(sessionId, "corrupt", "kernel state manifest cannot be encoded")),
          )
          yield* writeAtomic(sessionId, payloadFile(sessionId), (temporary) =>
            fileSystem.writeFile(temporary, snapshot.payload, { mode: FILE_MODE }),
          )
          yield* writeAtomic(sessionId, manifestFile(sessionId), (temporary) =>
            fileSystem.writeFileString(temporary, manifestText, { mode: FILE_MODE }),
          )
        }),
      drop: (sessionId) =>
        Effect.all(
          [
            fileSystem.remove(payloadFile(sessionId), { force: true }),
            fileSystem.remove(manifestFile(sessionId), { force: true }),
          ],
          { discard: true },
        ).pipe(
          Effect.mapError((error) => unavailable(sessionId, "io", `kernel state cannot be dropped: ${error.message}`)),
        ),
    }
  })

export const layer = (
  dataRoot: string,
): Layer.Layer<KernelStateStore.KernelStateStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(KernelStateStore.KernelStateStore, make(dataRoot))
