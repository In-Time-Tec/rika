import "./account/authenticated.fixture"
import "./account/login.fixture"
import { Effect, Layer, Option, Redacted, Ref } from "effect"
import { TestConsole } from "effect/testing"
import { expect, it } from "@effect/vitest"
import {
  getOpenAiAccount,
  listOrganizations,
  putOpenAiAccount,
  revokeOpenAiAccount,
  useOrganization,
  usePersonalOwner,
} from "../../src/hosted/account"
import { CredentialStore, Http, ProfileStore, type Profile } from "../../src/hosted/contract"
import { key, profile, unusedHttp } from "./account/fixture"

it.effect("stores, reads, and revokes the OpenAI account for the selected hosted owner", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<{ readonly action: string; readonly owner: unknown }>>([])
    const account = {
      accessToken: Redacted.make("oauth-access"),
      idToken: Redacted.make("oauth-id"),
      refreshToken: Redacted.make("oauth-refresh"),
      accountId: Redacted.make("account-id"),
      fingerprint: "fingerprint-1",
      generation: "fingerprint-1.generation-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
      refreshedAt: 0,
    }
    const active = {
      state: "active" as const,
      revision: "1",
      credentialIdentity: "openai-account-1",
      fingerprint: account.fingerprint,
    }
    const context = yield* Layer.build(
      Layer.mergeAll(
        Layer.succeed(
          ProfileStore,
          ProfileStore.of({ load: Effect.succeed(Option.some(profile)), save: () => Effect.void }),
        ),
        Layer.succeed(
          CredentialStore,
          CredentialStore.of({
            load: () =>
              Effect.succeed(
                Option.some({
                  refreshToken: Redacted.make("refresh"),
                  privateJwk: key,
                  accessToken: Redacted.make("access"),
                  accessTokenExpiresAt: 600_000,
                }),
              ),
            save: () => Effect.void,
            remove: () => Effect.succeed(true),
            serialized: (effect) => effect,
          }),
        ),
        Layer.succeed(
          Http,
          Http.of({
            ...unusedHttp,
            refresh: () => Effect.succeed({ accessToken: "access", refreshToken: "refresh", expiresIn: 600 }),
            putOpenAiAccount: (_origin, owner, credential) =>
              Ref.update(calls, (values) => [...values, { action: "put", owner }]).pipe(
                Effect.tap(() => Effect.sync(() => expect(credential).toBe(account))),
                Effect.as(active),
              ),
            getOpenAiAccount: (_origin, owner) =>
              Ref.update(calls, (values) => [...values, { action: "status", owner }]).pipe(Effect.as(active)),
            revokeOpenAiAccount: (_origin, owner) =>
              Ref.update(calls, (values) => [...values, { action: "revoke", owner }]).pipe(
                Effect.as({ ...active, state: "revoked" as const, revision: "2" }),
              ),
          }),
        ),
        TestConsole.layer,
      ),
    )
    yield* putOpenAiAccount(account).pipe(Effect.provide(context))
    yield* getOpenAiAccount().pipe(Effect.provide(context))
    yield* revokeOpenAiAccount().pipe(Effect.provide(context))
    expect(yield* Ref.get(calls)).toEqual([
      { action: "put", owner: profile.owner },
      { action: "status", owner: profile.owner },
      { action: "revoke", owner: profile.owner },
    ])
    expect(yield* TestConsole.logLines.pipe(Effect.provide(context))).toEqual([
      "OpenAI account is active",
      "OpenAI account is active",
      "OpenAI account logged out",
    ])
  }),
)

it.effect("lists Personal, switches owners, clears projects, and returns to Personal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const current = yield* Ref.make<Profile>({ ...profile, owner: { kind: "personal" }, project: "project-1" })
      const context = yield* Layer.build(
        Layer.mergeAll(
          Layer.succeed(
            ProfileStore,
            ProfileStore.of({
              load: Ref.get(current).pipe(Effect.map(Option.some)),
              save: (value) => Ref.set(current, value),
            }),
          ),
          Layer.succeed(
            CredentialStore,
            CredentialStore.of({
              load: () =>
                Effect.succeed(
                  Option.some({
                    refreshToken: Redacted.make("refresh"),
                    privateJwk: key,
                    accessToken: Redacted.make("access"),
                    accessTokenExpiresAt: 600_000,
                  }),
                ),
              save: () => Effect.void,
              remove: () => Effect.succeed(true),
              serialized: (effect) => effect,
            }),
          ),
          Layer.succeed(
            Http,
            Http.of({
              ...unusedHttp,
              refresh: () => Effect.succeed({ accessToken: "access", refreshToken: "refresh", expiresIn: 600 }),
              context: () =>
                Effect.succeed({
                  account: { id: "user-1", email: "dev@example.test", name: "Dev" },
                  organizations: [{ id: "org-1", slug: "engineering", name: "Engineering", logo: null }],
                  projects: [],
                }),
            }),
          ),
          TestConsole.layer,
        ),
      )
      yield* listOrganizations().pipe(Effect.provide(context))
      expect(yield* TestConsole.logLines.pipe(Effect.provide(context))).toEqual([
        "* Personal",
        "  Engineering (engineering)",
      ])
      yield* useOrganization("engineering").pipe(Effect.provide(context))
      expect(yield* Ref.get(current)).toEqual({ ...profile, owner: { kind: "organization", organizationId: "org-1" } })
      yield* usePersonalOwner().pipe(Effect.provide(context))
      expect(yield* Ref.get(current)).toEqual({ ...profile, owner: { kind: "personal" } })
    }),
  ),
)
