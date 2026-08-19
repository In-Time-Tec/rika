export interface IdentityMigration {
  readonly id: string
  readonly url: URL
}

export const identityMigrations: ReadonlyArray<IdentityMigration> = [
  {
    id: "identity/0001_better_auth_1_7_1",
    url: new URL("../migrations/0001_better_auth_1_7_1.sql", import.meta.url),
  },
  {
    id: "identity/0002_cli_devices",
    url: new URL("../migrations/0002_cli_devices.sql", import.meta.url),
  },
]
