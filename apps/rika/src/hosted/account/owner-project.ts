import { Console, Effect, Redacted, Schema } from "effect"
import type { EnvironmentPhase, EnvironmentScope } from "@rika/product/environment-policy"
import { Http, ProfileStore, type IdentityContext, type Profile } from "../contract"
import { authenticated, selectedProfile } from "./session"
import { accountSupport } from "./support"

const { failure } = accountSupport

const emailSchema = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))

const projectBelongsToOwner = (profile: Profile, project: IdentityContext["projects"][number]) =>
  profile.owner.kind === "personal"
    ? project.owner.kind === "personal"
    : project.owner.kind === "organization" && project.owner.organizationId === profile.owner.organizationId

const defaultSecretScope = (profile: Profile): EnvironmentScope => {
  if (profile.project !== undefined) return "project"
  if (profile.owner.kind === "organization") return "organization"
  return "personal"
}
export const listOrganizations = Effect.fn("HostedAccount.listOrganizations")(function* () {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const identity = yield* authenticated(profile, (session) => http.context(profile.origin, session))
  yield* Console.log(`${profile.owner.kind === "personal" ? "*" : " "} Personal`)
  for (const organization of identity.organizations)
    yield* Console.log(
      `${profile.owner.kind === "organization" && profile.owner.organizationId === organization.id ? "*" : " "} ${organization.name} (${organization.slug})`,
    )
})

export const usePersonalOwner = Effect.fn("HostedAccount.usePersonalOwner")(function* () {
  const profile = yield* selectedProfile()
  const profiles = yield* ProfileStore
  yield* profiles.save({ ...profile, owner: { kind: "personal" }, project: undefined })
  yield* Console.log("Using Personal")
})

export const useOrganization = Effect.fn("HostedAccount.useOrganization")(function* (requested: string) {
  const profile = yield* selectedProfile()
  const profiles = yield* ProfileStore
  const http = yield* Http
  const identity = yield* authenticated(profile, (session) => http.context(profile.origin, session))
  const matches = identity.organizations.filter(
    (organization) =>
      organization.id === requested || organization.slug === requested || organization.name === requested,
  )
  if (matches.length !== 1)
    return yield* failure(
      "invalid-input",
      matches.length === 0 ? `Organization ${requested} was not found` : `Organization ${requested} is ambiguous`,
    )
  yield* profiles.save({
    ...profile,
    owner: { kind: "organization", organizationId: matches[0]!.id },
    project: undefined,
  })
  yield* Console.log(`Using organization ${matches[0]!.name}`)
})

export const invite = Effect.fn("HostedAccount.invite")(function* (rawEmail: string) {
  const email = yield* Schema.decodeEffect(emailSchema)(rawEmail).pipe(
    Effect.mapError(() => failure("invalid-input", "Invitation email is invalid")),
  )
  const profile = yield* selectedProfile()
  if (profile.owner.kind !== "organization") return yield* failure("invalid-input", "Run rika org use first")
  const organizationId = profile.owner.organizationId
  const http = yield* Http
  const invitation = yield* authenticated(profile, (session) =>
    http.invite(profile.origin, organizationId, email, session),
  )
  yield* Console.log(`Invited ${invitation.email}`)
})

export const listProjects = Effect.fn("HostedAccount.listProjects")(function* () {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const identity = yield* authenticated(profile, (session) => http.context(profile.origin, session))
  const projects = identity.projects.filter((project) => projectBelongsToOwner(profile, project))
  if (projects.length === 0) {
    yield* Console.log("No Projects")
    return
  }
  for (const project of projects)
    yield* Console.log(`${profile.project === project.id ? "*" : " "} ${project.name} (${project.id})`)
})

export const createProject = Effect.fn("HostedAccount.createProject")(function* (name: string) {
  const profile = yield* selectedProfile()
  const profiles = yield* ProfileStore
  const http = yield* Http
  const project = yield* authenticated(profile, (session) =>
    http.createProject(profile.origin, profile.owner, name, session),
  )
  yield* profiles.save({ ...profile, project: project.id })
  yield* Console.log(`Created and selected Project ${project.name} (${project.id})`)
})

export const useProject = Effect.fn("HostedAccount.useProject")(function* (requested: string) {
  const profile = yield* selectedProfile()
  const profiles = yield* ProfileStore
  const http = yield* Http
  const identity = yield* authenticated(profile, (session) => http.context(profile.origin, session))
  const matches = identity.projects.filter(
    (project) =>
      projectBelongsToOwner(profile, project) &&
      (project.id === requested || project.slug === requested || project.name === requested),
  )
  if (matches.length !== 1)
    return yield* failure(
      "invalid-input",
      matches.length === 0 ? `Project ${requested} was not found` : `Project ${requested} is ambiguous`,
    )
  yield* profiles.save({ ...profile, project: matches[0]!.id })
  yield* Console.log(`Using Project ${matches[0]!.name}`)
})

export const putSecret = Effect.fn("HostedAccount.putSecret")(function* (
  name: string,
  value: string,
  scope: EnvironmentScope | undefined,
  phases: ReadonlyArray<EnvironmentPhase>,
) {
  const profile = yield* selectedProfile()
  const selectedScope = scope ?? defaultSecretScope(profile)
  if (selectedScope === "project" && profile.project === undefined)
    return yield* failure("invalid-input", "Select a Project before setting a Project secret")
  const http = yield* Http
  const result = yield* authenticated(profile, (session) =>
    http.putEnvironment(
      profile.origin,
      profile.owner,
      profile.project,
      name,
      selectedScope,
      phases,
      Redacted.make(value),
      session,
    ),
  )
  yield* Console.log(`${result.name} secret is ${result.state} at revision ${result.revision}`)
})

export const revokeSecret = Effect.fn("HostedAccount.revokeSecret")(function* (
  name: string,
  scope: EnvironmentScope | undefined,
) {
  const profile = yield* selectedProfile()
  const selectedScope = scope ?? defaultSecretScope(profile)
  if (selectedScope === "project" && profile.project === undefined)
    return yield* failure("invalid-input", "Select a Project before revoking a Project secret")
  const http = yield* Http
  const result = yield* authenticated(profile, (session) =>
    http.revokeEnvironment(profile.origin, profile.owner, profile.project, name, selectedScope, session),
  )
  yield* Console.log(`${result.name} secret is ${result.state} at revision ${result.revision}`)
})
