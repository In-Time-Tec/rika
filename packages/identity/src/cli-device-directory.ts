import { Effect, Schema } from "effect"
import type { Pool } from "pg"
import type { IdentityPrincipal } from "./better-auth-runtime"

export const CliDeviceRegistration = Schema.Struct({
  clientId: Schema.NonEmptyString,
  deviceId: Schema.NonEmptyString,
  publicJwk: Schema.Struct({
    kty: Schema.Literal("EC"),
    crv: Schema.Literal("P-256"),
    x: Schema.NonEmptyString,
    y: Schema.NonEmptyString,
  }),
  jwkThumbprint: Schema.NonEmptyString,
})
export type CliDeviceRegistration = typeof CliDeviceRegistration.Type

export interface CliDevice {
  readonly id: string
  readonly name?: string
  readonly current: boolean
  readonly lastSeenAt?: string
}

export class CliDeviceDirectoryError extends Schema.TaggedError<CliDeviceDirectoryError>()("CliDeviceDirectoryError", {
  operation: Schema.String,
}) {}

export interface CliDeviceDirectory {
  readonly register: (input: CliDeviceRegistration) => Effect.Effect<void, CliDeviceDirectoryError>
  readonly discard: (clientId: string) => Effect.Effect<void, CliDeviceDirectoryError>
  readonly authenticate: (principal: IdentityPrincipal) => Effect.Effect<string | undefined, CliDeviceDirectoryError>
  readonly list: (principal: IdentityPrincipal) => Effect.Effect<ReadonlyArray<CliDevice>, CliDeviceDirectoryError>
  readonly revoke: (principal: IdentityPrincipal, deviceId: string) => Effect.Effect<boolean, CliDeviceDirectoryError>
  readonly revokeAll: (principal: IdentityPrincipal) => Effect.Effect<void, CliDeviceDirectoryError>
}

const failure = (operation: string) => CliDeviceDirectoryError.make({ operation })

export const makePostgresCliDeviceDirectory = (pool: Pool): CliDeviceDirectory => {
  const query = <A>(operation: string, text: string, values: ReadonlyArray<unknown> = []) =>
    Effect.tryPromise({
      try: () => pool.query(text, [...values]).then((result) => result.rows as ReadonlyArray<A>),
      catch: () => failure(operation),
    })

  const authenticate = Effect.fn("CliDeviceDirectory.authenticate")(function* (principal: IdentityPrincipal) {
    if (principal.clientId === undefined || principal.dpopJkt === undefined) return undefined
    const rows = yield* query<{ readonly device_id: string }>(
      "authenticate CLI device",
      `update rika_cli_registration
       set user_id = coalesce(user_id, $1), last_seen_at = transaction_timestamp()
       where client_id = $2
         and jwk_thumbprint = $3
         and revoked_at is null
         and (user_id is null or user_id = $1)
       returning device_id::text`,
      [principal.userId, principal.clientId, principal.dpopJkt],
    )
    return rows[0]?.device_id
  })

  return {
    register: Effect.fn("CliDeviceDirectory.register")(function* (input) {
      const rows = yield* query<{ readonly client_id: string }>(
        "register CLI device",
        `insert into rika_cli_registration (client_id, device_id, public_jwk, jwk_thumbprint)
         values ($1, $2::uuid, $3::jsonb, $4)
         on conflict (client_id) do update set
           public_jwk = excluded.public_jwk,
           jwk_thumbprint = excluded.jwk_thumbprint
         where rika_cli_registration.device_id = excluded.device_id
           and rika_cli_registration.user_id is null
           and rika_cli_registration.revoked_at is null
         returning client_id`,
        [input.clientId, input.deviceId, input.publicJwk, input.jwkThumbprint],
      )
      if (rows[0] === undefined) return yield* failure("register CLI device")
    }),
    discard: (clientId) =>
      query("discard CLI registration", "delete from oauth_client where client_id = $1", [clientId]).pipe(
        Effect.asVoid,
      ),
    authenticate,
    list: Effect.fn("CliDeviceDirectory.list")(function* (principal) {
      const current = yield* authenticate(principal)
      const rows = yield* query<{
        readonly id: string
        readonly current: boolean
        readonly lastSeenAt: Date | null
      }>(
        "list CLI devices",
        `select device_id::text as id,
          device_id::text = $2 as current,
          last_seen_at as "lastSeenAt"
         from rika_cli_registration
         where user_id = $1 and revoked_at is null
         order by last_seen_at desc nulls last, created_at desc`,
        [principal.userId, current ?? ""],
      )
      return rows.map((row) => ({
        id: row.id,
        current: row.current,
        ...(row.lastSeenAt === null ? {} : { lastSeenAt: row.lastSeenAt.toISOString() }),
      }))
    }),
    revoke: Effect.fn("CliDeviceDirectory.revoke")(function* (principal, deviceId) {
      yield* authenticate(principal)
      const rows = yield* query<{ readonly revoked: boolean }>(
        "revoke CLI device",
        `with revoked_client as (
           update rika_cli_registration
           set revoked_at = transaction_timestamp()
           where user_id = $1 and device_id = $2::uuid and revoked_at is null
           returning client_id
         ), revoked_access as (
           update oauth_access_token token
           set revoked = transaction_timestamp()
           from revoked_client client
           where token.client_id = client.client_id and token.user_id = $1 and token.revoked is null
         ), revoked_refresh as (
           update oauth_refresh_token token
           set revoked = transaction_timestamp()
           from revoked_client client
           where token.client_id = client.client_id and token.user_id = $1 and token.revoked is null
         )
         select exists(select 1 from revoked_client) as revoked`,
        [principal.userId, deviceId],
      )
      return rows[0]?.revoked ?? false
    }),
    revokeAll: Effect.fn("CliDeviceDirectory.revokeAll")(function* (principal) {
      yield* authenticate(principal)
      yield* query(
        "revoke all CLI devices",
        `with revoked_clients as (
           update rika_cli_registration
           set revoked_at = transaction_timestamp()
           where user_id = $1 and revoked_at is null
           returning client_id
         ), revoked_access as (
           update oauth_access_token token
           set revoked = transaction_timestamp()
           from revoked_clients client
           where token.client_id = client.client_id and token.user_id = $1 and token.revoked is null
         )
         update oauth_refresh_token token
         set revoked = transaction_timestamp()
         from revoked_clients client
         where token.client_id = client.client_id and token.user_id = $1 and token.revoked is null`,
        [principal.userId],
      )
    }),
  }
}
