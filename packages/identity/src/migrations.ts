export interface IdentityMigration {
  readonly id: string
  readonly url: URL
  readonly checksum: string
}

export const identityMigrations: ReadonlyArray<IdentityMigration> = [
  {
    id: "identity/0001_better_auth_1_7_1",
    checksum: "c07ac178826ea802f00c94f35fbc9b1fad12bbf5efa9a53500f4dc203446df38",
    url: new URL("../migrations/0001_better_auth_1_7_1.sql", import.meta.url),
  },
  {
    id: "identity/0002_cli_devices",
    checksum: "594c5e7c4bfe49c06ecf0305993e4b53886363ff3619a3da61bf43df9fdeccef",
    url: new URL("../migrations/0002_cli_devices.sql", import.meta.url),
  },
  {
    id: "identity/0003_better_auth_postgres_contract",
    checksum: "b4a8657e50c0fae5bb58c3be0617853a308130f095d8a7e2f587282bacc592bb",
    url: new URL("../migrations/0003_better_auth_postgres_contract.sql", import.meta.url),
  },
]
