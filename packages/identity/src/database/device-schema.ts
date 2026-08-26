import { sql } from "drizzle-orm"
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import type { CliDeviceRegistration } from "../device/directory"

export const cliRegistration = pgTable("rika_cli_registration", {
  clientId: text("client_id").primaryKey(),
  deviceId: uuid("device_id").notNull(),
  publicJwk: jsonb("public_jwk").$type<CliDeviceRegistration["publicJwk"]>().notNull(),
  jwkThumbprint: text("jwk_thumbprint").notNull(),
  userId: text("user_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`transaction_timestamp()`)
    .notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
})

export const oauthClient = pgTable("oauth_client", {
  id: text().primaryKey(),
  clientId: text("client_id").notNull(),
  userId: text("user_id"),
  redirectUris: jsonb("redirect_uris").$type<ReadonlyArray<string>>().notNull(),
  createdAt: timestamp("created_at"),
})

const oauthGrantColumns = {
  clientId: text("client_id").notNull(),
  userId: text("user_id"),
  revoked: timestamp(),
}

export const oauthAccessToken = pgTable("oauth_access_token", oauthGrantColumns)

export const oauthRefreshToken = pgTable("oauth_refresh_token", {
  ...oauthGrantColumns,
  userId: text("user_id").notNull(),
})
