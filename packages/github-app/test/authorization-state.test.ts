import * as Authorization from "../src/authorization-state"
import * as GitHubInstallation from "../src/installation/service"
import { installation, organization, otherOrganization } from "./support/github.fixture"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import type * as GitHub from "../src/model"
import { provide } from "./support/layer"

const githubIdentity = { userId: 100, login: "octocat" } as const

describe("GitHub authorization state validation", () => {
  it.effect("rejects spoofed setup candidates and binds installation setup to api state", () => {
    const setupStates = new Map<string, Authorization.SetupIntent>([
      [
        "spoofed",
        {
          authoritySubject: "subject-1",
          githubIdentity,
          expectedAccount: organization,
        },
      ],
      [
        "identity-mismatch",
        {
          authoritySubject: "subject-1",
          githubIdentity,
          expectedAccount: organization,
        },
      ],
      [
        "valid",
        {
          authoritySubject: "subject-1",
          githubIdentity,
          expectedAccount: organization,
        },
      ],
    ])
    let installationAccount: GitHub.GitHubAccount = otherOrganization
    let verificationCalls = 0
    const states = Authorization.authorizationStatesTestLayer({
      consumeSetup: (state) => {
        const key = Redacted.value(state)
        const intent = setupStates.get(key)
        setupStates.delete(key)
        return intent === undefined
          ? Effect.fail(
              Authorization.AuthorizationStateError.make({
                reason: "replayed",
                flow: "setup",
                message: "Setup state was already consumed",
              }),
            )
          : Effect.succeed(intent)
      },
      consumeUserAuthorization: () =>
        Effect.fail(
          Authorization.AuthorizationStateError.make({
            reason: "unknown",
            flow: "user_authorization",
            message: "Unknown state",
          }),
        ),
    })
    const installations = GitHubInstallation.installationTestLayer({
      verifyInstallation: () => {
        verificationCalls += 1
        return Effect.succeed({ ...installation, account: installationAccount })
      },
      listRepositories: () => Effect.succeed([]),
      reconcileInstallation: () => Effect.succeed({ installation, repositories: [], reconciledAtMillis: 0 }),
    })
    const layer = Authorization.stateValidationLayer.pipe(Layer.provide(Layer.merge(states, installations)))
    return Effect.gen(function* () {
      const validation = yield* Authorization.StateValidation
      const spoofed = yield* Effect.flip(
        validation.validateSetup({
          state: Redacted.make("spoofed"),
          installationId: 42,
          authoritySubject: "subject-1",
          githubIdentity,
        }),
      )
      expect(spoofed.reason).toBe("installation_account")
      const wrongIdentity = yield* Effect.flip(
        validation.validateSetup({
          state: Redacted.make("identity-mismatch"),
          installationId: 42,
          authoritySubject: "subject-1",
          githubIdentity: { userId: 101, login: "mallory" },
        }),
      )
      expect(wrongIdentity.reason).toBe("github_identity")
      expect(verificationCalls).toBe(1)
      installationAccount = organization
      const validated = yield* validation.validateSetup({
        state: Redacted.make("valid"),
        installationId: 42,
        authoritySubject: "subject-1",
        githubIdentity,
      })
      expect(validated.installation.account).toEqual(organization)
      expect(Object.keys(validated)).toEqual(["authoritySubject", "githubIdentity", "installation"])
    }).pipe(provide(layer))
  })

  it.effect("keeps GitHub login authorization separate from App credentials and rejects state replay", () => {
    let available = true
    const states = Authorization.authorizationStatesTestLayer({
      consumeSetup: () =>
        Effect.fail(
          Authorization.AuthorizationStateError.make({ reason: "unknown", flow: "setup", message: "Unknown state" }),
        ),
      consumeUserAuthorization: () => {
        if (!available) {
          return Effect.fail(
            Authorization.AuthorizationStateError.make({
              reason: "replayed",
              flow: "user_authorization",
              message: "Authorization state was already consumed",
            }),
          )
        }
        available = false
        return Effect.succeed({ authoritySubject: "subject-1", expectedGitHubUserId: 100 })
      },
    })
    const installations = GitHubInstallation.installationTestLayer({
      verifyInstallation: () => Effect.succeed(installation),
      listRepositories: () => Effect.succeed([]),
      reconcileInstallation: () => Effect.succeed({ installation, repositories: [], reconciledAtMillis: 0 }),
    })
    const layer = Authorization.stateValidationLayer.pipe(Layer.provide(Layer.merge(states, installations)))
    const candidate = {
      state: Redacted.make("user-state"),
      authoritySubject: "subject-1",
      githubIdentity,
    }
    return Effect.gen(function* () {
      const validation = yield* Authorization.StateValidation
      const validated = yield* validation.validateUserAuthorization(candidate)
      expect(validated).toEqual({ authoritySubject: "subject-1", githubIdentity })
      expect(validated).not.toHaveProperty("token")
      const replay = yield* Effect.flip(validation.validateUserAuthorization(candidate))
      expect(replay._tag).toBe("GitHubAuthorizationStateError")
      expect(replay.reason).toBe("replayed")
    }).pipe(provide(layer))
  })
})
