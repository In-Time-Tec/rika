import { Effect, Schema } from "effect"
import { HostedError, type IdentityContext, type Profile } from "../contract"

const failure = (kind: HostedError["kind"], message: string) => HostedError.make({ kind, message })

const json = <A>(value: A) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.mapError(() => failure("protocol", "Output could not be encoded")),
  )

const validOwner = (profile: Profile, identity: IdentityContext) => {
  if (profile.owner.kind === "personal") return true
  const organizationId = profile.owner.organizationId
  return identity.organizations.some((organization) => organization.id === organizationId)
}

const staleOwner = () =>
  failure(
    "invalid-input",
    "Selected organization is no longer available; run rika org personal or rika org use <organization>",
  )

export const accountSupport = { failure, json, staleOwner, validOwner }
