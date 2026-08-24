import * as GitHub from "./model"
import * as GitHubInstallation from "./installation/service"
import { Context, Effect, Layer, Redacted, Schema } from "effect"

export const GitHubLoginIdentity = Schema.Struct({
  userId: GitHub.PositiveInt,
  login: Schema.NonEmptyString,
})
export type GitHubLoginIdentity = typeof GitHubLoginIdentity.Type

export const SetupIntent = Schema.Struct({
  authoritySubject: Schema.NonEmptyString,
  githubIdentity: GitHubLoginIdentity,
  expectedAccount: GitHub.GitHubAccount,
})
export type SetupIntent = typeof SetupIntent.Type

export const UserAuthorizationIntent = Schema.Struct({
  authoritySubject: Schema.NonEmptyString,
  expectedGitHubUserId: Schema.optionalKey(GitHub.PositiveInt),
})
export type UserAuthorizationIntent = typeof UserAuthorizationIntent.Type

export class AuthorizationStateError extends Schema.TaggedError<AuthorizationStateError>()(
  "GitHubAuthorizationStateError",
  {
    reason: Schema.Literals(["unknown", "expired", "replayed", "storage"]),
    flow: Schema.Literals(["setup", "user_authorization"]),
    message: Schema.String,
  },
) {}

export interface AuthorizationStatesService {
  readonly consumeSetup: (state: Redacted.Redacted<string>) => Effect.Effect<SetupIntent, AuthorizationStateError>
  readonly consumeUserAuthorization: (
    state: Redacted.Redacted<string>,
  ) => Effect.Effect<UserAuthorizationIntent, AuthorizationStateError>
}

export class AuthorizationStates extends Context.Service<AuthorizationStates, AuthorizationStatesService>()(
  "@rika/github-app/authorization-state/AuthorizationStates",
) {}

const AuthorizationState = Schema.Redacted(Schema.NonEmptyString, {
  disallowJsonEncode: true,
})

export const SetupCandidate = Schema.Struct({
  state: AuthorizationState,
  installationId: GitHub.PositiveInt,
  authoritySubject: Schema.NonEmptyString,
  githubIdentity: GitHubLoginIdentity,
})
export type SetupCandidate = typeof SetupCandidate.Type

export const UserAuthorizationCandidate = Schema.Struct({
  state: AuthorizationState,
  authoritySubject: Schema.NonEmptyString,
  githubIdentity: GitHubLoginIdentity,
})
export type UserAuthorizationCandidate = typeof UserAuthorizationCandidate.Type

export interface ValidatedSetup {
  readonly authoritySubject: string
  readonly githubIdentity: GitHubLoginIdentity
  readonly installation: GitHub.Installation
}

export interface ValidatedUserAuthorization {
  readonly authoritySubject: string
  readonly githubIdentity: GitHubLoginIdentity
}

export class StateValidationError extends Schema.TaggedError<StateValidationError>()("GitHubStateValidationError", {
  reason: Schema.Literals([
    "candidate",
    "authority_subject",
    "github_identity",
    "installation_account",
    "installation",
  ]),
  flow: Schema.Literals(["setup", "user_authorization"]),
  message: Schema.String,
}) {}

export interface StateValidationService {
  readonly validateSetup: (
    candidate: SetupCandidate,
  ) => Effect.Effect<ValidatedSetup, AuthorizationStateError | StateValidationError>
  readonly validateUserAuthorization: (
    candidate: UserAuthorizationCandidate,
  ) => Effect.Effect<ValidatedUserAuthorization, AuthorizationStateError | StateValidationError>
}

export class StateValidation extends Context.Service<StateValidation, StateValidationService>()(
  "@rika/github-app/authorization-state/StateValidation",
) {}

const mismatch = (reason: StateValidationError["reason"], flow: StateValidationError["flow"], message: string) =>
  StateValidationError.make({ reason, flow, message })

const sameIdentity = (left: GitHubLoginIdentity, right: GitHubLoginIdentity) =>
  left.userId === right.userId && left.login.toLowerCase() === right.login.toLowerCase()

export const stateValidationLayer = Layer.effect(
  StateValidation,
  Effect.gen(function* () {
    const states = yield* AuthorizationStates
    const installations = yield* GitHubInstallation.Installation
    const validateSetup = Effect.fn("GitHubStateValidation.validateSetup")(function* (
      untrustedCandidate: SetupCandidate,
    ) {
      const candidate = yield* Schema.decodeEffect(SetupCandidate)(untrustedCandidate).pipe(
        Effect.mapError(() => mismatch("candidate", "setup", "GitHub setup candidate is invalid")),
      )
      const intent = yield* states.consumeSetup(candidate.state)
      if (intent.authoritySubject !== candidate.authoritySubject) {
        return yield* mismatch("authority_subject", "setup", "Setup state belongs to another authority subject")
      }
      if (!sameIdentity(intent.githubIdentity, candidate.githubIdentity)) {
        return yield* mismatch("github_identity", "setup", "Setup state belongs to another GitHub login")
      }
      const installation = yield* installations
        .verifyInstallation(candidate.installationId)
        .pipe(Effect.mapError(() => mismatch("installation", "setup", "GitHub installation verification failed")))
      if (!GitHub.sameAccount(installation.account, intent.expectedAccount)) {
        return yield* mismatch("installation_account", "setup", "GitHub installation account did not match setup state")
      }
      return {
        authoritySubject: intent.authoritySubject,
        githubIdentity: intent.githubIdentity,
        installation,
      }
    })
    const validateUserAuthorization = Effect.fn("GitHubStateValidation.validateUserAuthorization")(function* (
      untrustedCandidate: UserAuthorizationCandidate,
    ) {
      const candidate = yield* Schema.decodeEffect(UserAuthorizationCandidate)(untrustedCandidate).pipe(
        Effect.mapError(() => mismatch("candidate", "user_authorization", "GitHub authorization candidate is invalid")),
      )
      const intent = yield* states.consumeUserAuthorization(candidate.state)
      if (intent.authoritySubject !== candidate.authoritySubject) {
        return yield* mismatch(
          "authority_subject",
          "user_authorization",
          "Authorization state belongs to another authority subject",
        )
      }
      if (
        intent.expectedGitHubUserId !== undefined &&
        intent.expectedGitHubUserId !== candidate.githubIdentity.userId
      ) {
        return yield* mismatch(
          "github_identity",
          "user_authorization",
          "Authorization state belongs to another GitHub login",
        )
      }
      return { authoritySubject: intent.authoritySubject, githubIdentity: candidate.githubIdentity }
    })
    return StateValidation.of({ validateSetup, validateUserAuthorization })
  }),
)

export const authorizationStatesTestLayer = (service: AuthorizationStatesService) =>
  Layer.succeed(AuthorizationStates, AuthorizationStates.of(service))
