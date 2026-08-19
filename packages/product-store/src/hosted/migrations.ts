export interface Migration {
  readonly id: string
  readonly url: URL
  readonly checksum: string
}

export const migrations: ReadonlyArray<Migration> = [
  {
    id: "product/0001_hosted_authority",
    checksum: "80916a77e51d551de7d674cac2462378e3fd12d22957083970209957ec9e773c",
    url: new URL("../../migrations/postgres/0001-hosted-authority.sql", import.meta.url),
  },
  {
    id: "product/0002_hosted_identity_ancestry",
    checksum: "403c10eaa96789db75fd3553ec7f7bdfe439f6ae04989cfee7c355f25a7e4f0a",
    url: new URL("../../migrations/postgres/0002-hosted-identity-ancestry.sql", import.meta.url),
  },
  {
    id: "product/0003_hosted_authority_fences",
    checksum: "bc902e5c1c1ebef9eb2da1d00fcf3f8b4f7e8e1391324f5f65eca1eedd7c171a",
    url: new URL("../../migrations/postgres/0003-hosted-authority-fences.sql", import.meta.url),
  },
]
