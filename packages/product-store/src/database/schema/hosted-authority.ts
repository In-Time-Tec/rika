import { rikaHostedPresenceStatus, rikaHostedGrantRole } from "./hosted-enums"
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  foreignKey,
  primaryKey,
  unique,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { SchemaReference } from "../reference"

export const rikaHostedClientAuthorities = pgTable(
  "rika_hosted_client_authorities",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => rikaHostedClients.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.ownerId], name: "rika_hosted_client_authorities_pkey" }),
    index("rika_hosted_client_authorities_active")
      .using(
        "btree",
        table.ownerId.asc().nullsLast(),
        table.expiresAt.asc().nullsLast(),
        table.clientId.asc().nullsLast(),
      )
      .where(sql`(revoked_at IS NULL)`),
    check("rika_hosted_client_authorities_check", sql`(expires_at > issued_at)`),
    check("rika_hosted_client_authorities_check1", sql`(expires_at <= (issued_at + '00:05:00'::interval))`),
  ],
)
export const rikaHostedClients = pgTable(
  "rika_hosted_clients",
  {
    id: text().primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.deviceId, table.userId],
      foreignColumns: [rikaHostedDevices.id, rikaHostedDevices.userId],
      name: "rika_hosted_clients_device_id_user_id_fkey",
    }).onDelete("restrict"),
    index("rika_hosted_clients_active")
      .using("btree", table.userId.asc().nullsLast(), table.expiresAt.asc().nullsLast())
      .where(sql`(revoked_at IS NULL)`),
    unique("rika_hosted_clients_id_user_id_key").on(table.id, table.userId),
    check("rika_hosted_clients_check", sql`(expires_at > authenticated_at)`),
    check("rika_hosted_clients_short_lived", sql`(expires_at <= (authenticated_at + '00:05:00'::interval))`),
  ],
)
export const rikaHostedDevices = pgTable(
  "rika_hosted_devices",
  {
    id: text().primaryKey(),
    userId: text("user_id").notNull(),
    displayName: text("display_name").notNull(),
    publicKeyFingerprint: text("public_key_fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("rika_hosted_devices_id_user_id_key").on(table.id, table.userId),
    unique("rika_hosted_devices_user_id_public_key_fingerprint_key").on(table.userId, table.publicKeyFingerprint),
    check("rika_hosted_devices_display_name_check", sql`(length(display_name) > 0)`),
    check("rika_hosted_devices_public_key_fingerprint_check", sql`(length(public_key_fingerprint) > 0)`),
  ],
)
export const rikaHostedPresence = pgTable(
  "rika_hosted_presence",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    actor: jsonb().notNull(),
    status: rikaHostedPresenceStatus().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.actor], name: "rika_hosted_presence_pkey" }),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [
        SchemaReference.column("rikaHostedThreads", "id"),
        SchemaReference.column("rikaHostedThreads", "ownerId"),
      ],
      name: "rika_hosted_presence_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_presence_expiry").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
      table.expiresAt.asc().nullsLast(),
    ),
    check("rika_hosted_presence_actor_check", sql`(jsonb_typeof(actor) = 'object'::text)`),
    check("rika_hosted_presence_check", sql`(expires_at > last_seen_at)`),
    check("rika_hosted_presence_check1", sql`rika_hosted_actor_matches_owner(actor, owner_id)`),
  ],
)
export const rikaHostedThreadGrants = pgTable(
  "rika_hosted_thread_grants",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => SchemaReference.column("rikaHostedOwners", "id"), { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    membershipId: text("membership_id").notNull(),
    role: rikaHostedGrantRole().notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.membershipId], name: "rika_hosted_thread_grants_pkey" }),
    foreignKey({
      columns: [table.threadId, table.ownerId],
      foreignColumns: [
        SchemaReference.column("rikaHostedThreads", "id"),
        SchemaReference.column("rikaHostedThreads", "ownerId"),
      ],
      name: "rika_hosted_thread_grants_thread_id_owner_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_thread_grants_member").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.membershipId.asc().nullsLast(),
      table.threadId.asc().nullsLast(),
    ),
  ],
)
export const rikaHostedThreadSocketTickets = pgTable(
  "rika_hosted_thread_socket_tickets",
  {
    id: text().primaryKey(),
    ticketDigest: text("ticket_digest").notNull(),
    userId: text("user_id").notNull(),
    clientId: text("client_id").notNull(),
    deviceId: text("device_id").notNull(),
    audience: text().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.clientId, table.userId],
      foreignColumns: [rikaHostedClients.id, rikaHostedClients.userId],
      name: "rika_hosted_thread_socket_tickets_client_id_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.deviceId, table.userId],
      foreignColumns: [rikaHostedDevices.id, rikaHostedDevices.userId],
      name: "rika_hosted_thread_socket_tickets_device_id_user_id_fkey",
    }).onDelete("cascade"),
    index("rika_hosted_thread_socket_tickets_active")
      .using(
        "btree",
        table.ticketDigest.asc().nullsLast(),
        table.audience.asc().nullsLast(),
        table.expiresAt.asc().nullsLast(),
      )
      .where(sql`((consumed_at IS NULL) AND (revoked_at IS NULL))`),
    unique("rika_hosted_thread_socket_tickets_ticket_digest_key").on(table.ticketDigest),
    check("rika_hosted_thread_socket_tickets_audience_check", sql`(length(audience) > 0)`),
    check("rika_hosted_thread_socket_tickets_check", sql`(expires_at > issued_at)`),
    check("rika_hosted_thread_socket_tickets_check1", sql`((consumed_at IS NULL) OR (consumed_at >= issued_at))`),
    check("rika_hosted_thread_socket_tickets_check2", sql`((revoked_at IS NULL) OR (revoked_at >= issued_at))`),
  ],
)

SchemaReference.register("rikaHostedClients", { id: rikaHostedClients.id, userId: rikaHostedClients.userId })
SchemaReference.register("rikaHostedDevices", { id: rikaHostedDevices.id, userId: rikaHostedDevices.userId })
