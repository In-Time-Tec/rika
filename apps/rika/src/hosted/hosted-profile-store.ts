import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { HostedError, ProfileStore, type Profile } from "./hosted-contract"

const ProfileDisk = Schema.Struct({
  formatVersion: Schema.Literal(3),
  origin: Schema.String,
  deviceId: Schema.String,
  clientId: Schema.String,
  owner: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("personal") }),
    Schema.Struct({ kind: Schema.Literal("organization"), organizationId: Schema.String }),
  ]),
  project: Schema.optionalKey(Schema.String),
})

const failure = (message: string) => HostedError.make({ kind: "storage", message })

export const layer = (options: { readonly home: string; readonly filename?: string | undefined }) =>
  Layer.effect(
    ProfileStore,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = options.filename ?? path.join(options.home, ".config", "rika", "hosted.json")
      const load = Effect.gen(function* () {
        if (
          !(yield* fileSystem.exists(target).pipe(Effect.mapError(() => failure("Hosted profile could not be read"))))
        )
          return Option.none<Profile>()
        const text = yield* fileSystem
          .readFileString(target)
          .pipe(Effect.mapError(() => failure("Hosted profile could not be read")))
        const profile = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProfileDisk))(text).pipe(
          Effect.mapError(() => failure("Hosted profile is corrupt")),
        )
        return Option.some({
          origin: profile.origin,
          deviceId: profile.deviceId,
          clientId: profile.clientId,
          owner: profile.owner,
          ...(profile.project === undefined ? {} : { project: profile.project }),
        })
      })
      const save = Effect.fn("HostedProfileStore.save")(function* (profile: Profile) {
        const text = yield* Schema.encodeEffect(Schema.fromJsonString(ProfileDisk))({
          formatVersion: 3,
          origin: profile.origin,
          deviceId: profile.deviceId,
          clientId: profile.clientId,
          owner: profile.owner,
          ...(profile.project === undefined ? {} : { project: profile.project }),
        }).pipe(Effect.mapError(() => failure("Hosted profile could not be encoded")))
        const parent = path.dirname(target)
        const temporary = `${target}.tmp-${process.pid}`
        yield* fileSystem
          .makeDirectory(parent, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError(() => failure("Hosted profile directory could not be created")))
        yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 }).pipe(
          Effect.flatMap(() => fileSystem.rename(temporary, target)),
          Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
          Effect.mapError(() => failure("Hosted profile could not be saved")),
        )
      })
      return ProfileStore.of({ load, save })
    }),
  )
