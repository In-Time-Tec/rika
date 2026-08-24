import { Context, Effect, Function, Layer, Schema } from "effect"
import { BetterAuthMemberId, ExecutorKind, GrantRole } from "../model"

export const AuthorizationAction = Schema.Literals([
  "project:view",
  "project:update",
  "project:grant",
  "thread:view",
  "thread:control",
  "thread:operate",
  "thread:grant",
  "terminal:view",
  "terminal:input",
  "presence:view",
  "presence:update",
  "workspace:file:view",
  "workspace:browser:control",
  "workspace:service:control",
])
export type AuthorizationAction = typeof AuthorizationAction.Type

export const AuthorizationSubject = Schema.Struct({
  memberId: BetterAuthMemberId,
  threadCreatorMemberId: Schema.optionalKey(BetterAuthMemberId),
  executorKind: Schema.optionalKey(ExecutorKind),
  inheritProjectGrants: Schema.optionalKey(Schema.Boolean),
  projectRole: Schema.optionalKey(GrantRole),
  threadRole: Schema.optionalKey(GrantRole),
})
export type AuthorizationSubject = typeof AuthorizationSubject.Type

export class AuthorizationDenied extends Schema.TaggedError<AuthorizationDenied>()("HostedAuthorizationDenied", {
  action: AuthorizationAction,
  memberId: BetterAuthMemberId,
}) {}

const rank: Readonly<Record<GrantRole, number>> = {
  viewer: 1,
  controller: 2,
  operator: 3,
  owner: 4,
}

const required: Readonly<Record<AuthorizationAction, number>> = {
  "project:view": rank.viewer,
  "project:update": rank.operator,
  "project:grant": rank.owner,
  "thread:view": rank.viewer,
  "thread:control": rank.controller,
  "thread:operate": rank.operator,
  "thread:grant": rank.owner,
  "terminal:view": rank.viewer,
  "terminal:input": rank.controller,
  "presence:view": rank.viewer,
  "presence:update": rank.viewer,
  "workspace:file:view": rank.viewer,
  "workspace:browser:control": rank.controller,
  "workspace:service:control": rank.controller,
}

const effectiveThreadRank = (subject: AuthorizationSubject) => {
  if (subject.threadCreatorMemberId === subject.memberId) return rank.owner
  const direct = subject.threadRole === undefined ? 0 : rank[subject.threadRole]
  const inherited =
    subject.executorKind === "orb" && subject.inheritProjectGrants === true && subject.projectRole !== undefined
      ? rank[subject.projectRole]
      : 0
  return Math.max(direct, inherited)
}

export const isAuthorized: {
  (subject: AuthorizationSubject, action: AuthorizationAction): boolean
  (action: AuthorizationAction): (subject: AuthorizationSubject) => boolean
} = Function.dual(2, (subject: AuthorizationSubject, action: AuthorizationAction): boolean => {
  if (!action.startsWith("project:")) return effectiveThreadRank(subject) >= required[action]
  const available = subject.projectRole === undefined ? 0 : rank[subject.projectRole]
  return available >= required[action]
})

export interface AuthorizationService {
  readonly authorize: (
    action: AuthorizationAction,
    subject: AuthorizationSubject,
  ) => Effect.Effect<void, AuthorizationDenied>
}

export class AuthorizationPolicy extends Context.Service<AuthorizationPolicy, AuthorizationService>()(
  "@rika/product/hosted/identity/authorization/AuthorizationPolicy",
) {
  static readonly layer = Layer.succeed(
    AuthorizationPolicy,
    AuthorizationPolicy.of({
      authorize: Effect.fn("AuthorizationPolicy.authorize")(function* (action, subject) {
        if (!isAuthorized(subject, action))
          return yield* AuthorizationDenied.make({ action, memberId: subject.memberId })
      }),
    }),
  )
}
