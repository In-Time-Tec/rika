import { expect, it } from "@effect/vitest"
import * as Settings from "@rika/configuration/configuration-settings"
import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import type { ProviderCredentialStoreService } from "@rika/product/provider-credential-store"
import { Effect, Exit, Layer, Option, Redacted, Ref } from "effect"
import * as Models from "../src/models"

const routeFor = (alias: "luna" | "fable", provider: "openai" | "anthropic", identity: string) =>
  ExecutionRouteResolution.resolve(
    {
      ...Settings.Defaults.settingsDefaults,
      providers: {
        ...Settings.Defaults.settingsDefaults.providers,
        [provider]: {
          ...Settings.Defaults.settingsDefaults.providers[provider],
          credentialIdentity: identity,
        },
      },
      modes: {
        ...Settings.Defaults.settingsDefaults.modes,
        medium: {
          main: { alias, effort: "medium" },
          oracle: { alias, effort: "medium" },
          agents: {},
        },
      },
      threadTitle: { alias, effort: "medium" },
      compaction: { summaryModel: { alias, effort: "medium" } },
    },
    "medium",
  ).main.candidates[0]!

it.effect("loads owner-bound credentials for OpenAI and Anthropic models and fails closed when absent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const loaded = yield* Ref.make<ReadonlyArray<string>>([])
      const store: ProviderCredentialStoreService = {
        load: (identity) =>
          Ref.update(loaded, (current) => [...current, identity]).pipe(
            Effect.as(Option.some(Redacted.make(`secret-for-${identity}`))),
          ),
        save: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
      }
      yield* Layer.build(
        Models.layer({ candidate: routeFor("luna", "openai", "owner-openai"), credentialStore: store }),
      )
      yield* Layer.build(
        Models.layer({ candidate: routeFor("fable", "anthropic", "owner-anthropic"), credentialStore: store }),
      )
      expect(yield* Ref.get(loaded)).toEqual(["owner-openai", "owner-anthropic"])
      const missing = yield* Effect.exit(
        Layer.build(
          Models.layer({
            candidate: routeFor("luna", "openai", "missing-openai"),
            credentialStore: { ...store, load: () => Effect.succeed(Option.none()) },
          }),
        ),
      )
      expect(Exit.isFailure(missing)).toBe(true)
    }),
  ),
)
