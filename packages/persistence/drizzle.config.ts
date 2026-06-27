import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.RIKA_DATABASE_URL ?? "../../.rika/rika.sqlite",
  },
  strict: true,
  verbose: true,
})
