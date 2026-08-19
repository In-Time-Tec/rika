export interface IdentityMigration {
  readonly id: string
  readonly url: URL
}

export const identityMigrations: ReadonlyArray<IdentityMigration> = [
  {
    id: "0001_better_auth_1_7_1",
    url: new URL("../migrations/0001_better_auth_1_7_1.sql", import.meta.url),
  },
]
