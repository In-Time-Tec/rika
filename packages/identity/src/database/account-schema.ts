import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const identityUser = pgTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
})

export const identityOrganization = pgTable("organization", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull(),
  logo: text(),
  createdAt: timestamp("created_at").notNull(),
  metadata: text(),
})

export const identityMember = pgTable("member", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text().default("member").notNull(),
  createdAt: timestamp("created_at").notNull(),
})
