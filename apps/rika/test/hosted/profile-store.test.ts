import * as BunServices from "@effect/platform-bun/BunServices"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { expect, it } from "@effect/vitest"
import { ProfileStore, type Profile } from "../../src/hosted/contract"
import { layer } from "../../src/hosted/profile-store"

it.effect("persists the current owner format and rejects stale profiles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bunContext = yield* Layer.build(BunServices.layer)
      const fileSystem = Context.get(bunContext, FileSystem.FileSystem)
      const home = yield* fileSystem.makeTempDirectoryScoped()
      const filename = `${home}/hosted.json`
      const context = yield* Layer.build(layer({ home, filename }).pipe(Layer.provide(BunServices.layer)))
      const store = Context.get(context, ProfileStore)
      const profile: Profile = {
        origin: "https://hosted.example.test",
        deviceId: "device-1",
        clientId: "client-1",
        owner: { kind: "organization", organizationId: "org-1" },
        project: "project-1",
      }
      yield* store.save(profile)
      expect(Option.getOrThrow(yield* store.load)).toEqual(profile)
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* fileSystem.readFileString(filename)),
      ).toEqual({
        formatVersion: 3,
        origin: profile.origin,
        deviceId: profile.deviceId,
        clientId: profile.clientId,
        owner: { kind: "organization", organizationId: "org-1" },
        project: "project-1",
      })
      yield* fileSystem.writeFileString(
        filename,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          formatVersion: 2,
          origin: profile.origin,
          deviceId: profile.deviceId,
          clientId: profile.clientId,
        }),
      )
      expect((yield* Effect.flip(store.load)).message).toBe("Hosted profile is corrupt")
    }),
  ),
)
