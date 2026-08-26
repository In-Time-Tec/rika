import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Schema } from "effect"
import type { IdentityPrincipal } from "../auth/runtime"
import { cliRegistration, oauthAccessToken, oauthClient, oauthRefreshToken } from "../database/device-schema"

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

type DeviceDatabase = Pick<PgDrizzle.EffectPgDatabase, "delete" | "insert" | "select" | "transaction" | "update">

const failure = (operation: string) => CliDeviceDirectoryError.make({ operation })
const query = <A extends object, E, R>(operation: string, statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(() => failure(operation)))
const transaction = <A, E, R>(operation: string, statement: Effect.Effect<A, E, R>) =>
  statement.pipe(Effect.mapError(() => failure(operation)))

export const makePostgresCliDeviceDirectory = (db: DeviceDatabase): CliDeviceDirectory => {
  const authenticate = Effect.fn("CliDeviceDirectory.authenticate")(function* (principal: IdentityPrincipal) {
    if (principal.clientId === undefined || principal.dpopJkt === undefined) return undefined
    const rows = yield* query(
      "authenticate CLI device",
      db
        .update(cliRegistration)
        .set({ userId: principal.userId, lastSeenAt: sql`transaction_timestamp()` })
        .where(
          and(
            eq(cliRegistration.clientId, principal.clientId),
            eq(cliRegistration.jwkThumbprint, principal.dpopJkt),
            isNull(cliRegistration.revokedAt),
            or(isNull(cliRegistration.userId), eq(cliRegistration.userId, principal.userId)),
          ),
        )
        .returning({ deviceId: cliRegistration.deviceId }),
    )
    return rows[0]?.deviceId
  })

  return {
    register: Effect.fn("CliDeviceDirectory.register")(function* (input) {
      const rows = yield* query(
        "register CLI device",
        db
          .insert(cliRegistration)
          .values(input)
          .onConflictDoUpdate({
            target: cliRegistration.clientId,
            set: { publicJwk: input.publicJwk, jwkThumbprint: input.jwkThumbprint },
            setWhere: sql`${cliRegistration.deviceId} = ${input.deviceId}
              and ${cliRegistration.userId} is null
              and ${cliRegistration.revokedAt} is null`,
          })
          .returning({ clientId: cliRegistration.clientId }),
      )
      if (rows[0] === undefined) return yield* failure("register CLI device")
    }),
    discard: (clientId) =>
      query(
        "discard CLI registration",
        db.delete(oauthClient).where(eq(oauthClient.clientId, clientId)).returning(),
      ).pipe(Effect.asVoid),
    authenticate,
    list: Effect.fn("CliDeviceDirectory.list")(function* (principal) {
      const current = yield* authenticate(principal)
      const rows = yield* query(
        "list CLI devices",
        db
          .select({ id: cliRegistration.deviceId, lastSeenAt: cliRegistration.lastSeenAt })
          .from(cliRegistration)
          .where(and(eq(cliRegistration.userId, principal.userId), isNull(cliRegistration.revokedAt)))
          .orderBy(desc(cliRegistration.lastSeenAt), desc(cliRegistration.createdAt)),
      )
      return rows.map((row) => {
        const device: CliDevice = { id: row.id, current: row.id === current }
        if (row.lastSeenAt !== null) Object.assign(device, { lastSeenAt: row.lastSeenAt.toISOString() })
        return device
      })
    }),
    revoke: Effect.fn("CliDeviceDirectory.revoke")(function* (principal, deviceId) {
      yield* authenticate(principal)
      return yield* transaction(
        "revoke CLI device",
        db.transaction((tx) =>
          Effect.gen(function* () {
            const clients = yield* tx
              .update(cliRegistration)
              .set({ revokedAt: sql`transaction_timestamp()` })
              .where(
                and(
                  eq(cliRegistration.userId, principal.userId),
                  eq(cliRegistration.deviceId, deviceId),
                  isNull(cliRegistration.revokedAt),
                ),
              )
              .returning({ clientId: cliRegistration.clientId })
            const clientIds = clients.map((row) => row.clientId)
            if (clientIds.length === 0) return false
            yield* tx
              .update(oauthAccessToken)
              .set({ revoked: sql`transaction_timestamp()` })
              .where(
                and(
                  inArray(oauthAccessToken.clientId, clientIds),
                  eq(oauthAccessToken.userId, principal.userId),
                  isNull(oauthAccessToken.revoked),
                ),
              )
            yield* tx
              .update(oauthRefreshToken)
              .set({ revoked: sql`transaction_timestamp()` })
              .where(
                and(
                  inArray(oauthRefreshToken.clientId, clientIds),
                  eq(oauthRefreshToken.userId, principal.userId),
                  isNull(oauthRefreshToken.revoked),
                ),
              )
            return true
          }),
        ),
      )
    }),
    revokeAll: Effect.fn("CliDeviceDirectory.revokeAll")(function* (principal) {
      yield* authenticate(principal)
      yield* transaction(
        "revoke all CLI devices",
        db.transaction((tx) =>
          Effect.gen(function* () {
            const clients = yield* tx
              .update(cliRegistration)
              .set({ revokedAt: sql`transaction_timestamp()` })
              .where(and(eq(cliRegistration.userId, principal.userId), isNull(cliRegistration.revokedAt)))
              .returning({ clientId: cliRegistration.clientId })
            const clientIds = clients.map((row) => row.clientId)
            if (clientIds.length === 0) return
            yield* tx
              .update(oauthAccessToken)
              .set({ revoked: sql`transaction_timestamp()` })
              .where(
                and(
                  inArray(oauthAccessToken.clientId, clientIds),
                  eq(oauthAccessToken.userId, principal.userId),
                  isNull(oauthAccessToken.revoked),
                ),
              )
            yield* tx
              .update(oauthRefreshToken)
              .set({ revoked: sql`transaction_timestamp()` })
              .where(
                and(
                  inArray(oauthRefreshToken.clientId, clientIds),
                  eq(oauthRefreshToken.userId, principal.userId),
                  isNull(oauthRefreshToken.revoked),
                ),
              )
          }),
        ),
      )
    }),
  }
}
